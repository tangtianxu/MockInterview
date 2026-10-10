use std::{fs,path::Path,time::Duration};
use rusqlite::{Connection,params};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use tauri::{AppHandle,Manager,command};

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Session {pub id:String,pub mode:String,pub started_at:String,pub ended_at:Option<String>,pub title:String}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry {pub id:String,pub kind:String,pub at:String,pub text:String,#[serde(default)]pub data:Value}
fn schema(db:&Connection)->Result<(),String>{db.execute_batch("PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS history_sessions(id TEXT PRIMARY KEY,mode TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,title TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS history_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,text TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(session_id,id));
 CREATE INDEX IF NOT EXISTS history_by_session ON history_entries(session_id,seq);").map_err(|e|e.to_string())}
fn connect(app:&AppHandle)->Result<Connection,String>{let root=app.path().app_config_dir().map_err(|e|e.to_string())?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;
 let db=Connection::open(root.join("history.sqlite3")).map_err(|e|e.to_string())?;db.busy_timeout(Duration::from_secs(5)).map_err(|e|e.to_string())?;schema(&db)?;Ok(db)}
fn session_id(id:&str)->Result<(),String>{uuid::Uuid::parse_str(id).map(|_|()).map_err(|_|"历史会话 ID 无效".into())}
fn write_entry(db:&Connection,id:&str,entry:&Entry)->Result<(),String>{
 session_id(id)?;
 if entry.id.is_empty()||entry.id.len()>120||!entry.id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_')||!matches!(entry.kind.as_str(),"transcript"|"question"|"answer"|"feedback"|"detail"|"usage")||entry.at.len()>40||entry.text.len()>64*1024{return Err("历史条目格式无效或内容过长".into());}
 let data=serde_json::to_string(&entry.data).map_err(|e|e.to_string())?;if data.len()>64*1024{return Err("历史条目附加内容过长".into());}
 db.execute("INSERT INTO history_entries(session_id,id,kind,at,text,data) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(session_id,id) DO UPDATE SET text=excluded.text,data=excluded.data",params![id,entry.id,entry.kind,entry.at,entry.text,data]).map_err(|e|e.to_string())?;Ok(())
}
#[command]
pub fn history_begin(app:AppHandle,session:Session)->Result<(),String>{session_id(&session.id)?;if !matches!(session.mode.as_str(),"practice"|"live"|"manual")||session.title.len()>500||session.started_at.len()>40{return Err("历史会话格式无效".into());}
 connect(&app)?.execute("INSERT INTO history_sessions(id,mode,started_at,title) VALUES(?1,?2,?3,?4)",params![session.id,session.mode,session.started_at,session.title]).map_err(|e|e.to_string())?;Ok(())}
#[command]
pub fn history_record(app:AppHandle,session_id:String,entry:Entry)->Result<(),String>{write_entry(&connect(&app)?,&session_id,&entry)}
#[command]
pub fn history_end(app:AppHandle,id:String,at:String)->Result<(),String>{session_id(&id)?;connect(&app)?.execute("UPDATE history_sessions SET ended_at=?2 WHERE id=?1",params![id,at]).map_err(|e|e.to_string())?;Ok(())}
#[command]
pub fn history_list(app:AppHandle,query:String,date:String)->Result<Vec<Session>,String>{
 let db=connect(&app)?;let mut stmt=db.prepare("SELECT id,mode,started_at,ended_at,title FROM history_sessions s WHERE (?2='' OR date(started_at,'localtime')=?2) AND (?1='' OR instr(lower(title),lower(?1))>0 OR EXISTS(SELECT 1 FROM history_entries e WHERE e.session_id=s.id AND (instr(lower(e.text),lower(?1))>0 OR instr(lower(e.data),lower(?1))>0))) ORDER BY started_at DESC LIMIT 100").map_err(|e|e.to_string())?;
 let rows=stmt.query_map(params![query.chars().take(200).collect::<String>(),date],|r|Ok(Session{id:r.get(0)?,mode:r.get(1)?,started_at:r.get(2)?,ended_at:r.get(3)?,title:r.get(4)?})).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}
fn read(db:&Connection,id:&str)->Result<Value,String>{session_id(id)?;let session=db.query_row("SELECT id,mode,started_at,ended_at,title FROM history_sessions WHERE id=?1",[id],|r|Ok(Session{id:r.get(0)?,mode:r.get(1)?,started_at:r.get(2)?,ended_at:r.get(3)?,title:r.get(4)?})).map_err(|e|e.to_string())?;
 let mut stmt=db.prepare("SELECT id,kind,at,text,data FROM history_entries WHERE session_id=?1 ORDER BY seq").map_err(|e|e.to_string())?;
 let entries=stmt.query_map([id],|r|{let raw:String=r.get(4)?;Ok(Entry{id:r.get(0)?,kind:r.get(1)?,at:r.get(2)?,text:r.get(3)?,data:serde_json::from_str(&raw).unwrap_or(Value::Null)})}).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;Ok(json!({"session":session,"entries":entries}))}
#[command]
pub fn history_read(app:AppHandle,id:String)->Result<Value,String>{read(&connect(&app)?,&id)}
#[command]
pub fn history_delete(app:AppHandle,id:String)->Result<(),String>{session_id(&id)?;connect(&app)?.execute("DELETE FROM history_sessions WHERE id=?1",[id]).map_err(|e|e.to_string())?;Ok(())}
#[command]
pub fn history_export(app:AppHandle,id:String,path:String)->Result<(),String>{let value=read(&connect(&app)?,&id)?;let target=Path::new(&path);if !target.is_absolute(){return Err("请选择完整的导出路径".into());}
 let content=match target.extension().and_then(|s|s.to_str()).map(str::to_lowercase).as_deref(){Some("json")=>serde_json::to_string_pretty(&value).map_err(|e|e.to_string())?,Some("md")=>{
 let mut text=format!("# {}\n\n开始：{}\n\n",value["session"]["title"].as_str().unwrap_or("历史会话"),value["session"]["startedAt"].as_str().unwrap_or(""));
 for entry in value["entries"].as_array().unwrap(){text.push_str(&format!("## {} · {}\n\n{}\n\n",entry["kind"].as_str().unwrap_or(""),entry["at"].as_str().unwrap_or(""),entry["text"].as_str().unwrap_or("")));if entry["kind"]=="usage"||entry["kind"]=="feedback" {text.push_str(&format!("```json\n{}\n```\n\n",serde_json::to_string_pretty(&entry["data"]).unwrap_or_default()));}}
 text},_=>return Err("请选择 Markdown 或 JSON 文件".into())};fs::write(target,content).map_err(|e|e.to_string())}

pub fn record_usage(app:&AppHandle,id:Option<&str>,stage:&str,model:&str,provider:&str,value:&Value){
 let Some(id)=id else{return};let usage=if provider=="ollama"{json!({"prompt_tokens":value["prompt_eval_count"],"completion_tokens":value["eval_count"]})}else{value["usage"].clone()};
 let entry=Entry{id:uuid::Uuid::new_v4().to_string(),kind:"usage".into(),at:chrono::Local::now().to_rfc3339(),text:stage.into(),data:json!({"stage":stage,"model":model,"provider":provider,"usage":usage})};
 if let Err(error)=connect(app).and_then(|db|write_entry(&db,id,&entry)){log::warn!("History usage save failed: {error}");let _=tauri::Emitter::emit(app,"history_save_error",error);}
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn history_upserts_keeps_order_and_cascade_deletes(){let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();let id=uuid::Uuid::new_v4().to_string();db.execute("INSERT INTO history_sessions(id,mode,started_at,title) VALUES(?1,'live','2026-10-10','测试')",[&id]).unwrap();let mut entry=Entry{id:"a-1".into(),kind:"answer".into(),at:"now".into(),text:"增量".into(),data:Value::Null};write_entry(&db,&id,&entry).unwrap();entry.text="完整内容".into();write_entry(&db,&id,&entry).unwrap();let saved=read(&db,&id).unwrap();assert_eq!(saved["entries"].as_array().unwrap().len(),1);assert_eq!(saved["entries"][0]["text"],"完整内容");db.execute("DELETE FROM history_sessions WHERE id=?1",[id]).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM history_entries",[],|r|r.get::<_,i64>(0)).unwrap(),0);}
}

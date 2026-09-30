//! Source-preserving local interview library. Only extracted text and hashes enter SQLite.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}};
use uuid::Uuid;

const MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;
const INDEX_VERSION: i64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub path: String,
    pub collection: String,
    pub domains: Vec<String>,
    pub role: String,
    pub topics: Vec<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    pub source_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub status: String,
    pub message: String,
    pub collection: String,
    pub chunk_count: u32,
    pub card_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot { pub folders: Vec<Folder>, pub files: Vec<IndexedFile> }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Preferences {pub domains:Vec<String>,pub role:String,pub topics:Vec<String>}

pub fn preferences(conn:&Connection)->Result<Preferences,String>{
    let value:Option<String>=conn.query_row("SELECT value FROM app_state WHERE key='interview_preferences'",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    Ok(value.and_then(|v|serde_json::from_str(&v).ok()).unwrap_or_default())
}

pub fn save_preferences(conn:&Connection,value:&Preferences)->Result<(),String>{
    conn.execute("INSERT INTO app_state(key,value) VALUES ('interview_preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub added: usize, pub modified: usize, pub deleted: usize,
    pub unchanged: usize, pub duplicates: usize, pub skipped: usize,
    pub errors: usize, pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage { pub source_path: String, pub collection: String, pub text: String, pub score: f64 }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaCard {
    pub question: String,
    #[serde(default)] pub paraphrases: Vec<String>,
    pub short_points: String,
    #[serde(default)] pub explanation: String,
    #[serde(default)] pub pitfalls: String,
    pub source: String,
    #[serde(default)] pub verified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardHit { pub card: QaCard, pub source_path: String, pub score: f64 }

fn json_vec(value: &str) -> Vec<String> { serde_json::from_str(value).unwrap_or_default() }

pub fn add_folder(conn: &Connection, path: &str, collection: &str, domains: Vec<String>, role: String, topics: Vec<String>) -> Result<Folder, String> {
    if !matches!(collection, "technical" | "personal" | "cards") {
        return Err("Collection must be technical, personal, or cards".into());
    }
    let canonical = fs::canonicalize(path).map_err(|e| format!("Cannot read folder: {e}"))?;
    if !canonical.is_dir() { return Err("Selected path is not a folder".into()); }
    let path = canonical.to_string_lossy().to_string();
    let existing:Option<(String,String)>=conn.query_row("SELECT id,collection FROM interview_folders WHERE path=?1", [&path], |r| Ok((r.get(0)?,r.get(1)?)))
        .optional().map_err(|e| e.to_string())?;
    let id: String = existing.as_ref().map(|value|value.0.clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
    conn.execute("INSERT INTO interview_folders(id,path,collection,domains,role,topics) VALUES (?1,?2,?3,?4,?5,?6)
        ON CONFLICT(path) DO UPDATE SET collection=excluded.collection,domains=excluded.domains,role=excluded.role,topics=excluded.topics",
        params![id,path,collection,serde_json::to_string(&domains).unwrap(),role,serde_json::to_string(&topics).unwrap()]).map_err(|e| e.to_string())?;
    if existing.as_ref().is_some_and(|value|value.1!=collection) {
        // A hash match alone cannot reuse text chunks after changing a folder
        // into a card collection (or vice versa). Force the next sync to parse it.
        conn.execute("UPDATE interview_files SET sha256='' WHERE folder_id=?1",[&id]).map_err(|e|e.to_string())?;
    }
    Ok(Folder { id, path, collection: collection.into(), domains, role, topics, last_synced_at: None })
}

pub fn folders(conn: &Connection) -> Result<Vec<Folder>, String> {
    let mut stmt = conn.prepare("SELECT id,path,collection,domains,role,topics,last_synced_at FROM interview_folders ORDER BY path").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Folder { id:r.get(0)?,path:r.get(1)?,collection:r.get(2)?,domains:json_vec(&r.get::<_,String>(3)?),role:r.get(4)?,topics:json_vec(&r.get::<_,String>(5)?),last_synced_at:r.get(6)? })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

pub fn snapshot(conn: &Connection) -> Result<LibrarySnapshot, String> {
    let folders = folders(conn)?;
    let mut stmt = conn.prepare("SELECT f.source_path,f.sha256,f.size_bytes,f.status,f.message,d.collection,
        (SELECT COUNT(*) FROM interview_chunks c WHERE c.file_id=f.id),
        (SELECT COUNT(*) FROM interview_cards c WHERE c.file_id=f.id)
        FROM interview_files f JOIN interview_folders d ON d.id=f.folder_id ORDER BY f.source_path").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(IndexedFile { source_path:r.get(0)?,sha256:r.get(1)?,size_bytes:r.get::<_,i64>(2)? as u64,status:r.get(3)?,message:r.get(4)?,collection:r.get(5)?,chunk_count:r.get::<_,i64>(6)? as u32,card_count:r.get::<_,i64>(7)? as u32 })).map_err(|e| e.to_string())?;
    Ok(LibrarySnapshot { folders, files:rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())? })
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file=fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher=Sha256::new();
    let mut buf=[0u8;65536];
    loop { let n=file.read(&mut buf).map_err(|e| e.to_string())?; if n==0 {break;} hasher.update(&buf[..n]); }
    Ok(format!("{:x}",hasher.finalize()))
}

fn supported(path: &Path, collection: &str) -> bool {
    let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if collection=="cards" { ext=="json" } else { matches!(ext.as_str(),"md"|"txt"|"pdf"|"docx") }
}

fn read_cards(path: &Path) -> Result<Vec<QaCard>, String> {
    let raw=fs::read_to_string(path).map_err(|e| e.to_string())?;
    let cards:Vec<QaCard>=serde_json::from_str(&raw).or_else(|_|serde_json::from_str::<QaCard>(&raw).map(|c|vec![c])).map_err(|e|format!("Invalid QA card JSON: {e}"))?;
    if cards.is_empty() { return Err("QA card file is empty".into()); }
    for c in &cards {
        if c.question.trim().is_empty() || c.short_points.trim().is_empty() || c.source.trim().is_empty() { return Err("Each card needs question, shortPoints and source".into()); }
    }
    Ok(cards)
}

/// Re-hash supported files, update only changed records, and remove deleted paths from the index.
/// This function never renames, moves, writes, or deletes a user source file.
pub fn sync(conn: &Connection, folder_id: &str) -> Result<SyncReport, String> {
    let started=std::time::Instant::now();
    let folder=folders(conn)?.into_iter().find(|f|f.id==folder_id).ok_or("Folder not registered")?;
    let root=PathBuf::from(&folder.path);
    if !root.is_dir() { return Err("Source folder is unavailable; index left unchanged".into()); }
    let mut report=SyncReport { added:0,modified:0,deleted:0,unchanged:0,duplicates:0,skipped:0,errors:0,duration_ms:0 };
    let mut seen=HashSet::new();
    let mut entries=Vec::new();
    let mut scan_errors=0;
    for entry in walkdir::WalkDir::new(&root).follow_links(false).into_iter() {
        let entry=match entry { Ok(e)=>e,Err(_)=>{ scan_errors+=1; continue; } };
        if !entry.file_type().is_file() || entry.file_type().is_symlink() { continue; }
        let path=entry.path();
        if !supported(path,&folder.collection) { report.skipped+=1; continue; }
        seen.insert(path.to_string_lossy().to_string());
        entries.push(entry);
    }
    // An incomplete walk must not turn unreadable files into index deletions.
    if scan_errors>0 {return Err(format!("Folder scan had {scan_errors} errors; index left unchanged"));}
    let mut stmt=conn.prepare("SELECT id,source_path FROM interview_files WHERE folder_id=?1").map_err(|e|e.to_string())?;
    let old_paths:Vec<(String,String)>=stmt.query_map([folder_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    for (id,path) in old_paths {if !seen.contains(&path) {conn.execute("DELETE FROM interview_files WHERE id=?1",[id]).map_err(|e|e.to_string())?;report.deleted+=1;}}
    entries.sort_by(|left,right|left.path().cmp(right.path()));
    for entry in entries {
        let path=entry.path();
        let source_path=path.to_string_lossy().to_string();
        let metadata=match entry.metadata() {Ok(m)=>m,Err(_)=>{report.errors+=1;continue;}};
        let size=metadata.len();
        let digest=if size>MAX_DOCUMENT_BYTES { String::new() } else { match sha256(path) {Ok(v)=>v,Err(_)=>{report.errors+=1;continue;}} };
        let old:Option<(String,String,String,u64,i64)>=conn.query_row("SELECT id,sha256,status,size_bytes,index_version FROM interview_files WHERE source_path=?1",[&source_path],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get::<_,i64>(3)? as u64,r.get(4)?))).optional().map_err(|e|e.to_string())?;
        if let Some((_,old_hash,old_status,old_size,old_version))=&old {
            if *old_hash==digest && *old_size==size && *old_version==INDEX_VERSION {
                let still_duplicate=if old_status=="duplicate" {conn.query_row("SELECT 1 FROM interview_files f JOIN interview_folders d ON d.id=f.folder_id WHERE f.sha256=?1 AND d.collection=?2 AND f.source_path<>?3 AND f.status='indexed' LIMIT 1",params![digest,folder.collection,source_path],|r|r.get::<_,i64>(0)).optional().map_err(|e|e.to_string())?.is_some()} else {false};
                if old_status=="indexed" || old_status=="skipped" || still_duplicate {report.unchanged+=1;continue;}
            }
        }
        let id=old.as_ref().map(|o|o.0.clone()).unwrap_or_else(||Uuid::new_v4().to_string());
        let mut status="indexed".to_string();
        let mut message=String::new();
        let mut chunks=Vec::new();
        let mut cards=Vec::new();
        if size>MAX_DOCUMENT_BYTES {status="skipped".into(); message=format!("File exceeds {} MiB extraction limit",MAX_DOCUMENT_BYTES/1048576);report.skipped+=1;}
        else {
            let duplicate:Option<String>=conn.query_row("SELECT f.source_path FROM interview_files f JOIN interview_folders d ON d.id=f.folder_id WHERE f.sha256=?1 AND d.collection=?2 AND f.source_path<>?3 AND f.status='indexed' LIMIT 1",params![digest,folder.collection,source_path],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if let Some(original)=duplicate {status="duplicate".into();message=format!("Same content as {original}");report.duplicates+=1;}
            else if folder.collection=="cards" {match read_cards(path) {Ok(v)=>cards=v,Err(e)=>{status="error".into();message=e;report.errors+=1;}}}
            else {
                let ext=path.extension().and_then(|e|e.to_str()).unwrap_or("").to_lowercase();
                match crate::rag::file_processor::extract_text(&source_path,&ext) {
                    Ok(text) if !text.trim().is_empty()=>{chunks=crate::rag::chunker::chunk_text(&text,320,32,"recursive");},
                    Ok(_)=>{status="error".into();message="No extractable text (scanned PDF may need OCR)".into();report.errors+=1;},
                    Err(e)=>{status="error".into();message=e;report.errors+=1;}
                }
            }
        }
        conn.execute("INSERT INTO interview_files(id,folder_id,source_path,sha256,size_bytes,status,message,updated_at,index_version) VALUES (?1,?2,?3,?4,?5,?6,?7,datetime('now'),?8) ON CONFLICT(source_path) DO UPDATE SET folder_id=excluded.folder_id,sha256=excluded.sha256,size_bytes=excluded.size_bytes,status=excluded.status,message=excluded.message,updated_at=excluded.updated_at,index_version=excluded.index_version",params![id,folder_id,source_path,digest,size as i64,status,message,INDEX_VERSION]).map_err(|e|e.to_string())?;
        conn.execute("DELETE FROM interview_chunks WHERE file_id=?1",[&id]).map_err(|e|e.to_string())?;
        conn.execute("DELETE FROM interview_cards WHERE file_id=?1",[&id]).map_err(|e|e.to_string())?;
        for chunk in chunks {conn.execute("INSERT INTO interview_chunks(file_id,chunk_index,text) VALUES (?1,?2,?3)",params![id,chunk.index as i64,chunk.text]).map_err(|e|e.to_string())?;}
        for (index,card) in cards.iter().enumerate() {conn.execute("INSERT INTO interview_cards(file_id,card_index,question,paraphrases,short_points,explanation,pitfalls,source,verified) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,index as i64,card.question,serde_json::to_string(&card.paraphrases).unwrap(),card.short_points,card.explanation,card.pitfalls,card.source,card.verified as i64]).map_err(|e|e.to_string())?;}
        if old.is_some() {report.modified+=1;} else {report.added+=1;}
    }
    conn.execute("UPDATE interview_folders SET last_synced_at=datetime('now') WHERE id=?1",[folder_id]).map_err(|e|e.to_string())?;
    report.duration_ms=started.elapsed().as_millis();
    Ok(report)
}

fn normalized(text:&str)->String {text.chars().filter(|c|c.is_alphanumeric()).flat_map(|c|c.to_lowercase()).collect()}
fn grams(text:&str)->HashSet<String> {
    let chars:Vec<char>=normalized(text).chars().collect();
    if chars.len()<2 {return chars.iter().map(|c|c.to_string()).collect();}
    chars.windows(2).map(|w|w.iter().collect()).collect()
}
fn similarity(a:&str,b:&str)->f64 {
    let english_dominant=|text:&str| {
        let latin=text.chars().filter(|ch|ch.is_ascii_alphabetic()).count();
        let han=text.chars().filter(|ch|('\u{3400}'..='\u{9fff}').contains(ch)).count();
        latin>=5 && latin>han*2
    };
    if english_dominant(a) && english_dominant(b) {
        let a=english_terms(a);let b=english_terms(b);
        if a.is_empty() || b.is_empty(){return 0.0;}
        return 2.0*a.intersection(&b).count() as f64/(a.len()+b.len()) as f64;
    }
    if english_dominant(a)!=english_dominant(b) {return 0.0;}
    let a=grams(a);let b=grams(b);
    if a.is_empty() || b.is_empty(){return 0.0;}
    let shared=a.intersection(&b).count() as f64;
    2.0*shared/(a.len()+b.len()) as f64
}

fn english_terms(value:&str)->HashSet<String> {
    const FILLER:&[&str]=&["what","when","where","which","would","could","should","about",
        "describe","explain","please","tell","your","project","projects","design","large",
        "scale","service","system","systems","application","applications","does","work",
        "with","that","this","from","into","used","using","use","you","the","and",
        "for","are","was","were","how"];
    value.split(|ch:char|!ch.is_ascii_alphanumeric()).filter(|part|part.len()>=3)
        .map(|part|part.to_ascii_lowercase())
        .filter(|part|!FILLER.contains(&part.as_str())).collect()
}

fn retrieval_score(question:&str,text:&str)->f64 {
    let latin=question.chars().filter(|ch|ch.is_ascii_alphabetic()).count();
    let han=question.chars().filter(|ch|('\u{3400}'..='\u{9fff}').contains(ch)).count();
    if latin>=5 && latin>han*2 {
        // Character bigrams make unrelated English questions match incidental
        // substrings ("rate limiter" matched RedCap's "data rate").
        let query=english_terms(question);
        let passage=english_terms(text);
        if query.is_empty() || passage.is_empty(){return 0.0;}
        let shared=query.intersection(&passage).collect::<Vec<_>>();
        if shared.is_empty(){return 0.0;}
        if query.len()>1 && shared.len()==1 {
            let term=shared[0];
            let acronym=question.split(|ch:char|!ch.is_ascii_alphanumeric())
                .any(|raw|raw.eq_ignore_ascii_case(term) &&
                    raw.chars().filter(|ch|ch.is_ascii_uppercase()).count()>=2);
            if term.len()<6 && !acronym {return 0.0;}
        }
        let count=shared.len() as f64;
        return 0.8*count/query.len() as f64+0.2*(2.0*count/(query.len()+passage.len()) as f64);
    }
    let mut focused=question.to_lowercase();
    for filler in ["请介绍一下","介绍一下","你在","你的","项目中","项目里","负责什么","什么是","解释一下","的原理","如何","怎么","为什么","请","什么","what is","how does","your project"] {
        focused=focused.replace(filler,"");
    }
    let query=grams(&focused);let passage=grams(text);
    if query.is_empty() || passage.is_empty(){return 0.0;}
    let shared=query.intersection(&passage).count() as f64;
    let coverage=shared/query.len() as f64;
    let dice=2.0*shared/(query.len()+passage.len()) as f64;
    0.8*coverage+0.2*dice
}

/// Return a verbatim source fragment for personal claims. This is an answer
/// cue, not a generated assertion; uncertain wording stays visible verbatim.
pub fn personal_excerpt(question:&str,text:&str)->String {
    let fragments=text.split(['\n','。']).map(|part|part.trim().trim_start_matches(['-','*','>',' ']).trim())
        .filter(|part|part.chars().count()>=8 && part.chars().count()<=110)
        .filter(|part|!["适合关键词","推荐优先级","项目目标","技术与原理","来源："].iter().any(|marker|part.starts_with(marker)))
        .filter(|part|!part.contains("署名为"));
    let score=|part:&str| {
        let boundary=if ["待核验","不应表述","不能表述"].iter().any(|marker|part.contains(marker)){0.12}else{0.0};
        let action=if ["个人贡献","参与","本人","工程交付","报告支持"].iter().any(|marker|part.contains(marker)){0.05}else{0.0};
        let length_penalty=part.chars().count().saturating_sub(80) as f64*0.01;
        retrieval_score(question,part)+boundary+action-length_penalty
    };
    fragments.max_by(|left,right|score(left).total_cmp(&score(right)))
        .unwrap_or("").to_string()
}

pub fn best_personal_evidence(question:&str,focus:&str,passages:&[Passage])->Option<String> {
    let anchored_focus=focus.len()>=3 && focus.chars().all(|ch|ch.is_ascii_alphanumeric());
    let mut chosen:Option<(String,f64)>=None;
    for passage in passages.iter().filter(|passage|passage.collection=="personal") {
        let excerpt=personal_excerpt(question,&passage.text);
        if excerpt.is_empty(){continue;}
        let anchored=anchored_focus && excerpt.to_lowercase().contains(&focus.to_lowercase());
        let score=retrieval_score(question,&excerpt)+0.15*passage.score-
            excerpt.chars().count().saturating_sub(80) as f64*0.01+
            if anchored {0.5}else{0.0};
        if chosen.as_ref().map(|value|score>value.1).unwrap_or(true) {
            chosen=Some((excerpt,score));
        }
    }
    chosen.map(|value|value.0)
}

pub fn card_hit(conn:&Connection,question:&str)->Result<Option<CardHit>,String>{
    let mut stmt=conn.prepare("SELECT f.source_path,c.question,c.paraphrases,c.short_points,c.explanation,c.pitfalls,c.source,c.verified FROM interview_cards c JOIN interview_files f ON f.id=c.file_id WHERE f.status='indexed' AND c.verified=1").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,QaCard{question:r.get(1)?,paraphrases:json_vec(&r.get::<_,String>(2)?),short_points:r.get(3)?,explanation:r.get(4)?,pitfalls:r.get(5)?,source:r.get(6)?,verified:r.get::<_,i64>(7)?!=0}))).map_err(|e|e.to_string())?;
    let mut best:Option<CardHit>=None;
    for row in rows {let (source_path,card)=row.map_err(|e|e.to_string())?;
        let score=std::iter::once(&card.question).chain(card.paraphrases.iter()).map(|p|similarity(question,p)).fold(0.0,f64::max);
        if score>=0.78 && best.as_ref().map(|h|score>h.score).unwrap_or(true) {best=Some(CardHit{card,source_path,score});}
    }
    Ok(best)
}

pub fn retrieve(conn:&Connection,question:&str,collection:&str,preferences:&Preferences,limit:usize)->Result<Vec<Passage>,String>{
    let mut stmt=conn.prepare("SELECT f.source_path,c.text,d.domains,d.role,d.topics FROM interview_chunks c JOIN interview_files f ON f.id=c.file_id JOIN interview_folders d ON d.id=f.folder_id WHERE f.status='indexed' AND d.collection=?1").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([collection],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,json_vec(&r.get::<_,String>(2)?),r.get::<_,String>(3)?,json_vec(&r.get::<_,String>(4)?)))).map_err(|e|e.to_string())?;
    let mut scored=Vec::new();
    for row in rows {let (source_path,text,file_domains,file_role,file_topics)=row.map_err(|e|e.to_string())?;
        let base=retrieval_score(question,&text);
        let minimum=if collection=="personal" {0.42}else{0.30};
        if base<minimum {continue;}
        let domain_match=preferences.domains.iter().any(|d|file_domains.iter().any(|f|f.eq_ignore_ascii_case(d)));
        let role_match=!preferences.role.is_empty() && file_role.eq_ignore_ascii_case(&preferences.role);
        let topic_match=preferences.topics.iter().any(|topic|file_topics.iter().any(|f|f.eq_ignore_ascii_case(topic)) || text.to_lowercase().contains(&topic.to_lowercase()));
        let boost=1.0+if domain_match {0.08}else{0.0}+if role_match {0.03}else{0.0}+if topic_match {0.06}else{0.0};
        scored.push(Passage{source_path,collection:collection.into(),text,score:base*boost});
    }
    scored.sort_by(|a,b|b.score.total_cmp(&a.score));
    let mut source_counts=std::collections::HashMap::<String,usize>::new();
    scored.retain(|passage|{
        let count=source_counts.entry(passage.source_path.clone()).or_default();
        if *count>=2 {false}else{*count+=1;true}
    });
    scored.truncate(limit);
    Ok(scored)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn chinese_paraphrase_retrieval_score() {assert!(similarity("什么是 LoRA 微调？","请解释 LoRA 微调的原理")>similarity("什么是 LoRA 微调？","介绍你的实习经历"));}
    #[test] fn chinese_retrieval_prefers_topic_over_generic_project_words(){assert!(retrieval_score("你在 RedCap 巡检机器人项目中负责什么？","参与 RedCap 巡检机器人测试与报告整理")>retrieval_score("你在 RedCap 巡检机器人项目中负责什么？","介绍一般项目管理方法"));}
    #[test] fn unrelated_english_technical_question_does_not_hit_redcap(){
        let question="How would you design a rate limiter for a large scale service?";
        let reference="RedCap is a reduced-capability 5G device for lower-cost industrial connections. Its bandwidth and MIMO capabilities are limited.";
        assert!(retrieval_score(question,reference)<0.30);
    }
    #[test] fn named_english_technical_question_can_hit_its_reference(){
        let question="What is RedCap and what are its limitations?";
        let reference="RedCap is a reduced-capability 5G device. Its bandwidth and MIMO capabilities are limited.";
        assert!(retrieval_score(question,reference)>=0.30);
    }
    #[test] fn personal_excerpt_keeps_source_wording(){let source="- 参与 RedCap 巡检机器人部分测试与报告。\n- 现场参与角色待核验，不应表述为独立负责。";let excerpt=personal_excerpt("RedCap 项目职责",source);assert!(source.contains(&excerpt));}
    #[test] fn personal_excerpt_avoids_keyword_metadata(){let source="适合关键词：5G RedCap Industrial Inspection Robot\n重要边界：RedCap 现场角色待核验，不应表述为独立负责。";assert!(personal_excerpt("RedCap 项目职责",source).starts_with("重要边界"));}
    #[test] fn personal_evidence_prefers_named_topic_over_contextless_caveat(){let passages=vec![Passage{source_path:"a".into(),collection:"personal".into(),text:"否则保留测试方案与报告支持这一口径。".into(),score:0.9},Passage{source_path:"b".into(),collection:"personal".into(),text:"RedCap 现场角色待核验，不应表述为独立负责。".into(),score:0.8}];assert!(best_personal_evidence("解释 RedCap 的能力取舍，并说明项目工作","RedCap",&passages).unwrap().contains("RedCap"));}
    #[test] fn personal_evidence_avoids_long_project_summary_when_short_source_exists(){
        let passages=vec![
            Passage{source_path:"summary".into(),collection:"personal".into(),score:0.49,
                text:"第一作者 投稿审稿中针对 VLA 边云协同推理中的中间特征通信瓶颈，提出以策略决策相关性为核心的离散视觉特征编码框架，通过决策敏感度驱动的非均匀容量分配与因果时空熵编码，在有限码率下优先保留动作生成所需信息。".into()},
            Passage{source_path:"project".into(),collection:"personal".into(),score:0.44,
                text:"- 研究问题：面向 VLA 边云协同推理中高维视觉中间特征带来的上行通信瓶颈，研究任务相关特征编码方法。".into()},
        ];
        let evidence=best_personal_evidence("请介绍一下你做过的边云协同视觉特征编码项目。","边云协同视觉特征编码",&passages).unwrap();
        assert!(evidence.starts_with("研究问题："));
    }
    #[test] fn no_unverified_card() {
        let conn=Connection::open_in_memory().unwrap();crate::db::migrations::run(&conn).unwrap();
        let id=Uuid::new_v4().to_string();
        conn.execute("INSERT INTO interview_folders(id,path,collection) VALUES (?1,'test','cards')",[&id]).unwrap();
        conn.execute("INSERT INTO interview_files(id,folder_id,source_path,sha256,size_bytes,status,updated_at) VALUES ('f',?1,'card.json','x',1,'indexed','now')",[&id]).unwrap();
        conn.execute("INSERT INTO interview_cards(file_id,card_index,question,paraphrases,short_points,explanation,pitfalls,source,verified) VALUES ('f',0,'什么是 LoRA','[]','低秩适配','','','source',0)",[]).unwrap();
        assert!(card_hit(&conn,"什么是 LoRA").unwrap().is_none());
    }
    #[test] fn verified_card_matches_reviewed_paraphrase() {
        let dir=tempfile::tempdir().unwrap();
        fs::write(dir.path().join("lora.json"),r#"{"question":"什么是 LoRA？","paraphrases":["请解释 LoRA 的原理"],"shortPoints":"冻结底座并训练低秩更新","explanation":"低秩适配","pitfalls":"不要声称精度恒定","source":"Hu et al. 2022","verified":true}"#).unwrap();
        let conn=Connection::open_in_memory().unwrap();crate::db::migrations::run(&conn).unwrap();
        let folder=add_folder(&conn,dir.path().to_str().unwrap(),"cards",vec![],String::new(),vec![]).unwrap();
        assert_eq!(sync(&conn,&folder.id).unwrap().added,1);
        let hit=card_hit(&conn,"请解释 LoRA 的原理").unwrap().unwrap();
        assert!(hit.score>0.99);
        assert_eq!(hit.card.short_points,"冻结底座并训练低秩更新");
    }
    #[test] fn english_card_ignores_generic_system_design_question_frame() {
        let rate="How would you design a rate limiter for a large scale service?";
        assert!(similarity(rate,rate)>0.99);
        assert!(similarity("How would you design a circuit breaker for a large scale service?",rate)<0.78);
        assert!(similarity("How would you design a cache for a large scale service?",rate)<0.78);
    }
    #[test] fn sync_promotes_duplicate_when_indexed_original_disappears() {
        let dir=tempfile::tempdir().unwrap();
        let remaining=dir.path().join("remaining.md");
        fs::write(&remaining,"LoRA 使用两个低秩矩阵表示权重更新。").unwrap();
        let conn=Connection::open_in_memory().unwrap();crate::db::migrations::run(&conn).unwrap();
        let folder=add_folder(&conn,dir.path().to_str().unwrap(),"technical",vec![],String::new(),vec![]).unwrap();
        sync(&conn,&folder.id).unwrap();
        let indexed_path:String=conn.query_row("SELECT source_path FROM interview_files LIMIT 1",[],|r|r.get(0)).unwrap();
        let hash:String=conn.query_row("SELECT sha256 FROM interview_files WHERE source_path=?1",[&indexed_path],|r|r.get(0)).unwrap();
        let stale=std::path::Path::new(&indexed_path).with_file_name("a-removed.md").to_string_lossy().to_string();
        conn.execute("INSERT INTO interview_files(id,folder_id,source_path,sha256,size_bytes,status,updated_at,index_version) VALUES ('stale',?1,?2,?3,1,'indexed','now',?4)",params![folder.id,stale,hash,INDEX_VERSION]).unwrap();
        conn.execute("UPDATE interview_files SET status='duplicate' WHERE source_path=?1",[&indexed_path]).unwrap();
        let report=sync(&conn,&folder.id).unwrap();
        assert_eq!(report.deleted,1);
        assert_eq!(report.modified,1);
        let status:String=conn.query_row("SELECT status FROM interview_files WHERE source_path=?1",[&indexed_path],|r|r.get(0)).unwrap();
        assert_eq!(status,"indexed");
    }
    #[test] fn incremental_sync_preserves_sources_and_replaces_only_changed_index() {
        let dir=tempfile::tempdir().unwrap();
        let first=dir.path().join("first.md");let duplicate=dir.path().join("duplicate.md");
        fs::write(&first,"LoRA 使用低秩矩阵更新冻结模型的权重，减少可训练参数。").unwrap();
        fs::write(&duplicate,fs::read(&first).unwrap()).unwrap();
        let source_before=fs::read(&first).unwrap();
        let conn=Connection::open_in_memory().unwrap();crate::db::migrations::run(&conn).unwrap();
        let folder=add_folder(&conn,dir.path().to_str().unwrap(),"technical",vec!["AI".into()],String::new(),vec![]).unwrap();
        let report=sync(&conn,&folder.id).unwrap();
        assert_eq!(report.added,2);assert_eq!(report.duplicates,1);
        assert_eq!(fs::read(&first).unwrap(),source_before);
        assert!(!retrieve(&conn,"LoRA 低秩矩阵", "technical",&Preferences::default(),3).unwrap().is_empty());
        fs::write(&duplicate,"5G RedCap 降低终端复杂度与功耗。").unwrap();
        let report=sync(&conn,&folder.id).unwrap();
        assert_eq!(report.modified+report.unchanged,2);
        assert!(report.modified>=1);
        fs::remove_file(&duplicate).unwrap();
        let report=sync(&conn,&folder.id).unwrap();
        assert_eq!(report.deleted,1);
        assert_eq!(fs::read(&first).unwrap(),source_before);
    }
}

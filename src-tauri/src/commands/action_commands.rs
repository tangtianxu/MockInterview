//! Filesystem navigation for the inline picker. No OS windows or file content.
use serde::Serialize;
use std::path::{Path,PathBuf};
use tauri::{AppHandle,Manager,command};

#[derive(Serialize)]
pub struct FileEntry {name:String,path:String,directory:bool}
#[derive(Serialize)]
pub struct Place {name:String,path:String}
#[derive(Serialize)]
pub struct Location {path:String,parent:Option<String>,entries:Vec<FileEntry>,places:Vec<Place>,truncated:bool}
fn display(path:&Path)->String {path.to_string_lossy().into_owned()}
fn absolute(path:&Path)->Result<(),String>{if !path.is_absolute(){return Err("请输入完整的文件或文件夹路径。".into());}Ok(())}
fn allowed(path:&Path,extensions:&[String])->bool{extensions.is_empty()||path.extension().and_then(|v|v.to_str()).is_some_and(|v|extensions.iter().any(|e|e.eq_ignore_ascii_case(v)))}
fn browse(path:&Path,extensions:&[String],directories_only:bool,query:&str)->Result<Location,String>{
 absolute(path)?;
 if !path.is_dir(){return Err("该文件夹不存在或无法访问，请检查路径。".into());}
 let query=query.to_lowercase();
 let mut entries=Vec::new();
 for entry in std::fs::read_dir(path).map_err(|e|format!("无法读取文件夹：{e}"))?{
  let entry=entry.map_err(|e|e.to_string())?;
  let target=entry.path();let directory=target.is_dir();
  if !directory&&(directories_only||!allowed(&target,extensions)){continue;}
  let name=entry.file_name().to_string_lossy().into_owned();
  if !query.is_empty()&&!name.to_lowercase().contains(&query){continue;}
  entries.push(FileEntry{name,path:display(&target),directory});
 }
 entries.sort_by(|a,b|b.directory.cmp(&a.directory).then_with(||a.name.to_lowercase().cmp(&b.name.to_lowercase())));
 let truncated=entries.len()>2000;entries.truncate(2000);
 Ok(Location{path:display(path),parent:path.parent().map(display),entries,places:Vec::new(),truncated})
}
#[command]
pub fn action_browse_files(app:AppHandle,path:Option<String>,extensions:Vec<String>,directories_only:bool,query:String)->Result<Location,String>{
 let home=app.path().home_dir().map_err(|e|e.to_string())?;
 let target=path.filter(|p|!p.trim().is_empty()).map(PathBuf::from).unwrap_or_else(||app.path().document_dir().unwrap_or_else(|_|home.clone()));
 let mut result=browse(&target,&extensions,directories_only,&query)?;
 for (name,path) in [("桌面",app.path().desktop_dir()),("文档",app.path().document_dir()),("下载",app.path().download_dir()),("用户目录",Ok(home))]{
  if let Ok(path)=path{if path.is_dir(){result.places.push(Place{name:name.into(),path:display(&path)});}}
 }
 #[cfg(windows)] {
  #[link(name="kernel32")] extern "system" {fn GetLogicalDrives()->u32;}
  let mask=unsafe{GetLogicalDrives()};
  for i in 0..26 {if mask&(1<<i)!=0 {let drive=format!("{}:\\",(b'A'+i) as char);result.places.push(Place{name:drive.clone(),path:drive});}}
 }
 Ok(result)
}
fn resolve(paths:Vec<String>,save:bool,directory:bool,multiple:bool,extensions:&[String],overwrite:bool)->Result<Vec<String>,String>{
 if paths.is_empty()||paths.len()>1000||(!multiple&&paths.len()!=1)||save&&paths.len()!=1{return Err("请选择有效的文件数量。".into());}
 let mut resolved=Vec::new();
 for value in paths {
  let mut path=PathBuf::from(value);absolute(&path)?;
  if save {
   if directory{return Err("保存目标必须是文件。".into());}
   if path.extension().is_none(){if let Some(ext)=extensions.first(){path.set_extension(ext);}}
   let parent=path.parent().ok_or("请选择保存文件夹。")?;
   if !parent.is_dir()||path.file_name().is_none(){return Err("保存文件夹不存在或文件名无效。".into());}
   if path.is_dir(){return Err("不能用文件覆盖文件夹。".into());}
   if path.exists()&&!overwrite{return Err("同名文件已存在。请改名，或勾选“允许覆盖同名文件”。".into());}
   if !allowed(&path,extensions){return Err("文件扩展名与所选文件类型不一致。".into());}
  }else if directory {
   if !path.is_dir(){return Err("请选择存在的文件夹。".into());}
  }else if !path.is_file()||!allowed(&path,extensions){return Err("文件不存在、无法访问或文件类型不符合要求。".into());}
  let value=display(&path);if !resolved.contains(&value){resolved.push(value);}
 }
 Ok(resolved)
}
#[command]
pub fn action_resolve_paths(paths:Vec<String>,save:bool,directory:bool,multiple:bool,extensions:Vec<String>,overwrite:bool)->Result<Vec<String>,String>{resolve(paths,save,directory,multiple,&extensions,overwrite)}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn picker_filters_files_but_preserves_navigation_and_checks_overwrite(){
  let root=std::env::temp_dir().join(format!("mock-picker-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();
  let _cleanup=Cleanup(root.clone());
  std::fs::create_dir(root.join("sub")).unwrap();std::fs::write(root.join("notes.TXT"),"fixture").unwrap();std::fs::write(root.join("other.pdf"),"fixture").unwrap();
  let ext=vec!["txt".into()];let result=browse(&root,&ext,false,"").unwrap();assert_eq!(result.entries.len(),2);assert!(result.entries[0].directory);
  assert_eq!(browse(&root,&ext,false,"notes").unwrap().entries.len(),1);
  assert_eq!(browse(&root,&[],true,"").unwrap().entries.len(),1);
  assert!(resolve(vec![display(&root.join("notes.TXT"))],true,false,false,&ext,false).is_err());
  assert!(resolve(vec![display(&root.join("notes.TXT"))],true,false,false,&ext,true).is_ok());
  assert!(resolve(vec![display(&root.join("other.pdf"))],false,false,false,&ext,false).is_err());
  assert!(resolve(vec![display(&root.join("notes.TXT"))],false,true,false,&[],false).is_err());
  assert!(resolve(vec![display(&root)],false,true,false,&[],false).is_ok());
  assert!(resolve(vec![display(&root.join("new"))],true,false,false,&ext,false).unwrap()[0].ends_with("new.txt"));
  assert!(resolve(vec!["relative.txt".into()],true,false,false,&ext,false).is_err());
 }
 struct Cleanup(PathBuf);impl Drop for Cleanup{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
}

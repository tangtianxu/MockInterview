//! Separate, portable question bank and read-only source cache. SQLite is derived.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::Path,
};
use uuid::Uuid;

pub const CATEGORIES: &[&str] = &[
    "项目问题",
    "技术基础",
    "开放型问题",
    "行为与经历",
    "个人介绍与求职",
];
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub active_project: String,
    #[serde(default)]
    pub build_model: String,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub folder_projects: HashMap<String, String>,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub organization_mode: String,
    #[serde(default)]
    pub project_proposals: Vec<crate::knowledge_intake::ProjectProposal>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub path: String,
    pub relative_path: String,
    pub project: String,
    pub hash: String,
    pub text_hash: String,
    pub modified: u64,
    pub characters: usize,
    pub status: String,
    pub note: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Reference {
    pub source_id: String,
    pub hash: String,
    pub quote: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Origin {
    pub session_id: String,
    pub entry_id: String,
    pub at: String,
    pub original: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub category: String,
    pub project: String,
    pub question: String,
    pub task: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub answer: String,
    pub explanation: String,
    pub follow_ups: Vec<String>,
    pub status: String,
    pub answer_source: String,
    pub priority: u8,
    pub priority_reason: String,
    pub missing: Vec<String>,
    pub references: Vec<Reference>,
    pub origins: Vec<Origin>,
    pub updated_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_id: Option<String>,
    pub root: String,
    pub library: Library,
    pub questions: Vec<Question>,
    pub errors: Vec<String>,
    pub inbox: Inbox,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inbox {
    pub items: Vec<Question>,
    #[serde(default)]
    pub matches: Vec<serde_json::Value>,
    #[serde(default)]
    pub drafts: Vec<serde_json::Value>,
    #[serde(default)]
    pub editor: Option<Question>,
    #[serde(default)]
    pub cursor: serde_json::Value,
}
pub fn load_inbox(root: &Path) -> Result<Inbox, String> {
    let path = root.join("inbox.json");
    let result = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("待整理草稿文件无效，原文件已保留：{e}")),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => Ok(Inbox::default()),
        Err(e) => Err(format!("待整理草稿读取失败，原文件已保留：{}；{e}",path.display())),
    };
    trace_saved_read(root, "inbox", &path, path.exists(),
        result.as_ref().map(|v| serde_json::json!({"items":v.items.len()})).map_err(|e| e.clone()));
    result
}

// Local diagnostics contain file identity, counts and errors, never source text.
pub fn diagnostics_enabled(root:&Path)->bool { fs::read(root.join(".diagnostics/enabled")).is_ok() }
fn trace_saved_read(root: &Path, name: &str, path: &Path, exists: bool, parsed: Result<serde_json::Value, String>) {
    if !diagnostics_enabled(root) { return; }
    let probe = match fs::read(path) {
        Ok(bytes) => {
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            serde_json::json!({"bytes":bytes.len(),"sha256":digest(&bytes),
                "sources":value["sources"].as_array().map(Vec::len),
                "items":value["items"].as_array().map(Vec::len),"buildModel":value["buildModel"].as_str()})
        },
        Err(e) => serde_json::json!({"error":e.to_string(),"osError":e.raw_os_error(),"kind":format!("{:?}",e.kind())}),
    };
    let data=serde_json::json!({"at":now(),"pid":std::process::id(),"file":path,"existsAfterRead":exists,
        "tryExists":format!("{:?}",path.try_exists()),"parsed":parsed,"readProbe":probe});
    if let Ok(bytes)=serde_json::to_vec_pretty(&data) { let _=atomic(&root.join(".diagnostics").join(format!("{name}-read.json")),&bytes); }
}
pub fn save_inbox(root: &Path, inbox: &Inbox) -> Result<(), String> {
    for q in &inbox.items {
        validate_question(q)?;
    }
    let bytes = serde_json::to_vec_pretty(inbox).map_err(|e| e.to_string())?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("本地待整理草稿超过 32 MiB，请先处理已有草稿".into());
    }
    atomic(&root.join("inbox.json"), &bytes)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub source_id: String,
    pub hash: String,
    pub project: String,
    pub path: String,
    pub locator: String,
    pub text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub enabled: bool,
    pub exact: Option<Question>,
    pub questions: Vec<Question>,
    pub passages: Vec<Passage>,
    pub projects: Vec<String>,
    pub ambiguous: bool,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
pub fn stamp(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|t| t.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}
pub fn atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("文件目录无效")?).map_err(|e| e.to_string())?;
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    temp.write_all(data).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load(root: &Path) -> Result<Library, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join("library.json");
    let result = match fs::read(&path) {
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => Ok(Library {
            build_model: "current".into(),
            ..Default::default()
        }),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("知识库设置损坏，原文件已保留：{e}")),
        Err(e) => Err(format!("知识库设置读取失败，原文件已保留：{}；{e}",path.display())),
    };
    trace_saved_read(root, "library", &path, path.exists(),
        result.as_ref().map(|v| serde_json::json!({"sources":v.sources.len(),"buildModel":v.build_model})).map_err(|e| e.clone()));
    result
}
pub fn save_library(root: &Path, lib: &Library) -> Result<(), String> {
    atomic(
        &root.join("library.json"),
        &serde_json::to_vec_pretty(lib).map_err(|e| e.to_string())?,
    )
}
fn valid_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "题目或来源 ID 无效".into())
}
pub fn source_text(root: &Path, id: &str) -> Result<String, String> {
    valid_id(id)?;
    fs::read_to_string(root.join("sources").join(format!("{id}.txt"))).map_err(|e| e.to_string())
}
pub fn verified_source_text(root: &Path, source: &Source) -> Result<String,String> {
    if stamp(Path::new(&source.path))!=source.modified || digest(&fs::read(&source.path).map_err(|e|e.to_string())?)!=source.hash {
        return Err("原资料已变化，请先增量刷新再分析".into());
    }
    let text=source_text(root,&source.id)?;
    if !source.text_hash.is_empty() {
        if digest(text.as_bytes())!=source.text_hash {return Err("提取文字副本已变化，请重新提取".into());}
    } else if crate::knowledge_documents::extract(Path::new(&source.path))?!=text {
        return Err("提取文字副本与原文件不一致，请重新提取".into());
    }
    Ok(text)
}
pub fn validate_question(q: &Question) -> Result<(), String> {
    valid_id(&q.id)?;
    if q.question.trim().is_empty()
        || q.question.chars().count() > 1500
        || q.category.trim().is_empty()
        || !matches!(q.status.as_str(), "draft" | "confirmed" | "stale")
        || q.answer.len() > 128 * 1024
        || q.explanation.len() > 128 * 1024
    {
        return Err("题目、分类、状态或回答长度无效".into());
    }
    if q.status == "confirmed" && q.answer.trim().is_empty() {
        return Err("请先填写标准回答，再确认采用".into());
    }
    Ok(())
}
pub fn validate_adoption(q:&Question)->Result<(),String>{
    if q.status=="confirmed"&&(!q.missing.is_empty()||(q.answer_source!="user"&&q.references.is_empty())){
        return Err("答案仍有待补信息或缺少依据，请先检查并修正，或明确由本人核实".into());
    }
    validate_question(q)
}
pub fn question_markdown(q: &Question) -> Result<String, String> {
    let mut metadata = q.clone();
    metadata.answer.clear();
    metadata.explanation.clear();
    metadata.question.clear();
    Ok(format!(
        "<!-- mockinterview-question-v1\n{}\n-->\n# {}\n\n## 标准回答\n{}\n\n## 展开要点\n{}\n",
        serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?,
        q.question,
        q.answer,
        q.explanation
    ))
}
pub fn parse_question(text: &str) -> Result<Question, String> {
    let metadata = text
        .strip_prefix("<!-- mockinterview-question-v1\n")
        .ok_or("缺少题目文件标识")?;
    let (json, body) = metadata.split_once("\n-->\n").ok_or("题目元数据未闭合")?;
    let mut q: Question = serde_json::from_str(json).map_err(|e| format!("题目元数据无效：{e}"))?;
    let body = body.strip_prefix("# ").ok_or("缺少问题标题")?;
    let (title, body) = body
        .split_once("\n\n## 标准回答\n")
        .ok_or("缺少标准回答分区")?;
    let (answer, explanation) = body
        .split_once("\n\n## 展开要点\n")
        .ok_or("缺少展开要点分区")?;
    q.question = title.trim().into();
    q.answer = answer.trim().into();
    q.explanation = explanation.trim().into();
    validate_question(&q)?;
    Ok(q)
}
pub fn questions(root: &Path) -> (Vec<Question>, Vec<String>) {
    let mut all = Vec::new();
    let mut errors = Vec::new();
    let mut ids = HashSet::new();
    let folder = root.join("questions");
    if !folder.exists() {
        return (all, errors);
    }
    for e in walkdir::WalkDir::new(folder).follow_links(false) {
        match e {
            Ok(e) if e.file_type().is_file() && e.path().extension().is_some_and(|s| s == "md") => {
                let result = fs::read_to_string(e.path())
                    .map_err(|e| e.to_string())
                    .and_then(|raw| parse_question(&raw));
                match result {
                    Ok(q) if ids.insert(q.id.clone()) => all.push(q),
                    Ok(_) => errors.push(format!("重复题目 ID：{}", e.path().display())),
                    Err(error) => errors.push(format!("{}：{error}", e.path().display())),
                }
            }
            Err(e) => errors.push(e.to_string()),
            _ => {}
        }
    }
    all.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then(a.project.cmp(&b.project))
            .then(a.question.cmp(&b.question))
    });
    (all, errors)
}
pub fn save_question(root: &Path, mut q: Question) -> Result<Question, String> {
    if q.id.is_empty() {
        q.id = Uuid::new_v4().to_string();
    }
    if q.category.is_empty() {
        q.category = "项目问题".into();
    }
    if q.status.is_empty() {
        q.status = "draft".into();
    }
    q.priority = q.priority.clamp(1, 3);
    q.updated_at = now();
    validate_question(&q)?;
    let path = root.join("questions").join(format!("{}.md", q.id));
    if path.exists() {
        let backup = root
            .join("archive")
            .join(format!("{}-{}.md", q.id, Uuid::new_v4()));
        atomic(&backup, &fs::read(&path).map_err(|e| e.to_string())?)?;
    }
    atomic(&path, question_markdown(&q)?.as_bytes())?;
    Ok(q)
}
pub fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let lib = load(root)?;
    let (mut qs, mut errors) = questions(root);
    for q in &mut qs {
        if q.status == "confirmed"
            && q.references.iter().any(|r| {
                !lib.sources.iter().any(|s| {
                    s.id == r.source_id
                        && s.hash == r.hash
                        && s.status == "ready"
                        && stamp(Path::new(&s.path)) == s.modified
                })
            })
        {
            q.status = "stale".into();
        }
    }
    let inbox = load_inbox(root).unwrap_or_else(|e| {
        errors.push(e);
        Inbox::default()
    });
    Ok(Snapshot {
        diagnostic_id: None,
        root: root.to_string_lossy().into_owned(),
        library: lib,
        questions: qs,
        errors,
        inbox,
    })
}
pub fn chunks(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut chunk = String::new();
    let mut label = "文档开头".to_string();
    let mut lines = 0;
    for line in text.lines() {
        let boundary = line.starts_with('#')
            || line.starts_with("[幻灯片 ")
            || line.starts_with("[PDF 第 ")
            || line.starts_with("[工作表 ")
            || line.starts_with("[实现单元：")
            || line.trim_start().starts_with("def ")
            || line.trim_start().starts_with("class ");
        if !chunk.is_empty()
            && (boundary
                || chunk.chars().count() + line.chars().count() > 5000)
        {
            out.push((label.clone(), std::mem::take(&mut chunk)));
            label = format!("续接 · 文本第 {} 行", lines + 1);
        }
        if boundary {
            label = line.chars().take(120).collect();
        }
        chunk.push_str(line);
        chunk.push('\n');
        lines += 1;
    }
    if !chunk.trim().is_empty() {
        out.push((label, chunk));
    }
    out
}
fn index(root: &Path) -> Result<Connection, String> {
    let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(source_id UNINDEXED,hash UNINDEXED,project UNINDEXED,path UNINDEXED,locator UNINDEXED,text,tokenize='trigram');").map_err(|e|e.to_string())?;
    Ok(conn)
}
pub fn rebuild_index(root: &Path, lib: &Library) -> Result<(), String> {
    let mut conn = index(root)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM passages", [])
        .map_err(|e| e.to_string())?;
    for s in lib.sources.iter().filter(|s| s.status == "ready") {
        for (locator, text) in chunks(&source_text(root, &s.id)?) {
            tx.execute("INSERT INTO passages(source_id,hash,project,path,locator,text) VALUES(?1,?2,?3,?4,?5,?6)",params![s.id,s.hash,s.project,s.relative_path,locator,text]).map_err(|e|e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}
pub fn scan(
    root: &Path,
    folder: &Path,
    progress: impl Fn(usize, usize, &str),
) -> Result<Snapshot, String> {
    scan_with_mode(root,folder,"organized",progress)
}
pub fn scan_with_mode(root:&Path,folder:&Path,mode:&str,progress:impl Fn(usize,usize,&str))->Result<Snapshot,String>{
    scan_folder(root,folder,mode,None,progress)
}
pub fn scan_project_folder(root:&Path,folder:&Path,name:Option<&str>,progress:impl Fn(usize,usize,&str))->Result<Snapshot,String>{
    let folder=fs::canonicalize(folder).map_err(|e|e.to_string())?;
    let default_name=folder.file_name().ok_or("请选择单个项目的文件夹，不要选择磁盘根目录")?.to_string_lossy();
    let project=name.filter(|p|!p.trim().is_empty()).unwrap_or(&default_name).trim();
    crate::knowledge_intake::validate_project(project)?;
    scan_folder(root,&folder,"auto",Some(project),progress)
}
fn scan_folder(root:&Path,folder:&Path,mode:&str,project_name:Option<&str>,progress:impl Fn(usize,usize,&str))->Result<Snapshot,String>{
    if !matches!(mode,"auto"|"organized"){return Err("资料整理方式无效".into());}
    let folder = fs::canonicalize(folder).map_err(|e| e.to_string())?;
    if !folder.is_dir() || root.starts_with(&folder) || folder.starts_with(root) {
        return Err("请选择知识库保存目录之外的原资料文件夹".into());
    }
    let mut lib = load(root)?;
    let folder_text = folder.to_string_lossy().to_string();
    let old: HashMap<String, Source> = lib
        .sources
        .iter()
        .map(|s| (s.path.clone(), s.clone()))
        .collect();
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(&folder)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(
                    ".git"
                        | "node_modules"
                        | "__pycache__"
                        | ".venv"
                        | "venv"
                        | "target"
                        | "dist"
                        | "tmp"
                )
            )
        })
    {
        let entry = entry.map_err(|e| format!("扫描未完成，索引保留：{e}"))?;
        if entry.file_type().is_file()
            && !entry.file_type().is_symlink()
            && !entry.file_name().to_string_lossy().starts_with("~$")
            && !entry.file_name().to_string_lossy().starts_with(".env")
        {
            entries.push(entry);
        }
    }
    let total = entries.len();
    let mut scanned = Vec::new();
    for (i, entry) in entries.into_iter().enumerate() {
        let path = entry.path();
        let relative = path.strip_prefix(&folder).map_err(|e| e.to_string())?;
        let rel = relative.to_string_lossy().into_owned();
        let full = path.to_string_lossy().into_owned();
        progress(i + 1, total, &rel);
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let project = if relative.components().count() > 1 {
            relative
                .components()
                .next()
                .unwrap()
                .as_os_str()
                .to_string_lossy()
                .into_owned()
        } else {
            folder
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
        let mut s = old.get(&full).cloned().unwrap_or_else(|| Source {
            id: Uuid::new_v4().to_string(),
            path: full.clone(),
            relative_path: rel.clone(),
            project: project_name.map(str::to_string).unwrap_or_else(||if mode=="auto" {
                lib.folder_projects.iter().filter(|(p,_)|path.starts_with(Path::new(p.as_str()))).max_by_key(|(p,_)|p.len()).map(|(_,name)|name.clone()).unwrap_or_else(||crate::knowledge_intake::UNASSIGNED.into())
            } else {project.clone()}),
            ..Default::default()
        });
        if let Some(name)=project_name{s.project=name.into();}
        s.modified = stamp(path);
        if !crate::knowledge_documents::supported(&ext) {
            s.status = "unsupported".into();
            s.note = if matches!(ext.as_str(), "doc" | "ppt" | "xls" | "wps" | "et" | "dps") {
                "旧 Office/WPS 原生格式暂需另存为 DOCX/PPTX/XLSX"
            } else {
                "图片/视频需视觉识别；模型权重与二进制文件不索引"
            }
            .into();
            scanned.push(s);
            continue;
        }
        if fs::metadata(path).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
            s.status = "error".into();
            s.note = "单个文件超过 64 MiB，未提取；原始数据可单独保留，不作为建题依据".into();
            scanned.push(s);
            continue;
        }
        let bytes = fs::read(path).map_err(|e| format!("{rel}：{e}"))?;
        let hash = digest(&bytes);
        if s.hash == hash
            && s.status == "ready"
            && root.join("sources").join(format!("{}.txt", s.id)).exists()
        {
            if s.text_hash.is_empty(){
                let cached=source_text(root,&s.id)?;
                if crate::knowledge_documents::extract(path)?==cached {s.text_hash=digest(cached.as_bytes());}
                else {s.hash.clear();}
            }
            if !s.hash.is_empty(){
            scanned.push(s);
            continue;
            }
        }
        s.hash = hash;
        match crate::knowledge_documents::extract(path) {
            Ok(text) if !text.trim().is_empty() => {
                s.characters = text.chars().count();
                s.text_hash = digest(text.as_bytes());
                s.status = "ready".into();
                s.note = if matches!(ext.as_str(), "pdf" | "pptx") {
                    "保留文字层；图片、图表与公式可能需视觉核对"
                } else {
                    ""
                }
                .into();
                atomic(
                    &root.join("sources").join(format!("{}.txt", s.id)),
                    text.as_bytes(),
                )?;
            }
            Ok(_) => {
                s.status = "error".into();
                s.note = "未提取到文字，扫描件需 OCR/视觉识别".into();
            }
            Err(e) => {
                s.status = "error".into();
                s.note = e;
            }
        }
        scanned.push(s);
    }
    lib.sources
        .retain(|s| !Path::new(&s.path).starts_with(&folder));
    lib.sources.extend(scanned);
    lib.organization_mode=mode.into();
    if let Some(name)=project_name{lib.folder_projects.insert(folder_text.clone(),name.into());}
    lib.project_proposals.retain(|p|lib.sources.iter().any(|s|s.id==p.source_id&&s.hash==p.hash&&!(project_name.is_some()&&Path::new(&s.path).starts_with(&folder))));
    if !lib.folders.contains(&folder_text) {
        lib.folders.push(folder_text);
    }
    save_library(root, &lib)?;
    rebuild_index(root, &lib)?;
    snapshot(root)
}
fn search_expression(query: &str) -> String {
    let mut clean = query.to_lowercase();
    for word in [
        "请介绍一下",
        "介绍一下",
        "你的",
        "项目中",
        "项目里",
        "怎么",
        "为什么",
        "如何",
        "请问",
        "什么",
        "这个",
        "一下",
        "的",
    ] {
        clean = clean.replace(word, "");
    }
    let mut grams = HashSet::new();
    let chars: Vec<char> = normalized(&clean).chars().collect();
    for group in chars.windows(3) {
        grams.insert(format!("\"{}\"", group.iter().collect::<String>()));
    }
    let mut list: Vec<_> = grams.into_iter().collect();
    list.sort();
    list.join(" OR ")
}
fn shared_source(s: &Source) -> bool {
    let name = s.relative_path.to_lowercase();
    s.project.contains("共享资料") || name.contains("简历") || name.contains("resume") || name.contains("材料索引")
}
pub fn retrieve(
    root: &Path,
    lib: &Library,
    query: &str,
    project: &str,
) -> Result<Vec<Passage>, String> {
    let expression = search_expression(query);
    if expression.is_empty() {
        return Ok(Vec::new());
    }
    if !root.join("index.sqlite").exists() {
        rebuild_index(root, lib)?;
    }
    let conn = index(root)?;
    let mut stmt=conn.prepare("SELECT source_id,hash,project,path,locator,text FROM passages WHERE passages MATCH ?1 ORDER BY CASE WHEN project=?2 THEN 0 ELSE 1 END,bm25(passages) LIMIT 80").map_err(|e|e.to_string())?;
    let mut values = stmt
        .query_map(params![expression, project], |r| {
            Ok(Passage {
                source_id: r.get(0)?,
                hash: r.get(1)?,
                project: r.get(2)?,
                path: r.get(3)?,
                locator: r.get(4)?,
                text: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    values.retain(|p| {
        lib.sources.iter().any(|s| {
            s.id == p.source_id
                && s.hash == p.hash
                && s.status == "ready"
                && (project.is_empty() || s.project == project || shared_source(s))
                && stamp(Path::new(&s.path)) == s.modified
        })
    });
    values.truncate(5);
    Ok(values)
}
pub fn lookup(root: &Path, query: &str) -> Result<Lookup, String> {
    lookup_with_context(root,query,"")
}
pub fn lookup_with_context(root: &Path, query: &str, context:&str) -> Result<Lookup, String> {
    let snap = snapshot(root)?;
    let lib = &snap.library;
    if !lib.enabled {
        return Ok(Lookup {
            enabled: false,
            exact: None,
            questions: Vec::new(),
            passages: Vec::new(),
            projects: Vec::new(),
            ambiguous: false,
        });
    }
    let norm = normalized(query);
    let task_norm=crate::knowledge_search::identity(query);
    let mut named: Vec<_> = lib
        .sources
        .iter()
        .map(|s| s.project.clone())
        .chain(snap.questions.iter().map(|q| q.project.clone()))
        .filter(|p| {
            let name = p.trim_start_matches(|c: char| c.is_ascii_digit() || c == '_');
            normalized(name).chars().count() >= 4 && norm.contains(&normalized(name))
        })
        .collect();
    named.sort();
    named.dedup();
    let project = if named.len() == 1 {
        named[0].as_str()
    } else {
        &lib.active_project
    };
    let qs: Vec<_> = snap
        .questions
        .iter()
        .filter(|q| {
            q.status == "confirmed"
                && (project.is_empty() || q.project.is_empty() || q.project == project)
        })
        .cloned()
        .collect();
    let exacts: Vec<_> = qs
        .iter()
        .filter(|q| {
            crate::knowledge_search::identity(&q.question) == task_norm || q.aliases.iter().any(|a| crate::knowledge_search::identity(a) == task_norm)
        })
        .cloned()
        .collect();
    let exact = if exacts.len() == 1 {
        exacts.first().cloned()
    } else {
        None
    };
    let ranked = crate::knowledge_search::ranked(query,context,&qs);
    let mut projects: Vec<_> = exacts
        .iter()
        .map(|q| q.project.clone())
        .filter(|s| !s.is_empty())
        .collect();
    projects.sort();
    projects.dedup();
    let ambiguous = exacts.len() > 1 && projects.len() > 1;
    projects.extend(
        ranked.iter().take(5).filter(|q|q.category=="项目问题").map(|q|q.project.clone()).filter(|s|!s.is_empty()),
    );
    projects.sort();
    projects.dedup();
    let passages = retrieve(root, lib, query, project)?;
    if project.is_empty() {
        projects.extend(
            passages
                .iter()
                .filter(|p| {
                    lib.sources
                        .iter()
                        .any(|s| s.id == p.source_id && !shared_source(s))
                })
                .map(|p| p.project.clone()),
        );
        projects.sort();
        projects.dedup();
    }
    Ok(Lookup {
        enabled: true,
        exact,
        questions: ranked,
        passages,
        projects,
        ambiguous,
    })
}
pub fn same_question(a: &Question, b: &Question) -> bool {
    a.category == b.category
        && a.project == b.project
        && crate::knowledge_search::identity(&a.question) == crate::knowledge_search::identity(&b.question)
}
pub fn commit_questions(
    root: &Path,
    questions: Vec<Question>,
    merge_map: HashMap<String, String>,
) -> Result<Snapshot, String> {
    let mut bank = self::questions(root).0;
    let mut pending = questions;
    for q in &pending {
        validate_question(q)?;
    }
    let mut changed = HashSet::new();
    let mut resolved = HashMap::<String, String>::new();
    // Resolve dependencies and validate the entire preview before any write.
    while !pending.is_empty() {
        let before = pending.len();
        let mut next = Vec::new();
        for mut q in pending {
            let requested = merge_map
                .get(&q.id)
                .map(|id| resolved.get(id).unwrap_or(id));
            let target = requested
                .and_then(|id| bank.iter().position(|p| &p.id == id))
                .or_else(|| {
                    if requested.is_none() {
                        bank.iter()
                            .position(|p| p.id == q.id || same_question(p, &q))
                    } else {
                        None
                    }
                });
            if requested.is_some() && target.is_none() {
                next.push(q);
                continue;
            }
            if let Some(i) = target {
                let parent = &mut bank[i];
                let history_repeat = parent.id == q.id
                    && parent.origins.iter().any(|a| {
                        q.origins
                            .iter()
                            .any(|b| a.session_id == b.session_id && a.entry_id == b.entry_id)
                    });
                if !history_repeat && (parent.project != q.project || parent.category != q.category)
                {
                    return Err("不能把不同项目或分类的问题合并".into());
                }
                if !parent.task.is_empty() && !q.task.is_empty() && parent.task != q.task {
                    return Err("任务不同，应保留为关联追问".into());
                }
                if q.question != parent.question && !parent.aliases.contains(&q.question) {
                    parent.aliases.push(q.question.clone());
                }
                for a in q.aliases {
                    if a != parent.question && !parent.aliases.contains(&a) {
                        parent.aliases.push(a);
                    }
                }
                for o in q.origins {
                    if !parent
                        .origins
                        .iter()
                        .any(|r| r.session_id == o.session_id && r.entry_id == o.entry_id)
                    {
                        parent.origins.push(o);
                    }
                }
                resolved.insert(q.id.clone(), parent.id.clone());
                changed.insert(parent.id.clone());
            } else {
                q.status = if q.status == "confirmed" {
                    "confirmed"
                } else {
                    "draft"
                }
                .into();
                changed.insert(q.id.clone());
                bank.push(q);
            }
        }
        if next.len() == before {
            return Err("合并目标未选择、不存在或形成循环，请检查整理预览".into());
        }
        pending = next;
    }
    for q in bank.into_iter().filter(|q| changed.contains(&q.id)) {
        save_question(root, q)?;
    }
    snapshot(root)
}
pub fn history_questions(value: &serde_json::Value) -> Vec<Question> {
    let sid = value["session"]["id"].as_str().unwrap_or_default();
    let mut out: Vec<Question> = Vec::new();
    for entry in value["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["kind"] == "question")
    {
        let text = entry["text"].as_str().unwrap_or_default().trim();
        if text.is_empty() {
            continue;
        }
        let origin = Origin {
            session_id: sid.into(),
            entry_id: entry["id"].as_str().unwrap_or_default().into(),
            at: entry["at"].as_str().unwrap_or_default().into(),
            original: text.into(),
        };
        let hash = Sha256::digest(format!("{sid}\n{}", origin.entry_id).as_bytes());
        let mut stable = [0; 16];
        stable.copy_from_slice(&hash[..16]);
        let mut q = Question {
            id: Uuid::from_bytes(stable).to_string(),
            category: "待分类".into(),
            question: text.into(),
            status: "draft".into(),
            answer_source: "history".into(),
            priority: 1,
            origins: vec![origin],
            ..Default::default()
        };
        if let Some(previous) = out.iter_mut().find(|p| same_question(p, &q)) {
            previous.origins.append(&mut q.origins);
        } else {
            out.push(q);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_project_import_keeps_nested_code_and_refresh_in_the_project() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("library");
        let a=temp.path().join("ProjectA");fs::create_dir_all(a.join("src")).unwrap();
        fs::write(a.join("report.md"),"# Report\nA evidence").unwrap();fs::write(a.join("src/model.py"),"def model(x):\n    return x\n").unwrap();
        let first=scan_project_folder(&root,&a,None,|_,_,_|{}).unwrap();assert_eq!(first.library.sources.len(),2);assert!(first.library.sources.iter().all(|s|s.project=="ProjectA"));
        let ids=first.library.sources.iter().map(|s|s.id.clone()).collect::<HashSet<_>>();
        let b=temp.path().join("ProjectB");fs::create_dir_all(&b).unwrap();fs::write(b.join("notes.txt"),"B evidence").unwrap();
        let second=scan_project_folder(&root,&b,Some("My B"),|_,_,_|{}).unwrap();assert_eq!(second.library.sources.len(),3);
        let mut lib=second.library;lib.sources.iter_mut().find(|s|s.path.ends_with("report.md")).unwrap().project="共享资料".into();save_library(&root,&lib).unwrap();
        fs::write(a.join("src/new.py"),"def new(x):\n    return x + 1\n").unwrap();
        let refreshed=scan_with_mode(&root,&a,"auto",|_,_,_|{}).unwrap();assert_eq!(refreshed.library.sources.len(),4);
        assert!(ids.iter().all(|id|refreshed.library.sources.iter().any(|s|&s.id==id)));
        assert_eq!(refreshed.library.sources.iter().find(|s|s.path.ends_with("new.py")).unwrap().project,"ProjectA");
        assert_eq!(refreshed.library.sources.iter().find(|s|s.path.ends_with("report.md")).unwrap().project,"共享资料");
        assert_eq!(refreshed.library.sources.iter().find(|s|s.path.ends_with("notes.txt")).unwrap().project,"My B");
        let bytes=fs::read(root.join("library.json")).unwrap();assert!(scan_project_folder(&root,&a,Some("bad\nproject"),|_,_,_|{}).is_err());assert_eq!(fs::read(root.join("library.json")).unwrap(),bytes);
    }
    #[test]
    fn missing_files_are_empty_but_wrong_shapes_are_not_silently_empty() {
        let dir=tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap().build_model,"current");
        assert!(load_inbox(dir.path()).unwrap().items.is_empty());
        for name in ["library.json","inbox.json"] { fs::write(dir.path().join(name),b"{}").unwrap(); }
        assert!(load(dir.path()).is_err());
        assert!(load_inbox(dir.path()).is_err());
        assert_eq!(fs::read(dir.path().join("inbox.json")).unwrap(),b"{}");
    }
    #[test]
    fn existing_unreadable_paths_report_failure_and_keep_the_original() {
        let dir=tempfile::tempdir().unwrap();
        for name in ["library.json","inbox.json"] { fs::create_dir(dir.path().join(name)).unwrap(); }
        assert!(load(dir.path()).err().unwrap().contains("读取失败"));
        assert!(load_inbox(dir.path()).err().unwrap().contains("读取失败"));
        assert!(dir.path().join("inbox.json").is_dir());
    }
    #[test]
    fn legacy_optional_preferences_and_inbox_fields_remain_readable() {
        let dir=tempfile::tempdir().unwrap();
        fs::write(dir.path().join("library.json"),br#"{"sources":[]}"#).unwrap();
        fs::write(dir.path().join("inbox.json"),br#"{"items":[]}"#).unwrap();
        assert!(load(dir.path()).unwrap().sources.is_empty());
        assert!(load_inbox(dir.path()).unwrap().items.is_empty());
    }
    #[test]
    fn repeat_history_import_is_idempotent_and_keeps_edited_answer() {
        let dir = tempfile::tempdir().unwrap();
        let data = serde_json::json!({"session":{"id":"session"},"entries":[{"id":"a","kind":"question","text":"PPO 是什么"},{"id":"b","kind":"question","text":"PPO 是什么？"},{"id":"c","kind":"answer","text":"untrusted answer"}]});
        let first = history_questions(&data);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].origins.len(), 2);
        assert!(first[0].answer.is_empty());
        assert_eq!(first[0].id, history_questions(&data)[0].id);
        commit_questions(dir.path(), first.clone(), HashMap::new()).unwrap();
        let mut q = questions(dir.path()).0.remove(0);
        q.category = "技术基础".into();
        q.answer = "本人核对的回答".into();
        q.status = "confirmed".into();
        save_question(dir.path(), q).unwrap();
        let result =
            commit_questions(dir.path(), history_questions(&data), HashMap::new()).unwrap();
        assert_eq!(result.questions.len(), 1);
        assert_eq!(result.questions[0].answer, "本人核对的回答");
        assert_eq!(result.questions[0].status, "confirmed");
        assert_eq!(result.questions[0].origins.len(), 2);
    }
    #[test]
    fn multiple_similar_imports_resolve_to_one_root() {
        let dir = tempfile::tempdir().unwrap();
        let a = Question {
            id: Uuid::new_v4().to_string(),
            category: "技术基础".into(),
            question: "PPO 是什么".into(),
            answer: "已有标准回答".into(),
            status: "confirmed".into(),
            ..Default::default()
        };
        let mut b = a.clone();
        b.id = Uuid::new_v4().to_string();
        b.question = "解释 PPO".into();
        b.answer = "新草稿".into();
        let mut c = b.clone();
        c.id = Uuid::new_v4().to_string();
        c.question = "介绍 PPO 的定义".into();
        let map = HashMap::from([(b.id.clone(), a.id.clone()), (c.id.clone(), b.id.clone())]);
        let result = commit_questions(dir.path(), vec![c, b, a], map).unwrap();
        assert_eq!(result.questions.len(), 1);
        assert_eq!(result.questions[0].answer, "已有标准回答");
        assert_eq!(result.questions[0].aliases.len(), 2);
    }
    #[test]
    fn invalid_late_merge_does_not_partially_import() {
        let dir = tempfile::tempdir().unwrap();
        let a = Question {
            id: Uuid::new_v4().to_string(),
            category: "技术基础".into(),
            question: "PPO 是什么".into(),
            status: "draft".into(),
            ..Default::default()
        };
        let mut b = a.clone();
        b.id = Uuid::new_v4().to_string();
        b.question = "何时使用 PPO".into();
        let mut map = HashMap::new();
        map.insert(b.id.clone(), Uuid::new_v4().to_string());
        assert!(commit_questions(dir.path(), vec![a, b], map).is_err());
        assert!(questions(dir.path()).0.is_empty());
    }
    #[test]
    fn pending_manual_editor_and_api_draft_survive_reload() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = Inbox {
            editor: Some(Question {
                question: "尚未完成的手写问题".into(),
                ..Default::default()
            }),
            drafts: vec![serde_json::json!({"answer":"未采纳"})],
            ..Default::default()
        };
        save_inbox(dir.path(), &inbox).unwrap();
        let loaded = load_inbox(dir.path()).unwrap();
        assert_eq!(loaded.editor.unwrap().question, "尚未完成的手写问题");
        assert!(questions(dir.path()).0.is_empty());
        assert_eq!(loaded.drafts.len(), 1);
    }
    #[test]
    fn markdown_keeps_manual_answer_and_roundtrips() {
        let q = Question {
            id: Uuid::new_v4().to_string(),
            category: "项目问题".into(),
            project: "A".into(),
            question: "怎么实现？".into(),
            answer: "我实际使用 X\n\n公式 \\(x\\)".into(),
            explanation: "边界".into(),
            status: "confirmed".into(),
            ..Default::default()
        };
        let raw = question_markdown(&q).unwrap();
        let restored = parse_question(&raw).unwrap();
        assert_eq!(q.answer, restored.answer);
        assert_eq!(q.project, restored.project);
        let dir = tempfile::tempdir().unwrap();
        save_question(dir.path(), q.clone()).unwrap();
        save_question(dir.path(), q).unwrap();
        assert_eq!(questions(dir.path()).0.len(), 1);
        assert_eq!(fs::read_dir(dir.path().join("archive")).unwrap().count(), 1);
    }
    #[test]
    fn duplicates_preserve_project_and_task() {
        let mut a = Question {
            category: "项目问题".into(),
            project: "A".into(),
            question: "为什么用 PPO？".into(),
            ..Default::default()
        };
        let mut b = a.clone();
        b.project = "B".into();
        assert!(!same_question(&a, &b));
        b.project = "A".into();
        b.question = "PPO 是什么".into();
        assert!(!same_question(&a, &b));
        a.question = "为什么用ppo".into();
        b.question = "为什么用 PPO？".into();
        assert!(same_question(&a, &b));
    }
    #[test]
    fn chunks_follow_slide_and_function_boundaries() {
        let text = format!(
            "[幻灯片 1]\n{}\n[幻灯片 2]\n{}",
            "甲".repeat(400),
            "乙".repeat(400)
        );
        let c = chunks(&text);
        assert_eq!(c.len(), 2);
        assert!(c[0].0.contains("1"));
        assert!(c[1].0.contains("2"));
    }
    #[test]
    fn short_neighboring_sections_keep_their_own_heading_and_body() {
        let c=chunks("#### AD诊断\n五分类临床数据。\n#### 时钟同步预测\n预测NRR并滤波。\n");
        assert_eq!(c.len(),2);
        assert_eq!(c[0].0,"#### AD诊断");
        assert!(!c[0].1.contains("时钟同步"));
        assert_eq!(c[1].0,"#### 时钟同步预测");
        assert!(!c[1].1.contains("五分类"));
    }
    #[test]
    fn trigram_search_works_for_chinese_and_sources_changed_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("original.txt");
        fs::write(&file, "使用 PPO 算法和裁剪目标提高稳定性").unwrap();
        let id = Uuid::new_v4().to_string();
        atomic(
            &dir.path().join("sources").join(format!("{id}.txt")),
            "使用 PPO 算法和裁剪目标提高稳定性".as_bytes(),
        )
        .unwrap();
        let lib = Library {
            sources: vec![Source {
                id,
                path: file.to_string_lossy().into(),
                relative_path: "original.txt".into(),
                project: "A".into(),
                hash: "hash".into(),
                modified: stamp(&file),
                status: "ready".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        rebuild_index(dir.path(), &lib).unwrap();
        assert_eq!(
            retrieve(dir.path(), &lib, "PPO 为什么有裁剪目标", "A")
                .unwrap()
                .len(),
            1
        );
        let mut lib = lib;
        lib.sources[0].modified = 0;
        assert!(retrieve(dir.path(), &lib, "PPO", "A").unwrap().is_empty());
    }
}

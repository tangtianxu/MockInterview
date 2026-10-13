//! Native, read-only text extraction. Documents are data, never executable input.
use quick_xml::{events::Event, Reader};
use std::{fs, io::Read, path::Path};

pub fn is_text(ext: &str) -> bool {
    matches!(
        ext,
        "txt"
            | "m" | "ipynb" | "sql" | "cs" | "go" | "r" | "tex"
            | "md"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "py"
            | "cpp"
            | "c"
            | "h"
            | "hpp"
            | "rs"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "java"
            | "sh"
            | "ps1"
            | "launch"
            | "rviz"
            | "world"
            | "typ"
            | "toml"
            | "ini"
            | "cfg"
            | "pos"
    )
}
pub fn supported(ext: &str) -> bool {
    is_text(ext)
        || matches!(
            ext,
            "docx" | "pptx" | "xlsx" | "pdf" | "odt" | "odp" | "ods"
        )
}
pub fn decode(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(&[239, 187, 191]).unwrap_or(bytes);
    if bytes.starts_with(&[255, 254]) || bytes.starts_with(&[254, 255]) {
        let encoding = if bytes.starts_with(&[255, 254]) {
            encoding_rs::UTF_16LE
        } else {
            encoding_rs::UTF_16BE
        };
        let (text, _, bad) = encoding.decode(bytes);
        if !bad {
            return Ok(text.into_owned());
        }
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_string());
    }
    let (text, _, bad) = encoding_rs::GB18030.decode(bytes);
    if bad {
        Err("文字编码无法识别".into())
    } else {
        Ok(text.into_owned())
    }
}
fn member(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Result<String, String> {
    let mut file = archive.by_name(name).map_err(|e| e.to_string())?;
    if file.size() > 32 * 1024 * 1024 {
        return Err(format!("文档内部 {name} 超过 32 MiB"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(text)
}
pub fn xml_text(xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut result = String::new();
    let mut stack = Vec::new();
    loop {
        match reader
            .read_event()
            .map_err(|e| format!("文档 XML 无效：{e}"))?
        {
            Event::Start(e) => {
                let name = e.local_name();
                stack.push(
                    matches!(name.as_ref(), b"t" | b"p" | b"h" | b"span")
                        || stack.last().copied().unwrap_or(false),
                );
            }
            Event::Text(e) if stack.last().copied().unwrap_or(false) => {
                result.push_str(&e.unescape().map_err(|e| e.to_string())?)
            }
            Event::End(e) => {
                let name = e.local_name();
                if matches!(name.as_ref(), b"p" | b"h" | b"tr" | b"table-row") {
                    result.push('\n');
                } else if matches!(name.as_ref(), b"tc" | b"table-cell") {
                    result.push('\t');
                }
                stack.pop();
            }
            Event::Empty(e) if matches!(e.local_name().as_ref(), b"br" | b"line-break") => {
                result.push('\n')
            }
            Event::Empty(e) if e.local_name().as_ref() == b"tab" => result.push('\t'),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(result)
}
fn attributes(e: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> String {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
        .unwrap_or_default()
}
fn relations(xml: &str) -> Result<Vec<(String, String)>, String> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Empty(e) | Event::Start(e) if e.local_name().as_ref() == b"Relationship" => {
                out.push((attributes(&e, b"Id"), attributes(&e, b"Target")))
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}
fn ids(xml: &str, element: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Empty(e) | Event::Start(e) if e.local_name().as_ref() == element => {
                out.push((attributes(&e, b"r:id"), attributes(&e, b"name")))
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}
fn shared_strings(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut list = Vec::new();
    let mut item = String::new();
    let mut capture = false;
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => {
                if e.local_name().as_ref() == b"si" {
                    item.clear();
                }
                capture = e.local_name().as_ref() == b"t";
            }
            Event::Text(e) if capture => item.push_str(&e.unescape().map_err(|e| e.to_string())?),
            Event::End(e) => {
                if e.local_name().as_ref() == b"si" {
                    list.push(item.clone());
                }
                capture = false;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(list)
}
fn sheet_text(xml: &str, strings: &[String]) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let (mut cell, mut kind, mut value, mut formula) =
        (String::new(), String::new(), String::new(), String::new());
    let mut tag = String::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => {
                tag = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                if tag == "c" {
                    cell = attributes(&e, b"r");
                    kind = attributes(&e, b"t");
                    value.clear();
                    formula.clear();
                }
            }
            Event::Text(e) => {
                let text = e.unescape().map_err(|e| e.to_string())?;
                match tag.as_str() {
                    "v" | "t" => value.push_str(&text),
                    "f" => formula.push_str(&text),
                    _ => {}
                }
            }
            Event::End(e) => {
                if e.local_name().as_ref() == b"c" {
                    let text = if kind == "s" {
                        value
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| strings.get(i))
                            .cloned()
                            .ok_or_else(|| {
                                format!("单元格 {cell} 的共享字符串索引无效，未用索引数字代替原文")
                            })?
                    } else {
                        value.clone()
                    };
                    if !text.is_empty() || !formula.is_empty() {
                        out.push_str(&format!(
                            "{cell}: {text}{}\t",
                            if formula.is_empty() {
                                String::new()
                            } else {
                                format!(" [公式 {formula}]")
                            }
                        ));
                    }
                }
                if e.local_name().as_ref() == b"row" {
                    out.push('\n');
                }
                tag.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}
fn worksheet_text(
    archive: &mut zip::ZipArchive<fs::File>,
    name: &str,
    strings: &[String],
) -> Result<String, String> {
    let file = archive.by_name(name).map_err(|e| e.to_string())?;
    if file.size() <= 32 * 1024 * 1024 {
        drop(file);
        return sheet_text(&member(archive, name)?, strings);
    }
    // Large experiment datasets need schema and examples, not millions of
    // numeric cells. Stream bounded rows instead of decompressing the whole ZIP.
    let mut reader = Reader::from_reader(std::io::BufReader::new(file.take(8 * 1024 * 1024)));
    let mut buffer = Vec::new();
    let mut raw = String::new();
    let mut rows = 0;
    let mut writer = quick_xml::Writer::new(Vec::new());
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| format!("大型工作表前段解析失败：{e}"))?;
        match &event {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"dimension" => {
                raw = format!("[数据范围 {}]\n", attributes(e, b"ref"))
            }
            Event::End(e) if e.local_name().as_ref() == b"row" => rows += 1,
            Event::Eof => break,
            _ => {}
        }
        writer.write_event(event).map_err(|e| e.to_string())?;
        buffer.clear();
        if rows >= 21 {
            break;
        }
    }
    let partial = String::from_utf8(writer.into_inner()).map_err(|e| e.to_string())?;
    let mut reader = Reader::from_str(&partial);
    let mut stack = Vec::new();
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => stack.push(String::from_utf8_lossy(e.name().as_ref()).into_owned()),
            Event::End(_) => {
                stack.pop();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let closed = format!(
        "{partial}{}",
        stack
            .iter()
            .rev()
            .map(|tag| format!("</{tag}>"))
            .collect::<String>()
    );
    Ok(format!(
        "[大型数据表：仅提取前 {rows} 行字段与样例，未读取全表，不能推断统计结果]\n{raw}{}",
        sheet_text(&closed, strings)?
    ))
}
pub fn extract(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if is_text(&ext) {
        let text = decode(&fs::read(path).map_err(|e| e.to_string())?)?;
        if ext == "csv" {
            let count = text.lines().count();
            return Ok(format!(
                "[数据表字段与前 20 行样例 · 总文本行数 {count}，不代表统计结论]\n{}",
                text.lines().take(21).collect::<Vec<_>>().join("\n")
            ));
        }
        if !matches!(ext.as_str(), "txt" | "md" | "html" | "htm") {
            return Ok(text
                .lines()
                .enumerate()
                .map(|(i, line)| {
                    let trimmed = line.trim_start();
                    let boundary = trimmed.starts_with("def ")
                        || trimmed.starts_with("async def ")
                        || trimmed.starts_with("class ")
                        || trimmed.starts_with("pub fn ")
                        || trimmed.starts_with("fn ")
                        || trimmed.starts_with("function ");
                    let marker = if boundary {
                        format!(
                            "[实现单元：原始行 {} · {}]\n",
                            i + 1,
                            trimmed.chars().take(110).collect::<String>()
                        )
                    } else {
                        String::new()
                    };
                    format!("{marker}{:05} | {}", i + 1, line)
                })
                .collect::<Vec<_>>()
                .join("\n"));
        }
        return Ok(text);
    }
    if ext == "pdf" {
        return match pdf_extract::extract_text_by_pages(path) {
            Ok(pages) if pages.iter().any(|t| !t.trim().is_empty()) => Ok(pages
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    format!(
                        "[PDF 第 {} 页]\n{}",
                        i + 1,
                        if t.trim().is_empty() {
                            "[没有文字层，需视觉识别]"
                        } else {
                            t
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n")),
            _ => crate::context::pdf_extractor::extract_text_from_pdf(&path.to_string_lossy()),
        };
    }
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    match ext.as_str(){
        "docx"=>xml_text(&member(&mut archive,"word/document.xml")?),
        "odt"|"odp"|"ods"=>xml_text(&member(&mut archive,"content.xml")?),
        "pptx"=>{let relationships=relations(&member(&mut archive,"ppt/_rels/presentation.xml.rels")?)?;let ordered=ids(&member(&mut archive,"ppt/presentation.xml")?,b"sldId")?;let mut pages=Vec::new();
            for (i,(id,_)) in ordered.iter().enumerate(){let target=relationships.iter().find(|(rid,_)|rid==id).map(|(_,t)|t).ok_or("幻灯片关系缺失")?;let name=if target.starts_with('/'){target.trim_start_matches('/').to_string()}else{format!("ppt/{target}")};let mut text=xml_text(&member(&mut archive,&name)?)?;
                let slide_file=name.rsplit('/').next().unwrap_or_default();let rel_name=format!("ppt/slides/_rels/{slide_file}.rels");if let Ok(rels)=member(&mut archive,&rel_name){for(_,note)in relations(&rels)?.into_iter().filter(|(_,t)|t.contains("notesSlide")){let note_name=format!("ppt/{}",note.trim_start_matches("../"));if let Ok(xml)=member(&mut archive,&note_name){text.push_str(&format!("\n[演讲备注]\n{}",xml_text(&xml)?));}}}
                pages.push(format!("[幻灯片 {}]\n{text}",i+1));}Ok(pages.join("\n\n"))},
        "xlsx"=>{let has_strings=archive.file_names().any(|name|name=="xl/sharedStrings.xml");let strings=if has_strings{shared_strings(&member(&mut archive,"xl/sharedStrings.xml")?)?}else{Vec::new()};let relationships=relations(&member(&mut archive,"xl/_rels/workbook.xml.rels")?)?;let sheets=ids(&member(&mut archive,"xl/workbook.xml")?,b"sheet")?;let mut pages=Vec::new();for(id,name)in sheets{let target=relationships.iter().find(|(rid,_)|rid==&id).map(|(_,t)|t).ok_or("工作表关系缺失")?;let path=if target.starts_with('/'){target.trim_start_matches('/').into()}else{format!("xl/{target}")};pages.push(format!("[工作表 {name}]\n{}",worksheet_text(&mut archive,&path,&strings)?));}Ok(pages.join("\n\n"))},
        _=>Err(format!("暂不支持 {ext}；旧 Office/WPS 原生格式请另存为 DOCX/PPTX/XLSX。扫描件与图中文字需视觉识别接口。"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mixed_odf_text_and_office_table_survive() {
        assert_eq!(xml_text("<root><p>前<span>中</span>后</p><tr><tc><p><r><t>甲 &amp; 乙</t></r></p></tc></tr></root>").unwrap(),"前中后\n甲 & 乙\n\t\n");
    }
    #[test]
    fn source_code_is_never_executed_and_preserves_functions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("danger.py");
        fs::write(
            &file,
            "import os\ndef dangerous():\n    raise Exception('never execute')\n",
        )
        .unwrap();
        let t = extract(&file).unwrap();
        assert!(t.contains("[实现单元：原始行 2"));
        assert!(t.contains("00003 |     raise"));
    }
    #[test]
    fn native_importers_accept_real_documents_when_requested() {
        let Some(folder) = std::env::var_os("MOCKINTERVIEW_KNOWLEDGE_TEST_FOLDER") else {
            return;
        };
        let mut checked = std::collections::HashSet::new();
        for entry in walkdir::WalkDir::new(folder)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
        {
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default();
            if matches!(ext, "docx" | "pptx" | "xlsx" | "pdf") && !checked.contains(ext) {
                let text = extract(entry.path()).unwrap();
                assert!(text.chars().count() > 20, "empty {ext}");
                if ext == "pptx" {
                    assert!(text.contains("[幻灯片 1]"));
                }
                if ext == "xlsx" {
                    assert!(text.contains("[工作表 "));
                }
                checked.insert(ext.to_string());
            }
        }
        assert_eq!(checked.len(), 4);
    }
}

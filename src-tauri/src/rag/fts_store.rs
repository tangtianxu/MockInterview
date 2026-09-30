use rusqlite::{params, Connection};

/// Perform a BM25-scored keyword search against the `rag_fts` FTS5 table.
///
/// - `conn`: SQLite connection with the `rag_fts` and `rag_chunks` tables
/// - `query`: raw search query text (will be sanitized for FTS5)
/// - `limit`: maximum number of results
///
/// Returns Vec of (chunk_id, bm25_score) ordered by relevance (lower BM25 = more relevant,
/// so we negate for ascending sort).
pub fn search_keywords(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, f64)>, String> {
    if query.chars().any(|ch| ('\u{3400}'..='\u{9fff}').contains(&ch)) {
        return search_chinese_bigrams(conn, query, limit);
    }
    let fts_query = prepare_fts_query(query);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let sql = "
        SELECT c.chunk_id, bm25(rag_fts) AS score
        FROM rag_fts f
        JOIN rag_chunks c ON c.rowid = f.rowid
        WHERE rag_fts MATCH ?1
        ORDER BY score
        LIMIT ?2
    ";

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("FTS query prepare failed: {}", e))?;

    let rows = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            let chunk_id: String = row.get(0)?;
            let score: f64 = row.get(1)?;
            Ok((chunk_id, score))
        })
        .map_err(|e| format!("FTS query execution failed: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        let (chunk_id, score) = row.map_err(|e| format!("FTS row read error: {}", e))?;
        // BM25 returns negative scores (more negative = more relevant);
        // negate to get positive scores where higher = more relevant
        results.push((chunk_id, -score));
    }

    Ok(results)
}

/// FTS5 unicode61 does not segment Chinese phrases. A bounded bigram overlap
/// fallback makes Chinese technical queries usable without a separate tokenizer.
fn search_chinese_bigrams(conn: &Connection, query: &str, limit: usize) -> Result<Vec<(String, f64)>, String> {
    use std::collections::HashSet;
    let chars: Vec<char> = query.chars().filter(|c| ('\u{3400}'..='\u{9fff}').contains(c)).collect();
    let grams: HashSet<String> = chars.windows(2).map(|pair| pair.iter().collect()).collect();
    if grams.is_empty() { return Ok(Vec::new()); }
    let mut stmt = conn.prepare("SELECT chunk_id,text FROM rag_chunks LIMIT 20000").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
    let mut scored = Vec::new();
    for row in rows {
        let (id,text)=row.map_err(|e| e.to_string())?;
        let count=grams.iter().filter(|gram|text.contains(gram.as_str())).count();
        if count>0 {scored.push((id,count as f64 / grams.len() as f64));}
    }
    scored.sort_by(|a,b| b.1.total_cmp(&a.1));
    scored.truncate(limit);
    Ok(scored)
}

/// Prepare a raw query string for FTS5 MATCH syntax.
///
/// Splits on whitespace, wraps each word in double quotes (escaping any
/// internal double quotes), and joins with " OR ".
fn prepare_fts_query(raw: &str) -> String {
    let words: Vec<String> = raw
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| {
            let escaped = w.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect();

    words.join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prepare_fts_query_basic() {
        let result = prepare_fts_query("hello world");
        assert_eq!(result, "\"hello\" OR \"world\"");
    }

    #[test]
    fn test_prepare_fts_query_single_word() {
        let result = prepare_fts_query("test");
        assert_eq!(result, "\"test\"");
    }

    #[test]
    fn test_prepare_fts_query_empty() {
        let result = prepare_fts_query("");
        assert_eq!(result, "");
    }

    #[test]
    fn test_prepare_fts_query_with_quotes() {
        let result = prepare_fts_query("say \"hello\"");
        assert_eq!(result, "\"say\" OR \"\"\"hello\"\"\"");
    }

    #[test]
    fn test_prepare_fts_query_extra_spaces() {
        let result = prepare_fts_query("  foo   bar  ");
        assert_eq!(result, "\"foo\" OR \"bar\"");
    }

    #[test]
    fn chinese_keyword_fallback_recalls_a_relevant_chunk() {
        let conn=Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute("INSERT INTO context_resources(id,name,file_type,file_path,size_bytes,token_count,preview,loaded_at) VALUES ('f','技术笔记','md','note.md',1,1,'','now')",[]).unwrap();
        conn.execute("INSERT INTO rag_chunks(chunk_id,file_id,chunk_index,text,token_count,source_type,created_at) VALUES ('c','f',0,'LoRA 通过低秩矩阵适配冻结权重',10,'file','now')",[]).unwrap();
        let result=search_keywords(&conn,"低秩矩阵为什么减少训练参数",5).unwrap();
        assert_eq!(result[0].0,"c");
    }
}

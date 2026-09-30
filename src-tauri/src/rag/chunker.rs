use crate::context::token_counter::count_tokens;

/// A single chunk produced by the text splitter.
#[derive(Debug, Clone)]
pub struct TextChunk {
    /// Zero-based index of this chunk in the sequence.
    pub index: usize,
    /// The chunk text content.
    pub text: String,
    /// Approximate token count for this chunk.
    pub token_count: usize,
    /// Start character offset in the original text.
    pub start_char: usize,
    /// End character offset (exclusive) in the original text.
    pub end_char: usize,
}

/// Default separator hierarchy for recursive character splitting.
const SEPARATORS: &[&str] = &["\n\n", "\n", "。", "？", "！", "；", "，", ". ", "? ", "! ", " "];

/// Split text into chunks using a recursive character text splitter.
///
/// - `chunk_size`: target maximum token count per chunk
/// - `chunk_overlap`: number of overlap tokens to prepend from the previous chunk
/// - `strategy`: splitting strategy name (currently only "recursive" is implemented)
///
/// Returns an empty Vec for empty input.
pub fn chunk_text(
    text: &str,
    chunk_size: usize,
    chunk_overlap: usize,
    _strategy: &str,
) -> Vec<TextChunk> {
    if text.is_empty() {
        return Vec::new();
    }

    // Reserve space for the overlap, so Chinese chunks stay near the requested
    // token budget even when a character is approximately one token.
    let reserved_overlap=chunk_overlap.min(chunk_size/2);
    let raw_chunks = recursive_split(text, chunk_size.saturating_sub(reserved_overlap).max(1), 0);

    if raw_chunks.is_empty() {
        return Vec::new();
    }

    // Apply overlap and build final TextChunk structs
    let mut result: Vec<TextChunk> = Vec::new();

    for (i, (chunk_text, start_char, end_char)) in raw_chunks.iter().enumerate() {
        let final_text = if i > 0 && chunk_overlap > 0 {
            // Grab overlap text from the end of the previous raw chunk
            let prev_text = &raw_chunks[i - 1].0;
            let overlap_text = extract_tail_by_tokens(prev_text, reserved_overlap);
            if overlap_text.is_empty() {
                chunk_text.clone()
            } else {
                // Preserve the exact source delimiter between adjacent raw
                // chunks. Without it, overlap can turn two separate source
                // statements into one unsupported-looking sentence.
                let previous_end=raw_chunks[i-1].2;
                let separator=text.get(previous_end..*start_char).unwrap_or("");
                format!("{}{}{}", overlap_text, separator, chunk_text)
            }
        } else {
            chunk_text.clone()
        };

        let token_count = count_tokens(&final_text);
        result.push(TextChunk {
            index: i,
            text: final_text,
            token_count,
            start_char: text[..*start_char].chars().count(),
            end_char: text[..*end_char].chars().count(),
        });
    }

    result
}

/// Recursively split text using the separator hierarchy.
/// Returns Vec of (text, start_char, end_char) tuples.
fn recursive_split(
    text: &str,
    chunk_size: usize,
    separator_idx: usize,
) -> Vec<(String, usize, usize)> {
    // Base case: text fits in one chunk or we've exhausted separators
    if separator_idx >= SEPARATORS.len() && count_tokens(text) > chunk_size {
        // A long Chinese sentence may contain no spaces or punctuation at all.
        let mut result = Vec::new();
        let mut start = 0;
        while start < text.len() {
            let mut end = start;
            for (offset, ch) in text[start..].char_indices() {
                let next = start + offset + ch.len_utf8();
                if count_tokens(&text[start..next]) > chunk_size.max(1) && end > start { break; }
                end = next;
            }
            if end == start { break; }
            result.push((text[start..end].to_string(), start, end));
            start = end;
        }
        return result;
    }
    if count_tokens(text) <= chunk_size || separator_idx >= SEPARATORS.len() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        return vec![(trimmed.to_string(), 0, text.len())];
    }

    let separator = SEPARATORS[separator_idx];
    let parts: Vec<&str> = text.split(separator).collect();

    // If splitting didn't help (only one part), try next separator
    if parts.len() <= 1 {
        return recursive_split(text, chunk_size, separator_idx + 1);
    }

    let mut result: Vec<(String, usize, usize)> = Vec::new();
    let mut current_parts: Vec<&str> = Vec::new();
    let mut current_start: usize = 0;
    let mut byte_offset: usize = 0;

    for (i, part) in parts.iter().enumerate() {
        if count_tokens(part) > chunk_size {
            if !current_parts.is_empty() {
                let combined=current_parts.join(separator);
                if !combined.trim().is_empty() {
                    result.push((combined.trim().to_string(),current_start,current_start+combined.len()));
                }
                current_parts.clear();
            }
            for (sub_text,sub_start,sub_end) in recursive_split(part,chunk_size,separator_idx+1) {
                result.push((sub_text,byte_offset+sub_start,byte_offset+sub_end));
            }
        } else {
            let candidate=if current_parts.is_empty() {part.to_string()} else {format!("{}{}{}",current_parts.join(separator),separator,part)};
            if !current_parts.is_empty() && count_tokens(&candidate)>chunk_size {
                let combined=current_parts.join(separator);
                if !combined.trim().is_empty() {
                    result.push((combined.trim().to_string(),current_start,current_start+combined.len()));
                }
                current_parts.clear();
            }
            if current_parts.is_empty() {current_start=byte_offset;}
            current_parts.push(part);
        }
        byte_offset += part.len();
        if i<parts.len()-1 {byte_offset += separator.len();}
    }
    if !current_parts.is_empty() {
        let combined=current_parts.join(separator);
        if !combined.trim().is_empty() {
            result.push((combined.trim().to_string(),current_start,current_start+combined.len()));
        }
    }

    result
}

/// Extract the last N tokens worth of text from a string.
fn extract_tail_by_tokens(text: &str, target_tokens: usize) -> String {
    if target_tokens == 0 || text.is_empty() {
        return String::new();
    }

    let chars: Vec<char> = text.chars().collect();
    let mut start=chars.len();
    while start>0 {
        let candidate: String=chars[start-1..].iter().collect();
        if count_tokens(&candidate)>target_tokens {break;}
        start-=1;
    }
    chars[start..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_input() {
        let chunks = chunk_text("", 100, 10, "recursive");
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_small_text_single_chunk() {
        let chunks = chunk_text("Hello world", 100, 10, "recursive");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].index, 0);
        assert_eq!(chunks[0].text, "Hello world");
    }

    #[test]
    fn test_paragraph_splitting() {
        let text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
        let chunks = chunk_text(text, 8, 0, "recursive");
        assert!(chunks.len() >= 2);
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.index, i);
            assert!(!chunk.text.is_empty());
        }
    }

    #[test]
    fn test_chunk_indices_sequential() {
        let text = "A.\n\nB.\n\nC.\n\nD.\n\nE.";
        let chunks = chunk_text(text, 2, 0, "recursive");
        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.index, i);
        }
    }

    #[test]
    fn chinese_unpunctuated_text_has_bounded_chunks() {
        let text = "检索增强生成".repeat(120);
        let chunks = chunk_text(&text, 40, 0, "recursive");
        assert!(chunks.len() > 2);
        assert!(chunks.iter().all(|c| c.token_count <= 40));
    }
    #[test]
    fn chinese_mixed_paragraphs_stay_bounded_and_offsets_are_characters() {
        let text=format!("{}。\n{}。", "检索增强生成".repeat(50), "向量索引排序".repeat(50));
        let chunks=chunk_text(&text,32,0,"recursive");
        assert!(chunks.iter().all(|c|c.token_count<=32));
        assert!(chunks.iter().all(|c|c.end_char<=text.chars().count()));
    }
    #[test]
    fn chinese_overlap_respects_requested_budget() {
        let text="检索增强生成".repeat(80);
        let chunks=chunk_text(&text,40,8,"recursive");
        assert!(chunks.len()>2);
        assert!(chunks.iter().all(|c|c.token_count<=40));
    }
    #[test]
    fn overlap_keeps_original_paragraph_boundary() {
        let text="第一作者 审稿中\n\n针对边云协同推理的通信瓶颈，提出视觉特征编码方法。";
        let chunks=chunk_text(text,25,6,"recursive");
        assert!(chunks.iter().any(|chunk|chunk.text.contains("审稿中\n\n针对")));
        assert!(chunks.iter().all(|chunk|!chunk.text.contains("审稿中针对")));
    }
}

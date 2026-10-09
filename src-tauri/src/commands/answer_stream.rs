//! Decode text only after a complete byte line, then verify the provider's ending.
pub(super) fn finish_error(reason: &str) -> Option<&'static str> {
    match reason {
        "length" | "max_tokens" => Some("回答达到模型输出上限，内容未生成完；请点击问题框缩小问题范围或重新生成。"),
        "content_filter" => Some("回答服务提前停止了内容生成；请修改问题后重试。"),
        "tool_calls" | "function_call" => Some("回答模型返回了工具调用，没有完成文本回答；请更换模型或重试。"),
        _ => None,
    }
}

pub(super) struct AnswerStream {
    ollama: bool,
    pending: Vec<u8>,
    ended: bool,
    error: Option<&'static str>,
}

impl AnswerStream {
    pub fn new(ollama: bool) -> Self {
        Self { ollama, pending: Vec::new(), ended: false, error: None }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut tokens = Vec::new();
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<_> = self.pending.drain(..=index).collect();
            self.line(&line, &mut tokens);
        }
        tokens
    }

    pub fn flush(&mut self) -> Vec<String> {
        let line = std::mem::take(&mut self.pending);
        let mut tokens = Vec::new();
        self.line(&line, &mut tokens);
        tokens
    }

    pub fn is_finished(&self) -> bool { self.ended }

    pub fn outcome(&self) -> Result<(), String> {
        if let Some(error) = self.error { return Err(error.into()); }
        if !self.ended {
            return Err("回答连接提前结束，已收到的内容可能不完整；请点击问题框重新生成。".into());
        }
        Ok(())
    }

    fn line(&mut self, bytes: &[u8], tokens: &mut Vec<String>) {
        let line = match std::str::from_utf8(bytes) {
            Ok(line) => line.trim(),
            Err(_) => { self.error.get_or_insert("回答服务返回了无效文字编码，内容可能不完整。请重新生成。"); return; }
        };
        let data = if self.ollama { line } else {
            match line.strip_prefix("data:") { Some(data) => data.trim(), None => return }
        };
        if data.is_empty() { return; }
        if data == "[DONE]" { self.ended = true; return; }
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(value) => value,
            Err(_) => { self.error.get_or_insert("回答流格式异常，已收到的内容可能不完整；请重新生成。"); return; }
        };
        if !value["error"].is_null() {
            self.error.get_or_insert("回答服务返回错误，内容未生成完；请检查模型连接后重试。");
        }
        let token = if self.ollama { value["message"]["content"].as_str() }
            else { value["choices"][0]["delta"]["content"].as_str() };
        if let Some(token) = token.filter(|token| !token.is_empty()) { tokens.push(token.into()); }
        let reason = if self.ollama {
            if value["done"].as_bool() == Some(true) { self.ended = true; }
            value["done_reason"].as_str()
        } else { value["choices"][0]["finish_reason"].as_str() };
        if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
            self.ended = true;
            if let Some(error) = finish_error(reason) { self.error.get_or_insert(error); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AnswerStream;

    #[test]
    fn split_utf8_and_unterminated_final_line_are_preserved() {
        let text = "data: {\"choices\":[{\"delta\":{\"content\":\"原理：优势函数。\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"最后一句。\"},\"finish_reason\":\"stop\"}]}";
        let mut stream = AnswerStream::new(false);
        let mut tokens = Vec::new();
        for byte in text.as_bytes() { tokens.extend(stream.push(&[*byte])); }
        tokens.extend(stream.flush());
        assert_eq!(tokens.concat(), "原理：优势函数。最后一句。");
        assert!(stream.outcome().is_ok());
    }

    #[test]
    fn output_limit_is_not_success_even_with_done_sentinel() {
        let mut stream = AnswerStream::new(false);
        assert!(!stream.is_finished());
        assert_eq!(stream.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n").concat(), "partial");
        assert!(stream.is_finished());
        assert!(stream.outcome().unwrap_err().contains("输出上限"));
    }

    #[test]
    fn ollama_end_reason_and_final_token_are_checked() {
        let mut stream = AnswerStream::new(true);
        assert_eq!(stream.push(b"{\"message\":{\"content\":\"tail\"},\"done\":true,\"done_reason\":\"length\"}\n").concat(), "tail");
        assert!(stream.outcome().is_err());
        let mut complete = AnswerStream::new(true);
        complete.push(b"{\"message\":{\"content\":\"done\"},\"done\":true,\"done_reason\":\"stop\"}\n");
        assert!(complete.outcome().is_ok());
    }

    #[test]
    fn interrupted_and_malformed_streams_are_errors() {
        let mut stream = AnswerStream::new(false);
        stream.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n");
        assert!(stream.outcome().is_err());
        stream.push(b"data: invalid\n\ndata: [DONE]\n");
        assert!(stream.outcome().is_err());
    }

    #[test]
    fn compatible_sse_sentinel_and_provider_error() {
        let mut stream = AnswerStream::new(false);
        stream.push(b": keepalive\nevent: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"text\"}}]}\ndata: [DONE]\n");
        assert!(stream.outcome().is_ok());
        let mut stream = AnswerStream::new(false);
        stream.push(b"data: {\"error\":{\"message\":\"private upstream data\"}}\ndata: [DONE]\n");
        let error = stream.outcome().unwrap_err();
        assert!(!error.contains("private upstream data"));
    }
}

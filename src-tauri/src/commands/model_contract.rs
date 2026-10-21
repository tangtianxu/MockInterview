//! Native function calling for APIs, schema constrained output for Ollama.
//! A contract is parsed once, never repaired by silently issuing paid retries.
use serde_json::{json, Value};
pub fn body(
    api: &str,
    model: &str,
    name: &str,
    system: &str,
    user: &str,
    schema: Value,
    budget: u32,
) -> Value {
    let messages = json!([{"role":"system","content":system},{"role":"user","content":user}]);
    if api == "ollama" {
        return json!({"model":model,"messages":messages,"stream":false,"think":false,
        "format":schema,"options":{"temperature":0,"num_predict":budget}});
    }
    let mut body = json!({"model":model,"messages":messages,"stream":false,"max_tokens":budget,
        "tools":[{"type":"function","function":{"name":name,"description":"Submit the validated structured operation.","parameters":schema}}],
        "tool_choice":{"type":"function","function":{"name":name}}});
    if api == "deepseek" {
        body["thinking"] = json!({"type":"disabled"});
    } else {
        body["temperature"] = json!(0);
    }
    body
}
pub fn parse(api: &str, name: &str, response: &Value) -> Result<Value, String> {
    if api == "ollama" {
        if response["done_reason"] == "length" {
            return Err("模型结构化输出达到上限".into());
        }
        return serde_json::from_str(
            response["message"]["content"]
                .as_str()
                .ok_or("本地模型未返回结构化结果")?,
        )
        .map_err(|e| e.to_string());
    }
    let choice = &response["choices"][0];
    if choice["finish_reason"] == "length" {
        return Err("模型结构化输出达到上限".into());
    }
    let calls = choice["message"]["tool_calls"]
        .as_array()
        .ok_or("此接口没有返回函数调用结果；请使用支持 Tool Calling 的模型")?;
    if calls.len() != 1 || calls[0]["function"]["name"] != name {
        return Err("模型返回了非预期的函数调用".into());
    }
    serde_json::from_str(
        calls[0]["function"]["arguments"]
            .as_str()
            .ok_or("函数调用缺少参数")?,
    )
    .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_call_only_and_no_truncated_arguments() {
        let good = json!({"choices":[{"message":{"tool_calls":[{"function":{"name":"submit_task","arguments":"{\"ok\":true}"}}]},"finish_reason":"tool_calls"}]});
        assert_eq!(parse("deepseek", "submit_task", &good).unwrap()["ok"], true);
        assert!(parse("deepseek", "other", &good).is_err());
        let mut cut = good.clone();
        cut["choices"][0]["finish_reason"] = json!("length");
        assert!(parse("deepseek", "submit_task", &cut).is_err());
    }
}

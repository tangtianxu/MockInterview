//! Provider-specific wire options, scoped to explicit official destinations.
use serde_json::{json, Value};
pub fn body(base: &str, model: &str, mut value: Value) -> Value {
    let host = url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    let qwen = host == "dashscope.aliyuncs.com"
        || host == "dashscope-intl.aliyuncs.com"
        || host.ends_with(".maas.aliyuncs.com");
    if qwen
        && (model.starts_with("qwen3")
            || ["qwen-plus", "qwen-flash", "qwen-turbo"]
                .iter()
                .any(|m| model.starts_with(m)))
    {
        value["enable_thinking"] = json!(false);
    }
    if host == "open.bigmodel.cn" {
        if value["temperature"] == 0 {
            value["temperature"] = json!(0.1);
        }
        if ["glm-4.5", "glm-4.6", "glm-4.7", "glm-5"]
            .iter()
            .any(|m| model.starts_with(m))
        {
            value["thinking"] = json!({"type":"disabled"});
        }
    }
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_compatibility_does_not_leak_options_to_other_services() {
        let b = json!({"temperature":0,"max_tokens":6144});
        assert_eq!(
            body("https://api.deepseek.com", "deepseek-flash", b.clone()),
            b
        );
        assert_eq!(
            body(
                "https://fake.example/maas.aliyuncs.com",
                "qwen-plus",
                b.clone()
            ),
            b
        );
        assert_eq!(
            body(
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "qwen-plus",
                b.clone()
            )["enable_thinking"],
            false
        );
        let glm = body("https://open.bigmodel.cn/api/paas/v4", "glm-4.7-flash", b);
        assert_eq!(glm["temperature"], 0.1);
        assert_eq!(glm["thinking"]["type"], "disabled");
    }
}

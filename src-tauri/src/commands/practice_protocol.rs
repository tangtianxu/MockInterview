//! Output validation for practice requests. Exact repetition is an engineering
//! guard; comparison of question meaning is performed by the selected model.
use serde_json::{json, Value};

pub fn question_key(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

pub fn repeated_question(question: &str, previous: &[String]) -> bool {
    let key = question_key(question);
    !key.is_empty() && previous.iter().any(|item| question_key(item) == key)
}

pub fn duplicate_index(value: &Value, count: usize) -> Result<Option<usize>, String> {
    match value.get("duplicateOf") {
        Some(Value::Null) => Ok(None),
        Some(item) => item.as_u64().filter(|index| *index < count as u64)
            .map(|index| Some(index as usize)).ok_or("重复校验返回的题目索引无效".into()),
        None => Err("重复校验缺少 duplicateOf 字段".into()),
    }
}

fn short(value: &Value, field: &str, maximum: usize) -> String {
    value[field].as_str().unwrap_or_default().trim().chars().take(maximum).collect()
}

pub fn safe_feedback(result: &Value, answer: &str, kind: &str) -> Result<Value, String> {
    if !result["score"].as_i64().is_some_and(|score| (0..=5).contains(&score)) {
        return Err("练习评分必须是 0 到 5 的整数".into());
    }
    let evidence = result["evidence"].as_str().unwrap_or_default();
    let evidence = if !evidence.is_empty() && answer.contains(evidence) {
        evidence.chars().take(120).collect::<String>()
    } else { answer.chars().take(120).collect::<String>() };
    if kind == "technical" {
        let corrections = result["corrections"].as_array().ok_or("技术评价缺少 corrections 数组")?;
        let missing = result["missingPoints"].as_array().ok_or("技术评价缺少 missingPoints 数组")?;
        let corrections: Vec<Value> = corrections.iter().filter_map(|item| {
            let quote = item["quote"].as_str()?.trim();
            let explanation = short(item, "explanation", 240);
            let correct = short(item, "correct", 450);
            // No invented quotations or rewritten claims about the candidate.
            if quote.is_empty() || !answer.contains(quote) || explanation.is_empty() || correct.is_empty() {return None;}
            Some(json!({"quote":quote.chars().take(160).collect::<String>(),"explanation":explanation,"correct":correct}))
        }).take(3).collect();
        let mut seen = Vec::new();
        let missing: Vec<Value> = missing.iter().filter_map(|item| {
            let point = short(item, "point", 160);
            let explanation = short(item, "explanation", 450);
            let key = question_key(&point);
            if key.is_empty() || explanation.is_empty() || seen.contains(&key) { return None; }
            seen.push(key);
            Some(json!({"point":point,"explanation":explanation}))
        }).take(3).collect();
        Ok(json!({"score":result["score"],"evidence":evidence,"questionKind":"technical",
            "corrections":corrections,"missingPoints":missing,"missing":[]}))
    } else {
        // Project feedback retains a strict whitelist: no model-written project story.
        let allowed = ["definition", "mechanism", "tradeoff", "boundary", "role", "verification", "result", "uncertainty"];
        let mut seen = Vec::new();
        let missing: Vec<&str> = result["missing"].as_array().into_iter().flatten()
            .filter_map(Value::as_str).filter(|code| {
                if !allowed.contains(code) || seen.contains(code) {return false;}
                seen.push(*code);true
            }).take(3).collect();
        Ok(json!({"score":result["score"],"evidence":evidence,"questionKind":kind,
            "missing":missing,"corrections":[],"missingPoints":[]}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_repeat_ignores_only_formatting() {
        assert!(repeated_question("什么是 Redis？", &["什么是 redis ?".into()]));
        assert!(!repeated_question("Redis 的淘汰策略是什么？", &["什么是 Redis？".into()]));
        assert!(!repeated_question("新问题", &[]));
    }
    #[test]
    fn semantic_check_must_return_an_explicit_valid_result() {
        assert_eq!(duplicate_index(&json!({"duplicateOf":1}), 2).unwrap(), Some(1));
        assert_eq!(duplicate_index(&json!({"duplicateOf":null}), 2).unwrap(), None);
        assert!(duplicate_index(&json!({}), 2).is_err());
        assert!(duplicate_index(&json!({"duplicateOf":99}), 2).is_err());
    }
    #[test]
    fn technical_feedback_has_specific_gaps_and_verified_quotes() {
        let raw = json!({"score":3,"evidence":"不存在的回答", "missing":["verification"],
            "corrections":[{"quote":"所有状态都有专家数据","explanation":"覆盖范围不是完整的。","correct":"专家示范通常只覆盖部分状态。"},
                {"quote":"我使用了 DAgger","explanation":"捏造引用","correct":"捏造引用"}],
            "missingPoints":[{"point":"误差如何积累","explanation":"小误差改变后续访问的状态，使策略遇到训练覆盖不足的输入。"}],
            "betterAnswer":"我设计了某个未提供的机制"});
        let safe = safe_feedback(&raw, "所有状态都有专家数据", "technical").unwrap();
        assert_eq!(safe["corrections"].as_array().unwrap().len(), 1);
        assert_eq!(safe["missingPoints"][0]["point"], "误差如何积累");
        assert_eq!(safe["missing"], json!([]));
        assert_eq!(safe["evidence"], "所有状态都有专家数据");
        assert!(safe.get("betterAnswer").is_none());
        assert!(safe_feedback(&json!({"score":3}), "回答", "technical").is_err());
    }
    #[test]
    fn project_feedback_drops_fabricated_reference_answers() {
        let raw = json!({"score":3,"evidence":"我提到了拼接","missing":["mechanism","made_up","verification","verification"],
            "feedback":"我实现了未提到的同步机制","betterAnswer":"我设计了 50ms 动作对齐机制",
            "corrections":[{"quote":"我提到了拼接","correct":"我设计了同步机制"}]});
        let safe=safe_feedback(&raw,"我提到了拼接，但没有说明实现。","project").unwrap();
        assert_eq!(safe["missing"],json!(["mechanism","verification"]));
        assert_eq!(safe["corrections"],json!([]));
        assert!(safe.get("feedback").is_none());
        assert!(safe.get("betterAnswer").is_none());
    }
}

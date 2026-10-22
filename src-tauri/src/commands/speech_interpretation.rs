//! Bounded hypotheses, never automatic technical-word substitution.
use super::task_harness::{Evidence, Input};
use serde::Serialize;
use serde_json::Value;

pub fn repaired_request(evidence: &[Evidence], repairs: &Value) -> Option<String> {
    let rows = repairs.as_array()?;
    if rows.is_empty() || rows.len() > 4 {
        return None;
    }
    let mut replacements = std::collections::HashMap::<String, Vec<(usize, usize, String)>>::new();
    for row in rows {
        let id = row["turn_id"].as_str()?;
        let heard = row["heard"].as_str()?;
        let written = row["written"].as_str()?;
        if heard.is_empty()
            || written.is_empty()
            || heard.chars().count() > 24
            || written.chars().count() > 24
        {
            return None;
        }
        let source = evidence.iter().find(|e| e.turn_id == id)?;
        // No global replace: a repair names one unambiguous source occurrence.
        let spans = source.quote.match_indices(heard).collect::<Vec<_>>();
        if spans.len() != 1 {
            return None;
        }
        let digits = |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
        if !digits(heard).is_empty() && digits(heard) != digits(written) {
            return None;
        }
        if ["不", "没", "未", "无", "非"]
            .iter()
            .any(|n| heard.matches(n).count() != written.matches(n).count())
        {
            return None;
        }
        replacements.entry(id.into()).or_default().push((
            spans[0].0,
            spans[0].0 + heard.len(),
            written.into(),
        ));
    }
    let mut text = Vec::new();
    for e in evidence {
        let mut source = e.quote.clone();
        if let Some(edits) = replacements.get_mut(&e.turn_id) {
            edits.sort_by_key(|r| r.0);
            if edits.windows(2).any(|w| w[0].1 > w[1].0) {
                return None;
            }
            for (start, end, written) in edits.iter().rev() {
                source.replace_range(*start..*end, written);
            }
        }
        text.push(source);
    }
    let question = text.join("；");
    (question.chars().count() <= 600).then_some(question)
}

pub fn select_reading(value: &Value, count: usize) -> Result<usize, &'static str> {
    if value["request_state"] != "complete" {
        return Err("invalid_request_assessment");
    }
    let rows = value["scores"].as_array().ok_or("missing_reading_scores")?;
    if rows.len() != count {
        return Err("missing_reading_scores");
    }
    let mut seen = std::collections::HashSet::new();
    let mut ranked = Vec::new();
    for row in rows {
        let id = row["candidate_id"]
            .as_u64()
            .ok_or("invalid_candidate_selection")? as usize;
        let spoken = row["spoken_fit"]
            .as_u64()
            .filter(|v| *v <= 4)
            .ok_or("invalid_reading_score")?;
        let context = row["context_fit"]
            .as_u64()
            .filter(|v| *v <= 4)
            .ok_or("invalid_reading_score")?;
        let preserved = row["relations_preserved"]
            .as_bool()
            .ok_or("invalid_relation_assessment")?;
        if id >= count || !seen.insert(id) {
            return Err("invalid_candidate_selection");
        }
        if preserved && spoken > 0 {
            ranked.push((context * 2 + spoken, spoken, id));
        }
    }
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    ranked
        .first()
        .map(|r| r.2)
        .ok_or("task_relations_not_supported")
}

#[derive(Clone, Serialize)]
pub struct TermHint {
    pub heard: String,
    pub candidates: Vec<String>,
}

fn latin_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut start = None;
    let mut end = 0;
    for (i, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), '\0')))
    {
        if c.is_ascii_alphanumeric() || "._+-".contains(c) || ('\u{0370}'..='\u{03ff}').contains(&c)
        {
            start.get_or_insert(i);
            end = i + c.len_utf8();
        } else if c.is_whitespace() && start.is_some() {
            continue;
        } else if let Some(s) = start.take() {
            let folded = fold(&text[s..end]);
            if (2..=40).contains(&folded.chars().count()) {
                out.push((s, end, folded));
            }
        }
    }
    out
}

fn fold(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn distance(a: &str, b: &str) -> usize {
    let mut row: Vec<_> = (0..=b.chars().count()).collect();
    for (i, ac) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, bc) in b.chars().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (row[j] + 1)
                .min(old + 1)
                .min(diagonal + usize::from(ac != bc));
            diagonal = old;
        }
    }
    *row.last().unwrap()
}

pub fn term_hints(input: &Input) -> Vec<TermHint> {
    let mut result = Vec::new();
    for turn in input.turns.iter().filter(|t| t.current) {
        for (start, end, heard) in latin_spans(&turn.text) {
            if input.term_hints.iter().any(|t| fold(t) == heard)
                || result.iter().any(|h: &TermHint| fold(&h.heard) == heard)
            {
                continue;
            }
            let digits = |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
            let mut candidates: Vec<_> = input
                .term_hints
                .iter()
                .filter_map(|term| {
                    let canonical = fold(term);
                    // Versions, counts and signs are not speech aliases.
                    if digits(&canonical) != digits(&heard) {
                        return None;
                    }
                    let size = canonical.chars().count().max(heard.chars().count());
                    let score = 1.0 - distance(&heard, &canonical) as f64 / size.max(1) as f64;
                    (score >= 0.4).then_some((score, term.clone()))
                })
                .collect();
            candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
            if !candidates.is_empty() {
                result.push(TermHint {
                    heard: turn.text[start..end].into(),
                    candidates: candidates.into_iter().take(2).map(|v| v.1).collect(),
                });
            }
            if result.len() == 3 {
                return result;
            }
        }
    }
    result
}

pub fn substitute(question: &str, heard: &str, term: &str) -> Option<String> {
    let needle = fold(heard);
    let (start, end, _) = latin_spans(question)
        .into_iter()
        .find(|(_, _, value)| value == &needle)?;
    Some(format!(
        "{}{}{}",
        &question[..start],
        term,
        &question[end..]
    ))
}

/// General request grammar. It does not map technical names or guess a missing
/// predicate from a subject-only fragment. Speaker/negation stay with the model.
pub fn has_request_operator(text: &str) -> bool {
    const CUES: &[&str] = &[
        "请",
        "介绍",
        "讲",
        "说说",
        "说一下",
        "说下",
        "谈谈",
        "解释",
        "阐述",
        "比较",
        "区别",
        "差异",
        "如何",
        "怎么",
        "怎样",
        "什么",
        "为何",
        "为啥",
        "为什么",
        "哪个",
        "哪些",
        "哪种",
        "几种",
        "多少",
        "吗",
        "么",
        "呢",
        "是否",
        "能否",
        "可否",
        "有无",
        "有没有",
        "对不对",
        "是吧",
        "对吧",
        "实现",
        "写出",
        "写下",
        "写一下",
        "写个",
        "写段",
        "手写",
        "编写",
        "补全",
        "分析",
        "评价",
        "举例",
        "推导",
        "证明",
        "设计",
        "计算",
        "展开",
        "继续",
        "优化",
        "解决",
        "?",
        "？",
    ];
    let lower = text.to_lowercase();
    CUES.iter().any(|cue| text.contains(cue))
        || [
            "what ",
            "why ",
            "how ",
            "which ",
            "when ",
            "where ",
            "explain ",
            "describe ",
            "implement ",
            "write ",
            "compare ",
            "could you ",
            "can you ",
            "do you ",
            "is it ",
        ]
        .iter()
        .any(|cue| lower.contains(cue))
}

pub fn pending(input: &Input) -> Vec<Evidence> {
    let now = input
        .turns
        .iter()
        .filter(|t| t.current)
        .map(|t| t.timestamp_ms)
        .fold(0.0, f64::max);
    input
        .pending_evidence
        .iter()
        .filter(|e| {
            input.turns.iter().any(|t| {
                t.id == e.turn_id
                    && t.text == e.quote
                    && !(input.mode == "live" && t.channel == "microphone")
                    && (now == 0.0
                        || t.timestamp_ms == 0.0
                        || (0.0..=20000.0).contains(&(now - t.timestamp_ms)))
                    && !input.turns.iter().any(|other| {
                        input.mode == "live"
                            && other.channel == "microphone"
                            && other.timestamp_ms > t.timestamp_ms
                            && other.timestamp_ms < now
                    })
            })
        })
        .cloned()
        .take(4)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::task_harness::Turn;
    #[test]
    fn source_edits_keep_unedited_scope_and_reject_ambiguous_or_overlapping_spans() {
        let source = vec![Evidence {
            turn_id: "a".into(),
            quote: "不要扩展范围，请解释ABXD的接口".into(),
        }];
        let mut edits = serde_json::json!([{"turn_id":"a","heard":"ABXD","written":"ABCD"}]);
        assert_eq!(
            repaired_request(&source, &edits),
            Some("不要扩展范围，请解释ABCD的接口".into())
        );
        edits[0]["heard"] = serde_json::json!("不要");
        edits[0]["written"] = serde_json::json!("要");
        assert!(repaired_request(&source, &edits).is_none());
        let e = serde_json::json!([{"turn_id":"a","heard":"ABXD","written":"ABCD"},{"turn_id":"a","heard":"BXD","written":"BCD"}]);
        assert!(repaired_request(&source, &e).is_none());
    }
    #[test]
    fn domain_plausibility_does_not_override_factual_relations() {
        let mut value = serde_json::json!({"request_state":"complete","scores":[
            {"candidate_id":0,"spoken_fit":4,"context_fit":0,"relations_preserved":true},
            {"candidate_id":1,"spoken_fit":3,"context_fit":4,"relations_preserved":true}]});
        assert_eq!(select_reading(&value, 2), Ok(1));
        value["scores"][1]["relations_preserved"] = serde_json::json!(false);
        assert_eq!(select_reading(&value, 2), Ok(0));
        value["scores"][1]["candidate_id"] = serde_json::json!(0);
        assert!(select_reading(&value, 2).is_err());
    }
    #[test]
    fn candidate_lattice_is_generic_and_never_changes_versions() {
        let i = Input {
            term_hints: vec!["ABCD".into(), "PPO".into(), "π0.5".into()],
            turns: vec![Turn {
                text: "解释ABXD、BPO和π0.6".into(),
                current: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let hints = term_hints(&i);
        assert!(hints
            .iter()
            .any(|h| h.heard == "ABXD" && h.candidates.contains(&"ABCD".into())));
        assert!(hints
            .iter()
            .any(|h| h.heard == "BPO" && h.candidates.contains(&"PPO".into())));
        assert!(!hints.iter().any(|h| h.heard == "π0.6"));
        assert_eq!(
            substitute("解释A B X D的机制", "ABXD", "ABCD"),
            Some("解释ABCD的机制".into())
        );
    }
    #[test]
    fn subjects_need_a_request_but_short_followups_keep_their_operator() {
        for s in ["你的传感器", "这个模型", "他的网络"] {
            assert!(!has_request_operator(s));
        }
        for s in [
            "那为什么呢",
            "它什么时候用",
            "介绍下网络",
            "Could you explain it?",
            "继续",
        ] {
            assert!(has_request_operator(s));
        }
    }
    #[test]
    fn pending_fragments_expire_and_cannot_cross_a_candidate_reply() {
        let mut i = Input {
            mode: "live".into(),
            pending_evidence: vec![Evidence {
                turn_id: "a".into(),
                quote: "请介绍".into(),
            }],
            turns: vec![
                Turn {
                    id: "a".into(),
                    text: "请介绍".into(),
                    timestamp_ms: 1000.0,
                    channel: "system".into(),
                    ..Default::default()
                },
                Turn {
                    id: "b".into(),
                    text: "这个模块".into(),
                    timestamp_ms: 3000.0,
                    current: true,
                    channel: "system".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(pending(&i).len(), 1);
        i.turns[1].timestamp_ms = 22000.0;
        assert!(pending(&i).is_empty());
        i.turns[1].timestamp_ms = 3000.0;
        i.turns.push(Turn {
            id: "reply".into(),
            channel: "microphone".into(),
            timestamp_ms: 2000.0,
            ..Default::default()
        });
        assert!(pending(&i).is_empty());
    }
}

//! Local Laya decision provider for the interview copilot.
//! The service is deliberately restricted to loopback; transcripts stay on device.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const LAYA_URL: &str = "http://127.0.0.1:8000/v1/systemone";
const OLLAMA_CHAT_URL: &str = "http://127.0.0.1:11434/api/chat";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewDecision {
    pub is_question: bool,
    pub question_complete: bool,
    pub is_followup: bool,
    pub category: String,
    pub next_action: String,
    /// Raw probability of showing a hint now. Calibration is external to the checkpoint.
    pub question_probability: f64,
    pub elapsed_ms: u128,
}

fn yes_probability(answers: &Value, key: &str) -> Result<f64, String> {
    answers
        .get(key)
        .and_then(|answer| answer.get("probabilities"))
        .and_then(|probabilities| probabilities.get("yes"))
        .and_then(Value::as_f64)
        .filter(|p| (0.0..=1.0).contains(p))
        .ok_or_else(|| format!("Laya response lacks a valid {key} probability"))
}

fn prior_dialogue<'a>(context:&'a str,candidate:&str)->&'a str {
    let trimmed=context.trim_end();
    if let Some((earlier,last))=trimmed.rsplit_once('\n') {
        let text=last.rsplit_once(':').map(|(_,text)|text.trim()).unwrap_or(last.trim());
        if !text.is_empty() && candidate.trim().ends_with(text) {return earlier;}
    }
    let text=trimmed.rsplit_once(':').map(|(_,text)|text.trim()).unwrap_or(trimmed);
    if !text.is_empty() && candidate.trim().ends_with(text) {return "";}
    context
}

pub async fn decide(
    context: &str,
    candidate: &str,
    previous_question: Option<&str>,
) -> Result<InterviewDecision, String> {
    let started = Instant::now();
    let state = format!(
        "Recent dialogue (speaker labels are authoritative):\n{}\n\nPrevious interviewer question: {}\nCurrent interviewer utterance: {}",
        prior_dialogue(context,candidate).chars().take(2500).collect::<String>(),
        previous_question.unwrap_or("none"),
        candidate.chars().take(600).collect::<String>(),
    );
    let body = json!({
        "model": "multilingual",
        "state": state,
        "questions": {
            "show_hint_now": {"type": "choice", "instructions": "Should the assistant display an answer hint to the candidate right now for this current interviewer utterance?", "criteria": {
                "yes": "A complete, answerable interviewer question or request has just been spoken and a new hint is useful now",
                "no": "The interviewer is still speaking, repeating the same question, acknowledging, commenting, or no answer hint is useful yet"
            }}
        }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(3500))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(LAYA_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Local Laya service unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Local Laya service returned HTTP {}",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid Laya response: {e}"))?;
    let answers = value.get("answers").ok_or("Laya response lacks answers")?;
    let question_probability = yes_probability(answers, "show_hint_now")?;
    // Keep the primary decision as one typed question. Additional simultaneous
    // heads caused strong positive bias in zero-shot probes, including statements.
    let lower = candidate.to_lowercase();
    let is_followup=previous_question.is_some() && ["那", "那么", "如果", "为什么", "还有", "具体", "what if", "then", "follow up", "how about"]
        .iter().any(|cue| lower.contains(cue));
    let category=match crate::intelligence::question_route::classify(candidate) {
        crate::intelligence::question_route::QuestionType::Technical=>"technical",
        crate::intelligence::question_route::QuestionType::Personal=>"resume",
        crate::intelligence::question_route::QuestionType::Mixed=>"mixed",
    }.to_string();
    let threshold = std::env::var("NEXQ_LAYA_DISPLAY_THRESHOLD").ok()
        .and_then(|v| v.parse::<f64>().ok()).filter(|v| (0.0..=1.0).contains(v))
        .unwrap_or(0.75);
    let next_action = if question_probability >= threshold { "generate" } else { "wait" }.to_string();
    Ok(InterviewDecision {
        // Provisional threshold. Set from an independent calibration set, never the test set.
        is_question: question_probability >= threshold,
        question_complete: question_probability >= threshold,
        is_followup,
        category,
        next_action,
        question_probability,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Adjudicate uncertain Laya outputs with the already loaded local answer model.
/// Keep this separate so Laya-only results remain observable for evaluation.
pub async fn confirm_with_qwen(context: &str, candidate: &str) -> Result<bool, String> {
    let system = "You classify one completed ASR utterance from an interviewer. \
        Return only JSON with boolean should_answer. True means the interviewer has made \
        a sufficiently complete question or request that calls for an answer from the candidate now. \
        False for acknowledgements, topic transitions, commentary, or incomplete fragments. \
        Treat Chinese and English equally. Do not answer the question.";
    let user = format!(
        "Recent dialogue:\n{}\n\nCurrent interviewer utterance: {}",
        prior_dialogue(context,candidate).chars().take(1500).collect::<String>(),
        candidate.chars().take(600).collect::<String>(),
    );
    let body = json!({
        "model": "qwen3:4b-instruct",
        "stream": false,
        "think": false,
        "format": "json",
        "keep_alive": "1h",
        "options": {"temperature": 0, "num_predict": 64},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(OLLAMA_CHAT_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Local Qwen decision unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Local Qwen decision returned HTTP {}",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid Qwen response: {e}"))?;
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .ok_or("Qwen response lacks message content")?;
    let decision: Value = serde_json::from_str(content)
        .map_err(|e| format!("Qwen decision was not valid JSON: {e}"))?;
    decision
        .get("should_answer")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Qwen decision lacks a boolean should_answer".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_and_invalid_probabilities() {
        let answers = json!({"is_question": {"probabilities": {"yes": 0.72}}});
        assert_eq!(yes_probability(&answers, "is_question").unwrap(), 0.72);
        assert!(yes_probability(&answers, "question_complete").is_err());
        assert!(yes_probability(
            &json!({"is_question": {"probabilities": {"yes": 1.4}}}),
            "is_question"
        )
        .is_err());
    }

    #[test]
    fn current_turn_is_not_repeated_in_model_state() {
        assert_eq!(prior_dialogue("[Interviewer]: 什么是 LoRA？","什么是 LoRA？"),"");
        assert_eq!(prior_dialogue("[Candidate]: 好的\n[Interviewer]: 什么是 LoRA？","什么是 LoRA？"),"[Candidate]: 好的");
    }
}

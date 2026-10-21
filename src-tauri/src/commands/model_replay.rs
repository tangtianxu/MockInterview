//! Opt-in paid evaluation. Uses the production schemas, parser and harness.
//! A reviewed immutable payload hash and a fresh local ledger are mandatory.
use super::{model_contract, task_harness};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[tokio::test]
#[ignore = "requires explicit consent for the hashed payload; calls paid API"]
async fn approved_dialogue_replay() {
    let path = PathBuf::from(std::env::var("MOCK_REPLAY_FILE").expect("reviewed replay file"));
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        crate::knowledge::digest(&bytes),
        std::env::var("MOCK_REPLAY_APPROVED_SHA256").expect("specific payload authorization")
    );
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    let api = fixture["api"].as_str().unwrap().to_string();
    assert!(
        api == "deepseek" && fixture["baseUrl"] == "https://api.deepseek.com"
            || api == "ollama" && fixture["baseUrl"] == "http://127.0.0.1:11434"
    );
    let report = PathBuf::from(std::env::var("MOCK_REPLAY_REPORT").expect("local report path"));
    assert!(
        !report.exists(),
        "A previous run exists: do not repeat requests without new consent"
    );
    let key = if api == "deepseek" {
        crate::credentials::CredentialManager::new()
            .get_key("interview_cue_answer@https://api.deepseek.com")
            .unwrap()
            .expect("saved API credential")
    } else {
        String::new()
    };
    let key = Arc::new(key);
    let ledger = Arc::new(Mutex::new(json!({"requests":[],"cases":[]})));
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none());
    let http = if api == "ollama" {
        builder.no_proxy()
    } else {
        builder
    }
    .build()
    .unwrap();
    let url = format!(
        "{}{}",
        fixture["baseUrl"].as_str().unwrap(),
        if api == "ollama" {
            "/api/chat"
        } else {
            "/chat/completions"
        }
    );
    let maximum = fixture["maxRequests"].as_u64().unwrap().min(20) as usize;
    let model = fixture["model"].as_str().unwrap().to_string();
    let persist =
        |state: &Value| std::fs::write(&report, serde_json::to_vec_pretty(state).unwrap()).unwrap();
    persist(&ledger.lock().unwrap());
    let call = |name: &'static str, system: &'static str, schema: Value, user: String| {
        let (http, key, ledger, model, report, api, url) = (
            http.clone(),
            key.clone(),
            ledger.clone(),
            model.clone(),
            report.clone(),
            api.clone(),
            url.clone(),
        );
        async move {
            let body = model_contract::body(&api, &model, name, system, &user, schema, 900);
            let index = {
                let mut s = ledger.lock().unwrap();
                let rows = s["requests"].as_array_mut().unwrap();
                if rows.len() >= maximum {
                    return Err("approved_request_budget_exhausted".into());
                }
                rows.push(json!({"stage":name,"bodyHash":crate::knowledge::digest(body.to_string().as_bytes()),"inputCharacters":user.chars().count(),"status":"started"}));
                let index = rows.len() - 1;
                std::fs::write(&report, serde_json::to_vec_pretty(&*s).unwrap()).unwrap();
                index
            };
            let started = Instant::now();
            let result = async {
                let request = http.post(url).json(&body);
                let request = if key.is_empty() {
                    request
                } else {
                    request.bearer_auth(&*key)
                };
                let r = request
                    .send()
                    .await
                    .map_err(|_| "transport_error".to_string())?;
                if !r.status().is_success() {
                    return Err(format!("http_{}", r.status().as_u16()));
                }
                r.json::<Value>()
                    .await
                    .map_err(|_| "invalid_response_body".to_string())
            }
            .await;
            let mut state = ledger.lock().unwrap();
            state["requests"][index]["elapsedMs"] = json!(started.elapsed().as_millis());
            let parsed = match result {
                Ok(v) => {
                    state["requests"][index]["usage"] = if api == "ollama" {
                        json!({"prompt_tokens":v["prompt_eval_count"],"completion_tokens":v["eval_count"]})
                    } else {
                        v["usage"].clone()
                    };
                    model_contract::parse(&api, name, &v)
                }
                Err(e) => Err(e),
            };
            if let Ok(value) = &parsed {
                state["requests"][index]["result"] = value.clone();
            }
            state["requests"][index]["status"] = json!(if parsed.is_ok() {
                "completed"
            } else {
                "failed"
            });
            if let Err(e) = &parsed {
                state["requests"][index]["error"] = json!(e);
            }
            std::fs::write(&report, serde_json::to_vec_pretty(&*state).unwrap()).unwrap();
            parsed
        }
    };
    let mut failed = 0;
    for case in fixture["decisions"].as_array().unwrap() {
        let input: task_harness::Input = serde_json::from_value(case["input"].clone()).unwrap();
        let start = Instant::now();
        let d = task_harness::run(&input, call)
            .await
            .expect("API failure: paused, no retries");
        let task = matches!(d.action.as_str(), "show" | "revise");
        let expected = &case["expected"];
        let passed = task == (expected["action"] == "task")
            && expected["must"].as_array().into_iter().flatten().all(|s| {
                d.question
                    .to_lowercase()
                    .contains(&s.as_str().unwrap().to_lowercase())
            })
            && expected["mustNot"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|s| !d.question.contains(s.as_str().unwrap()));
        failed += usize::from(!passed);
        let mut state = ledger.lock().unwrap();
        state["cases"].as_array_mut().unwrap().push(json!({"name":case["name"],"kind":"decision","passed":passed,"result":d,"elapsedMs":start.elapsed().as_millis()}));
        persist(&state);
    }
    let candidates: Vec<crate::knowledge::Question> =
        serde_json::from_value(fixture["candidates"].clone()).unwrap();
    for case in fixture["retrieval"].as_array().unwrap() {
        let query = case["question"].as_str().unwrap();
        let context = case["conversation"].as_str().unwrap();
        let ranked = crate::knowledge_search::ranked(query, context, &candidates);
        let user = crate::knowledge_search::match_payload(query, context, &ranked);
        let start = Instant::now();
        let value = call(
            "match_questions",
            crate::knowledge_search::MATCH,
            crate::knowledge_search::match_schema(),
            user,
        )
        .await
        .expect("API failure: paused, no retries");
        let selected = crate::knowledge_search::selection(&value, &ranked)
            .expect("invalid semantic selection");
        let passed = if let Some(id) = case["expectedId"].as_str() {
            selected.iter().any(|q| q.id == id)
        } else {
            value["relation"] == case["expectedRelation"]
        };
        failed += usize::from(!passed);
        let mut state = ledger.lock().unwrap();
        state["cases"].as_array_mut().unwrap().push(json!({"name":case["name"],"kind":"retrieval","passed":passed,"result":value,"elapsedMs":start.elapsed().as_millis()}));
        persist(&state);
    }
    let mut state = ledger.lock().unwrap();
    state["failed"] = json!(failed);
    state["completed"] = json!(true);
    persist(&state);
    assert_eq!(failed, 0, "See local replay report for semantic failures");
}

#[tokio::test]
#[ignore = "local private fixture; never performs network requests"]
async fn cached_dialogue_replay() {
    let path = std::env::var("MOCK_CACHED_REPLAY_FILE").expect("local fixture");
    let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut report = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let input: task_harness::Input = serde_json::from_value(case["input"].clone()).unwrap();
        let decision = task_harness::run(&input, |name, _, _, _| {
            let value = case[if name == "submit_task" {
                "proposal"
            } else {
                "verification"
            }]
            .clone();
            async { Ok(value) }
        })
        .await
        .unwrap();
        let passed = matches!(decision.action.as_str(), "show" | "revise")
            == (case["expected"]["action"] == "task");
        report.push(json!({"name":case["name"],"passed":passed,"result":decision}));
    }
    let target = std::env::var("MOCK_CACHED_REPLAY_REPORT").expect("local report");
    std::fs::write(target, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert!(
        report.iter().all(|row| row["passed"] == true),
        "See cached replay report"
    );
}

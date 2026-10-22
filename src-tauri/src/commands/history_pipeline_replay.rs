//! Opt-in historical text replay. Fixtures and results stay outside the source tree.
//! Uses production extraction, lookup, JS evidence selection and SSE decoding.
use super::{
    answer_stream::AnswerStream, knowledge_commands::AnswerContext, model_contract, task_harness,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn save(path: &PathBuf, state: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(state).unwrap()).unwrap();
}

#[test]
#[ignore = "local historical evidence audit; no network"]
fn historical_evidence_diagnostics() {
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("MOCK_HISTORY_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let results: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("MOCK_HISTORY_REPORT").unwrap()).unwrap(),
    )
    .unwrap();
    let root = PathBuf::from(fixture["libraryRoot"].as_str().unwrap());
    let snap = crate::knowledge::snapshot(&root).unwrap();
    let mut rows = vec![];
    for case in results["cases"].as_array().unwrap() {
        let Some(passages) = case["selected"]["context"]["passages"].as_array() else {
            continue;
        };
        for value in passages {
            let p: crate::knowledge::Passage = serde_json::from_value(value.clone()).unwrap();
            let s = snap
                .library
                .sources
                .iter()
                .find(|s| s.id == p.source_id)
                .unwrap();
            let chunks = crate::knowledge::chunks(
                &crate::knowledge::source_text(&root, &p.source_id).unwrap(),
            );
            rows.push(json!({"case":case["name"],"sourceId":s.id,"locator":p.locator,"metadataCurrent":s.hash==p.hash&&s.status=="ready"&&s.project==p.project&&s.relative_path==p.path,
                "stampCurrent":crate::knowledge::stamp(std::path::Path::new(&s.path))==s.modified,
                "chunkCurrent":chunks.iter().any(|(l,t)|l==&p.locator&&t==&p.text),"storedChars":p.text.chars().count(),
                "labelCandidates":chunks.iter().filter(|(l,_)|l==&p.locator).map(|(_,t)|json!({"chars":t.chars().count(),"sameTrimmed":t.trim()==p.text.trim()})).collect::<Vec<_>>() }));
        }
    }
    let target = PathBuf::from(std::env::var("MOCK_HISTORY_DIAGNOSTICS").unwrap());
    assert!(!target.exists());
    save(&target, &json!({"rows":rows}));
}

#[tokio::test]
#[ignore = "explicit historical replay only; uses a hashed scope, saved credential and paid API"]
async fn historical_pipeline_replay() {
    let bytes = std::fs::read(std::env::var("MOCK_HISTORY_FIXTURE").unwrap()).unwrap();
    assert_eq!(
        crate::knowledge::digest(&bytes),
        std::env::var("MOCK_HISTORY_HASH").unwrap()
    );
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    let report = PathBuf::from(std::env::var("MOCK_HISTORY_REPORT").unwrap());
    assert!(
        !report.exists(),
        "Use a fresh report; do not silently repeat paid requests"
    );
    let root = PathBuf::from(fixture["libraryRoot"].as_str().unwrap());
    let snap = crate::knowledge::snapshot(&root).unwrap();
    let hints = crate::knowledge_search::recognition_terms(&snap.questions, &snap.library.sources);
    let maximum = fixture["maxRequests"].as_u64().unwrap() as usize;
    assert!(maximum <= 80);
    let key = Arc::new(
        crate::credentials::CredentialManager::new()
            .get_key("interview_cue_answer@https://api.deepseek.com")
            .unwrap()
            .expect("saved credential"),
    );
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let state = Arc::new(Mutex::new(
        json!({"scopeHash":crate::knowledge::digest(&bytes),"requests":[],"cases":[],"completed":false}),
    ));
    save(&report, &state.lock().unwrap());
    let call = |name: &'static str, system: &'static str, schema: Value, user: String| {
        let (http, key, state, report) = (http.clone(), key.clone(), state.clone(), report.clone());
        async move {
            let body = model_contract::body(
                "deepseek",
                "deepseek-flash",
                name,
                system,
                &user,
                schema,
                if name == "submit_task" { 1800 } else { 1000 },
            );
            let index = {
                let mut s = state.lock().unwrap();
                let rows = s["requests"].as_array_mut().unwrap();
                if rows.len() >= maximum {
                    return Err("request_budget_exhausted".into());
                }
                rows.push(json!({"stage":name,"status":"started","bodyHash":crate::knowledge::digest(body.to_string().as_bytes()),"inputCharacters":user.chars().count()}));
                let index = rows.len() - 1;
                save(&report, &s);
                index
            };
            let start = Instant::now();
            let result = async {
                let r = http
                    .post("https://api.deepseek.com/chat/completions")
                    .bearer_auth(&*key)
                    .timeout(Duration::from_secs(25))
                    .json(&body)
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
            let mut s = state.lock().unwrap();
            let row = &mut s["requests"][index];
            row["elapsedMs"] = json!(start.elapsed().as_millis());
            let parsed = match result {
                Ok(v) => {
                    row["usage"] = v["usage"].clone();
                    model_contract::parse("deepseek", name, &v)
                }
                Err(e) => Err(e),
            };
            row["status"] = json!(if parsed.is_ok() {
                "completed"
            } else {
                "failed"
            });
            match &parsed {
                Ok(v) => row["result"] = v.clone(),
                Err(e) => row["error"] = json!(e),
            };
            save(&report, &s);
            parsed
        }
    };
    for case in fixture["cases"].as_array().unwrap() {
        let started = Instant::now();
        let mut input: task_harness::Input = serde_json::from_value(case["input"].clone()).unwrap();
        input.term_hints = hints.clone();
        if let Some(terms) = case["termHintsOverride"].as_array() {
            input.term_hints = terms
                .iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .chain(hints.clone())
                .collect();
            input.term_hints.dedup();
            input.term_hints.truncate(48);
        }
        if let Some(prior) = case["previousCase"].as_str() {
            let s = state.lock().unwrap();
            input.previous_question = s["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["name"] == prior)
                .and_then(|r| r["decision"]["question"].as_str())
                .unwrap()
                .to_string();
            input.previous_evidence = serde_json::from_value(
                s["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["name"] == prior)
                    .unwrap()["decision"]["evidence"]
                    .clone(),
            )
            .unwrap();
        }
        if let Some(prior) = case["pendingFrom"].as_str() {
            let s = state.lock().unwrap();
            input.pending_evidence = serde_json::from_value(
                s["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["name"] == prior)
                    .unwrap()["decision"]["pending_evidence"]
                    .clone(),
            )
            .unwrap();
        }
        let decision = if let Some(q) = case["directQuestion"].as_str() {
            task_harness::Decision {
                action: "show".into(),
                intent: "question".into(),
                question: q.into(),
                ..Default::default()
            }
        } else {
            task_harness::run(&input, call)
                .await
                .expect("API failed: replay paused without retry")
        };
        let accepted = matches!(decision.action.as_str(), "show" | "revise");
        let passed = accepted == (case["expected"]["action"] == "task")
            && case["expected"]["must"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|s| {
                    decision
                        .question
                        .to_lowercase()
                        .contains(&s.as_str().unwrap().to_lowercase())
                })
            && case["expected"]["mustNot"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|s| {
                    !decision
                        .question
                        .to_lowercase()
                        .contains(&s.as_str().unwrap().to_lowercase())
                });
        let mut row = json!({"name":case["name"],"sessionId":case["sessionId"],"origin":case["origin"],"input":input,
            "expected":case["expected"],"decision":decision,"extractionPassed":passed,"extractionMs":started.elapsed().as_millis()});
        if accepted && case["generate"] == true {
            let conversation = input
                .turns
                .iter()
                .filter(|t| !t.current)
                .map(|t| t.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let start = Instant::now();
            let lookup =
                crate::knowledge::lookup_with_context(&root, &decision.question, &conversation)
                    .unwrap();
            let lookup_ms = start.elapsed().as_millis();
            row["lookupMs"] = json!(lookup_ms);
            // The shipped UI gives retrieval 1200 ms. Respect that fallback here.
            let context = if lookup_ms <= 1200 && lookup.enabled {
                let mut child = Command::new(fixture["node"].as_str().unwrap())
                    .arg(fixture["selector"].as_str().unwrap())
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(&serde_json::to_vec(&lookup).unwrap())
                    .unwrap();
                let output = child.wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "Evidence selector failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let selected: Value = serde_json::from_slice(&output.stdout).unwrap();
                row["selected"] = selected.clone();
                if selected["exact"].is_object() {
                    row["answer"] = selected["exact"]["answer"].clone();
                    row["answerSource"] = json!("exact_bank");
                    None
                } else {
                    serde_json::from_value::<Option<AnswerContext>>(selected["context"].clone())
                        .unwrap()
                }
            } else {
                None
            };
            let context = context.and_then(|c| match c.sanitized(&root, true) {
                Ok((safe, q, p)) => {
                    row["removedEvidence"] = json!({"questions":q,"passages":p});
                    Some(safe)
                }
                Err(e) => {
                    row["contextDropped"] = json!(e);
                    None
                }
            });
            if row["answer"].is_null() {
                let mut system = super::practice_protocol::knowledge_prompt(include_str!(
                    "../../resources/technical-answer.txt"
                ));
                let mut user=format!("技术回答任务：{}\n必须覆盖：{}\n需解释的术语：{}\n明确条件：{}\n听写不确定术语：{}",decision.question,
                    decision.focus.join("；"),decision.key_terms.iter().take(3).cloned().collect::<Vec<_>>().join("、"),decision.constraints.join("；"),decision.uncertain_terms.join("、"));
                if !input.previous_question.is_empty() {
                    user=format!("之前的问题（仅用于理解当前追问的指代；新主体优先，不能据此编造个人经历或把旧题重新作答）：\n{}\n当前最新任务：\n{user}", input.previous_question);
                }
                // Match the ordinary runtime's domain/role background. Resume
                // text is deliberately omitted from this scoped evaluation.
                user = format!(
                    "{}\n{user}",
                    super::practice_protocol::PracticeContext {
                        scope: "comprehensive".into(),
                        difficulty: "medium".into(),
                        role: "具身智能算法工程师".into(),
                        topics: input.topic_background.clone(),
                        ..Default::default()
                    }
                    .background()
                );
                if let Some(c) = context {
                    system.push_str("\n");
                    system.push_str(include_str!("../../resources/answer-evidence.txt"));
                    user = format!("{}\n当前任务：\n{user}", c.text());
                }
                let body = json!({"model":"deepseek-flash","messages":[{"role":"system","content":system},{"role":"user","content":user}],"stream":true,"temperature":0.2,
                    "thinking":{"type":"disabled"},"max_tokens":6144,"stream_options":{"include_usage":true}});
                let index = {
                    let mut s = state.lock().unwrap();
                    let rows = s["requests"].as_array_mut().unwrap();
                    assert!(rows.len() < maximum);
                    rows.push(json!({"stage":"answer","case":case["name"],"status":"started","bodyHash":crate::knowledge::digest(body.to_string().as_bytes()),"inputCharacters":user.chars().count()}));
                    let i = rows.len() - 1;
                    save(&report, &s);
                    i
                };
                let start = Instant::now();
                let response = http
                    .post("https://api.deepseek.com/chat/completions")
                    .bearer_auth(&*key)
                    .json(&body)
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap();
                let mut stream = response.bytes_stream();
                let mut decoder = AnswerStream::new(false);
                let mut text = String::new();
                let mut first = None;
                while let Some(chunk) = stream.next().await {
                    for token in decoder.push(&chunk.unwrap()) {
                        if first.is_none() {
                            first = Some(start.elapsed().as_millis());
                        }
                        text.push_str(&token);
                    }
                }
                for token in decoder.flush() {
                    text.push_str(&token);
                }
                let outcome = decoder.outcome();
                row["answer"] = json!(text);
                row["answerSource"] = json!("api");
                row["firstTokenMs"] = json!(first);
                row["answerMs"] = json!(start.elapsed().as_millis());
                row["answerError"] = json!(outcome.as_ref().err());
                let mut s = state.lock().unwrap();
                s["requests"][index]["status"] = json!(if outcome.is_ok() {
                    "completed"
                } else {
                    "failed"
                });
                s["requests"][index]["usage"] = decoder.usage().cloned().unwrap_or(Value::Null);
                s["requests"][index]["elapsedMs"] = row["answerMs"].clone();
                save(&report, &s);
                outcome.expect("Answer stream failed: replay paused without retry");
            }
        }
        println!(
            "{}: {} / {}",
            case["name"],
            if passed { "PASS" } else { "FAIL" },
            decision.action
        );
        let mut s = state.lock().unwrap();
        s["cases"].as_array_mut().unwrap().push(row);
        save(&report, &s);
    }
    let mut s = state.lock().unwrap();
    let failed = s["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["extractionPassed"] != true)
        .count();
    s["failed"] = json!(failed);
    s["completed"] = json!(true);
    save(&report, &s);
    assert_eq!(
        failed, 0,
        "Historical semantics failed; see the local ledger, do not retry automatically"
    );
}

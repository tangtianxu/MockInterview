use tauri::{command, AppHandle, Emitter, State};

use crate::intelligence::action_config::{AllActionConfigs, InstructionPresets};
use crate::intelligence::laya_decision::{self, InterviewDecision};
use crate::intelligence::IntelligenceEngine;
use crate::llm::provider::GenerationParams;
use crate::llm::provider::RagChunkInfo;
use crate::rag;
use crate::interview_library::{self, Folder, LibrarySnapshot, Preferences, SyncReport};
use crate::state::AppState;

fn answer_elapsed(started:&std::time::Instant,question_end_wall_ms:Option<i64>)->i64 {
    if let Some(ended)=question_end_wall_ms {
        let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
        return now.saturating_sub(ended);
    }
    started.elapsed().as_millis() as i64
}

fn loopback_model_endpoint(value:&str)->bool {
    reqwest::Url::parse(value).ok().is_some_and(|url| {
        matches!(url.scheme(),"http"|"https") && matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"::1"|"[::1]"))
    })
}

#[cfg(test)] mod privacy_tests {
    use super::loopback_model_endpoint;
    #[test] fn assist_accepts_only_loopback_model_urls() {
        assert!(loopback_model_endpoint("http://127.0.0.1:11434"));
        assert!(loopback_model_endpoint("http://localhost:1234/v1"));
        assert!(!loopback_model_endpoint("https://localhost.example.com/v1"));
        assert!(!loopback_model_endpoint("http://192.168.1.2:11434"));
    }
}

struct ResetGenerating(Option<std::sync::Arc<std::sync::Mutex<IntelligenceEngine>>>);
impl Drop for ResetGenerating {
    fn drop(&mut self) {
        if let Some(engine)=self.0.as_ref().and_then(|value|value.lock().ok()) {engine.set_generating(false);}
    }
}

/// Classify an interviewer turn using the local Laya HTTP service.
#[command]
pub async fn decide_interview_turn(
    context: String,
    candidate: String,
    previous_question: Option<String>,
) -> Result<InterviewDecision, String> {
    laya_decision::decide(&context, &candidate, previous_question.as_deref()).await
}

#[command]
pub async fn confirm_interview_turn(context: String, candidate: String) -> Result<bool, String> {
    laya_decision::confirm_with_qwen(&context, &candidate).await
}

/// Apply the unmodified NexQ question detector to the same final STT turn.
#[command]
pub fn detect_nexq_interview_turn(text: String) -> bool {
    crate::intelligence::question_detector::QuestionDetector::new()
        .detect_questions(&text, 0, "Them")
        .iter()
        .any(|question| question.confidence >= 0.5)
}

#[command]
pub fn add_interview_folder(path:String,collection:String,domains:Vec<String>,role:String,topics:Vec<String>,state:State<'_,AppState>)->Result<Folder,String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    interview_library::add_folder(db.connection(),&path,&collection,domains,role,topics)
}

#[command]
pub async fn sync_interview_folder(folder_id:String,state:State<'_,AppState>)->Result<SyncReport,String>{
    let db_path={
        let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
        db.connection().query_row("PRAGMA database_list",[],|r|r.get::<_,String>(2)).map_err(|e|e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move||{
        let conn=rusqlite::Connection::open(db_path).map_err(|e|e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e|e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys=ON;").map_err(|e|e.to_string())?;
        interview_library::sync(&conn,&folder_id)
    }).await.map_err(|e|e.to_string())?
}

#[command]
pub fn list_interview_library(state:State<'_,AppState>)->Result<LibrarySnapshot,String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    interview_library::snapshot(db.connection())
}

#[command]
pub fn get_interview_preferences(state:State<'_,AppState>)->Result<Preferences,String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    interview_library::preferences(db.connection())
}

#[command]
pub fn set_interview_preferences(domains:Vec<String>,role:String,topics:Vec<String>,state:State<'_,AppState>)->Result<(),String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    interview_library::save_preferences(db.connection(),&Preferences{domains,role,topics})
}

#[command]
pub fn preview_interview_retrieval(question:String,state:State<'_,AppState>)->Result<serde_json::Value,String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    let conn=db.connection();
    let prefs=interview_library::preferences(conn)?;
    let kind=crate::intelligence::question_route::classify(&question);
    let card=if kind!=crate::intelligence::question_route::QuestionType::Personal {
        let card_question=if kind==crate::intelligence::question_route::QuestionType::Mixed {
            crate::intelligence::question_route::technical_part(&question)
        }else{question.clone()};
        interview_library::card_hit(conn,&card_question)?
    } else {None};
    let technical=if kind!=crate::intelligence::question_route::QuestionType::Personal {interview_library::retrieve(conn,&question,"technical",&prefs,3)?} else {Vec::new()};
    let personal=if kind!=crate::intelligence::question_route::QuestionType::Technical {interview_library::retrieve(conn,&crate::intelligence::question_route::personal_retrieval_query(&question,kind),"personal",&prefs,3)?} else {Vec::new()};
    Ok(serde_json::json!({"questionType":kind.as_str(),"route":if card.is_some(){"verified_card"}else if technical.is_empty(){"direct"}else{"rag_generate"},"card":card,"technical":technical,"personal":personal}))
}

#[command]
pub fn review_interview_answer(event_id:String,quality:String,reviewer_note:String,state:State<'_,AppState>)->Result<(),String>{
    if !matches!(quality.as_str(),"correct"|"partial"|"incorrect"|"unreviewed") {return Err("Invalid quality rating".into());}
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    db.connection().execute("UPDATE interview_answer_events SET quality=?1,reviewer_note=?2 WHERE id=?3",rusqlite::params![quality,reviewer_note,event_id]).map_err(|e|e.to_string())?;
    Ok(())
}

#[command]
pub fn list_interview_answer_events(state:State<'_,AppState>)->Result<Vec<serde_json::Value>,String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    let mut stmt=db.connection().prepare("SELECT id,created_at,question,question_type,route,hit,source_paths,decision_ms,first_hint_ms,complete_hint_ms,quality,reviewer_note,answer_text,model,provider FROM interview_answer_events ORDER BY created_at DESC LIMIT 30").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"createdAt":r.get::<_,String>(1)?,"question":r.get::<_,String>(2)?,"questionType":r.get::<_,String>(3)?,"route":r.get::<_,String>(4)?,"hit":r.get::<_,i64>(5)?!=0,"sourcePaths":serde_json::from_str::<Vec<String>>(&r.get::<_,String>(6)?).unwrap_or_default(),"decisionMs":r.get::<_,Option<i64>>(7)?,"firstHintMs":r.get::<_,Option<i64>>(8)?,"completeHintMs":r.get::<_,Option<i64>>(9)?,"quality":r.get::<_,Option<String>>(10)?,"reviewerNote":r.get::<_,Option<String>>(11)?,"answerText":r.get::<_,Option<String>>(12)?,"model":r.get::<_,Option<String>>(13)?,"provider":r.get::<_,Option<String>>(14)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[command]
pub fn record_interview_first_hint(event_id:String,elapsed_ms:i64,state:State<'_,AppState>)->Result<(),String>{
    if elapsed_ms<0 || elapsed_ms>600_000 {return Err("Invalid hint latency".into());}
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    db.connection().execute("UPDATE interview_answer_events SET first_hint_ms=?1 WHERE id=?2 AND first_hint_ms IS NULL",rusqlite::params![elapsed_ms,event_id]).map_err(|e|e.to_string())?;
    Ok(())
}

#[command]
pub fn record_interview_answer_content(event_id:String,answer_text:String,state:State<'_,AppState>)->Result<(),String>{
    let db=state.database.as_ref().ok_or("Database unavailable")?.lock().map_err(|e|e.to_string())?;
    db.connection().execute("UPDATE interview_answer_events SET answer_text=?1 WHERE id=?2",rusqlite::params![answer_text,event_id]).map_err(|e|e.to_string())?;
    Ok(())
}

/// Compose instruction presets + custom text into a single string.
/// Mirrors the frontend's `composeInstructions()` in aiActionsStore.ts.
fn compose_instructions(presets: &InstructionPresets, custom: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(tone) = &presets.tone {
        parts.push(format!("{} tone.", tone));
    }
    if let Some(fmt) = &presets.format {
        let text = match fmt.as_str() {
            "bullets" => "Use bullet points.".to_string(),
            "paragraphs" => "Use paragraphs.".to_string(),
            "numbered" => "Use a numbered list.".to_string(),
            "oneliner" => "Keep it to one line.".to_string(),
            other => format!("Use {} format.", other),
        };
        parts.push(text);
    }
    if let Some(length) = &presets.length {
        let text = match length.as_str() {
            "brief" => "Brief responses.".to_string(),
            "standard" => "Standard length responses.".to_string(),
            "detailed" => "Detailed responses.".to_string(),
            other => format!("{} responses.", other),
        };
        parts.push(text);
    }
    if presets.opinion.as_deref() == Some("add") {
        parts.push("After answering based on the provided context, add a short section '## My Take' with your own analysis, interpretation, or recommendation — clearly separated from the factual answer above.".to_string());
    }
    let prefix = parts.join(" ");
    if !prefix.is_empty() && !custom.is_empty() {
        format!("{} {}", prefix, custom)
    } else if !prefix.is_empty() {
        prefix
    } else {
        custom.to_string()
    }
}

/// Build transcript text from frontend-provided segments, applying the per-action window.
/// The frontend transcript store is the single source of truth for ALL STT engines.
/// When `include_segment_ids` is true, each line includes the segment ID for LLM reference.
fn build_transcript_from_segments(
    segments_json: &str,
    window_seconds: u64,
    include_segment_ids: bool,
) -> String {
    #[derive(serde::Deserialize)]
    struct Seg {
        #[serde(default)]
        id: String,
        text: String,
        speaker: String,
        timestamp_ms: u64,
    }
    let segments: Vec<Seg> = match serde_json::from_str(segments_json) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to parse frontend transcript segments: {}", e);
            return String::new();
        }
    };

    if segments.is_empty() {
        return String::new();
    }

    // Find the latest timestamp for windowing
    let latest_ts = segments.iter().map(|s| s.timestamp_ms).max().unwrap_or(0);

    // Apply window: 0 = all segments, otherwise filter by time window
    let cutoff_ms = if window_seconds == 0 {
        0
    } else {
        latest_ts.saturating_sub(window_seconds * 1000)
    };

    segments
        .iter()
        .filter(|s| s.timestamp_ms >= cutoff_ms)
        .map(|s| {
            let label = match s.speaker.as_str() {
                "User" => "You",
                "Them" => "Them",
                other => other,
            };
            if include_segment_ids && !s.id.is_empty() {
                format!("[{}] {}: {}", s.id, label, s.text)
            } else {
                format!("[{}]: {}", label, s.text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Count total segments in the JSON, regardless of window filtering.
fn count_total_segments(segments_json: &str) -> usize {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Seg {
        text: String,
    }
    serde_json::from_str::<Vec<Seg>>(segments_json)
        .map(|s| s.len())
        .unwrap_or(0)
}

#[command]
pub async fn generate_assist(
    mode: String,
    custom_question: Option<String>,
    transcript_segments: Option<String>,
    is_followup: Option<bool>,
    previous_question: Option<String>,
    question_end_wall_ms: Option<i64>,
    decision_ms: Option<i64>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let assist_started = std::time::Instant::now();
    // Extract what we need from the intelligence engine under its lock
    let (last_question, cancel_flag, action_config_snapshot, composed_instructions) = {
        let intel = state
            .intelligence
            .as_ref()
            .ok_or_else(|| "Intelligence engine not initialized".to_string())?;
        let engine = intel
            .lock()
            .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

        if engine.is_generating() {
            return Err("Generation already in progress".to_string());
        }

        engine.set_generating(true);

        // Look up per-action config
        let action_cfg = engine.get_action_config(&mode).cloned();
        let global_defaults = engine.get_action_configs().global_defaults.clone();

        // Compose instructions from AllActionConfigs (reliable path — same sync as system prompts)
        let all_configs = engine.get_action_configs();
        let composed = compose_instructions(
            &all_configs.instruction_presets,
            &all_configs.custom_instructions,
        );

        let question = engine.last_detected_question().cloned();
        let cancel = engine.cancel_flag();

        (question, cancel, (action_cfg, global_defaults), composed)
    };
    let _generating_reset=ResetGenerating(state.intelligence.clone());

    let (action_cfg, global_defaults) = action_config_snapshot;

    // Compute include_question early for effective_question logic
    let include_question = action_cfg
        .as_ref()
        .map(|c| c.include_detected_question)
        .unwrap_or(true);

    // Construct effective question for the Detected Question prompt section.
    // custom_question (user-typed or user-clicked) is ALWAYS used if provided — it's explicit input.
    // Auto-detected questions are only used when include_detected_question is true.
    let effective_question = if let Some(ref cq) = custom_question {
        // User explicitly provided a question (Ask mode typed text, or clicked a specific question)
        Some(crate::intelligence::question_detector::DetectedQuestion {
            text: cq.clone(),
            confidence: 1.0,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            source: "user-selected".to_string(),
        })
    } else if include_question {
        // No custom question — use auto-detected question if the action's toggle allows it
        last_question
    } else {
        // Action has include_detected_question=false and no custom question
        None
    };

    // Determine transcript window: per-action override or global default
    let window_seconds = action_cfg
        .as_ref()
        .and_then(|c| c.transcript_window_seconds)
        .unwrap_or(global_defaults.transcript_window_seconds);

    // Build transcript from frontend segments (universal — works with any STT engine).
    // The frontend transcript store is the single source of truth.
    // Falls back to engine buffer only if frontend didn't send segments.
    let include_segment_ids = mode == "BookmarkSuggestions";
    let mut transcript_text = if let Some(ref segs) = transcript_segments {
        build_transcript_from_segments(segs, window_seconds, include_segment_ids)
    } else {
        // Legacy fallback: read from backend buffer
        let intel = state
            .intelligence
            .as_ref()
            .ok_or_else(|| "Intelligence engine not initialized".to_string())?;
        let engine = intel.lock().map_err(|e| e.to_string())?;
        if window_seconds == 0 {
            engine.get_all_transcript()
        } else {
            engine.transcript_buffer.get_recent_text(window_seconds)
        }
    };

    // Prepend speaker context from active scenario (if set) before transcript
    if let Ok(scenario) = state.active_scenario.read() {
        if !scenario.speaker_context.is_empty() && !transcript_text.is_empty() {
            transcript_text = format!("{}\n\n{}", scenario.speaker_context, transcript_text);
        }
    }

    let assist_question = effective_question.as_ref().map(|q|q.text.clone())
        .or_else(||custom_question.clone())
        .unwrap_or_else(||transcript_text.lines().last().unwrap_or("").to_string());
    if mode == "Assist" && assist_question.trim().is_empty() {
        return Err("尚未识别到面试问题。请检查 Them 音量和转录文字，再试 Assist。".to_string());
    }
    let assist_kind=crate::intelligence::question_route::classify(&assist_question);
    let assist_chinese=assist_question.chars().any(|c|('\u{3400}'..='\u{9fff}').contains(&c));
    if mode=="Assist" && action_cfg.as_ref().is_some_and(|cfg| cfg.include_rag_chunks) && !is_followup.unwrap_or(false) && assist_kind!=crate::intelligence::question_route::QuestionType::Personal && !assist_question.trim().is_empty() {
        if let Some(db_arc)=state.database.as_ref() {
            let card_question=if assist_kind==crate::intelligence::question_route::QuestionType::Mixed {
                crate::intelligence::question_route::technical_part(&assist_question)
            }else{assist_question.clone()};
            let card={let db=db_arc.lock().map_err(|e|e.to_string())?;interview_library::card_hit(db.connection(),&card_question)?};
            if let Some(hit)=card {
                let mut sources=vec![hit.source_path.clone()];
                let evidence=if assist_kind==crate::intelligence::question_route::QuestionType::Mixed {
                    let value={let db=db_arc.lock().map_err(|e|e.to_string())?;
                        let focus=crate::intelligence::question_route::personal_retrieval_query(&assist_question,assist_kind);
                        let prefs=interview_library::preferences(db.connection())?;
                        let passages=interview_library::retrieve(db.connection(),&focus,"personal",&prefs,3)?;
                        sources.extend(passages.iter().map(|passage|passage.source_path.clone()));
                        interview_library::best_personal_evidence(&assist_question,&focus,&passages)
                    };
                    value
                }else{None};
                let content=crate::intelligence::question_route::render_verified_card(&hit.card,assist_kind,assist_chinese,evidence.as_deref());
                let elapsed=answer_elapsed(&assist_started,question_end_wall_ms) as u64;
                let id=uuid::Uuid::new_v4().to_string();
                {let db=db_arc.lock().map_err(|e|e.to_string())?;
                    db.connection().execute("INSERT INTO interview_answer_events(id,created_at,question,question_type,route,hit,source_paths,decision_ms,first_hint_ms,complete_hint_ms,quality,question_end_wall_ms,answer_text,model,provider) VALUES (?1,datetime('now'),?2,?3,'verified_card',1,?4,?5,?6,?6,'unreviewed',?7,?8,'verified-card','Local library')",rusqlite::params![id,assist_question,assist_kind.as_str(),serde_json::to_string(&sources).unwrap_or_default(),decision_ms,elapsed as i64,question_end_wall_ms,content]).map_err(|e|e.to_string())?;}
                let _=app_handle.emit("llm_stream_start",crate::llm::provider::StreamStartPayload{mode:"Assist".into(),model:"verified-card".into(),provider:"Local library".into(),system_prompt:String::new(),user_prompt:assist_question.clone(),include_transcript:false,include_rag:assist_kind==crate::intelligence::question_route::QuestionType::Mixed,include_instructions:false,include_question:true,temperature:0.0,rag_query:Some(assist_question.clone()),rag_chunks:Vec::new(),rag_chunks_filtered:0,rag_total_candidates:sources.len(),transcript_window_seconds:0,transcript_segments_count:0,transcript_segments_total:0,interview_event_id:Some(id),question_end_wall_ms,personal_evidence:None});
                let _=app_handle.emit("llm_stream_token",crate::llm::provider::StreamTokenPayload{token:content});
                let _=app_handle.emit("llm_stream_end",crate::llm::provider::StreamEndPayload{total_tokens:0,latency_ms:elapsed});
                if let Some(intel)=state.intelligence.as_ref() {if let Ok(engine)=intel.lock(){engine.set_generating(false);}}
                return Ok(());
            }
        }
    }

    let total_segments = transcript_segments
        .as_ref()
        .map(|s| count_total_segments(s))
        .unwrap_or(0);
    let included_segments = transcript_text
        .lines()
        .filter(|l| l.starts_with("["))
        .count();

    // Resolve per-action settings
    // Read default top-K from RagConfig (Context Strategy) — single source of truth
    let rag_default_top_k = state
        .rag
        .as_ref()
        .and_then(|r| r.lock().ok())
        .map(|r| r.config().top_k)
        .unwrap_or(5);
    let rag_top_k = action_cfg
        .as_ref()
        .and_then(|c| c.rag_top_k)
        .unwrap_or(rag_default_top_k);

    let include_rag = action_cfg
        .as_ref()
        .map(|c| c.include_rag_chunks)
        .unwrap_or(true);
    let include_transcript = action_cfg
        .as_ref()
        .map(|c| c.include_transcript)
        .unwrap_or(true);
    // include_question already computed above
    let include_instructions = action_cfg
        .as_ref()
        .map(|c| c.include_custom_instructions)
        .unwrap_or(true);

    // Resolve base system prompt: per-action config > active scenario > hardcoded template.
    // Active scenario is set by the frontend at meeting start based on the selected AI scenario.
    let base_system_prompt = action_cfg
        .as_ref()
        .map(|c| c.system_prompt.clone())
        .unwrap_or_else(|| {
            // Check if the active scenario has a system prompt set
            let scenario_prompt = state.active_scenario.read().ok().and_then(|s| {
                if s.system_prompt.is_empty() {
                    None
                } else {
                    Some(s.system_prompt.clone())
                }
            });
            scenario_prompt.unwrap_or_else(|| {
                crate::intelligence::prompt_templates::get_system_prompt(&mode).to_string()
            })
        });

    // Append composed instructions (tone + format + length + custom text) to system prompt.
    // These are behavioral directives that belong in the system context, not as reference materials.
    let mut system_prompt = if include_instructions && !composed_instructions.is_empty() {
        format!(
            "{}\n\nAdditional Instructions: {}",
            base_system_prompt, composed_instructions
        )
    } else {
        base_system_prompt
    };

    if mode == "Assist" {
        let language_rule=crate::intelligence::question_route::instructions(assist_kind,assist_chinese);
        system_prompt.push_str("\n\n");
        system_prompt.push_str(language_rule);
    }

    // Build generation params from per-action overrides or global defaults
    let configured_temperature = action_cfg
        .as_ref()
        .and_then(|c| c.temperature)
        .unwrap_or(global_defaults.temperature);
    let temperature = if mode == "Assist" {
        configured_temperature.min(0.2)
    } else {
        configured_temperature
    };

    // Check for active Gemini context cache — only applies when Gemini is the provider
    let active_cache_name = {
        let is_gemini = state
            .llm
            .as_ref()
            .and_then(|l| l.lock().ok())
            .and_then(|r| r.active_provider_type().cloned())
            .map(|pt| pt == crate::llm::ProviderType::Gemini)
            .unwrap_or(false);

        if is_gemini {
            state
                .gemini_cache
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(|c| c.name.clone()))
        } else {
            None
        }
    };

    let enable_web_search = action_cfg.as_ref().map(|c| c.web_search).unwrap_or(false);

    let params = GenerationParams {
        temperature: Some(temperature),
        // Interview cues are meant to be scanned while the conversation moves on.
        max_tokens: if mode == "Assist" { Some(256) } else { None },
        cache_name: active_cache_name.clone(),
        enable_web_search,
    };

    // RAG metadata for StreamStartEvent
    let mut rag_query_text: Option<String> = None;
    let mut rag_chunk_infos: Vec<RagChunkInfo> = Vec::new();
    let mut rag_chunks_filtered: usize = 0;
    let mut rag_total_candidates: usize = 0;
    let mut personal_evidence: Option<String> = None;
    let mut interview_model_context_hit = false;

    let context_text = {
        let mut parts: Vec<String> = Vec::new();

        let allow_legacy_rag = mode != "Assist";
        if mode == "Assist" && include_rag {
            if let Some(db_arc)=state.database.as_ref() {
                let db=db_arc.lock().map_err(|e|e.to_string())?;
                let conn=db.connection();
                let prefs=interview_library::preferences(conn)?;
                // The legacy RAG index has no collection labels; using it here could
                // place unrelated resume or technical text into the wrong answer type.
                let mut passages=Vec::new();
                if assist_kind!=crate::intelligence::question_route::QuestionType::Personal {
                    passages.extend(interview_library::retrieve(conn,&assist_question,"technical",&prefs,3)?);
                }
                if assist_kind!=crate::intelligence::question_route::QuestionType::Technical {
                    passages.extend(interview_library::retrieve(conn,&crate::intelligence::question_route::personal_retrieval_query(&assist_question,assist_kind),"personal",&prefs,3)?);
                }
                if is_followup.unwrap_or(false) && assist_kind!=crate::intelligence::question_route::QuestionType::Personal {
                    if let Some(previous)=previous_question.as_deref() {
                        if let Some(hit)=interview_library::card_hit(conn,previous)? {
                            passages.push(interview_library::Passage{source_path:hit.source_path,collection:"technical".into(),
                                text:format!("已核对问答卡：{}\n{}\n{}\n易错点：{}",hit.card.question,hit.card.short_points,hit.card.explanation,hit.card.pitfalls),score:hit.score});
                        }
                    }
                }
                let focus=crate::intelligence::question_route::personal_retrieval_query(&assist_question,assist_kind);
                personal_evidence=interview_library::best_personal_evidence(&assist_question,&focus,&passages);
                for (i,p) in passages.iter().enumerate() {
                    let label=if p.collection=="personal" {"Personal evidence"} else {"Technical reference"};
                    if !(assist_kind==crate::intelligence::question_route::QuestionType::Mixed && p.collection=="personal") {
                        parts.push(format!("[{}: {}]\n{}",label,p.source_path,p.text));
                        interview_model_context_hit = true;
                    }
                    rag_chunk_infos.push(RagChunkInfo{source:p.source_path.clone(),chunk_index:i,text:p.text.clone(),normalized_score:p.score,raw_score:p.score});
                }
                rag_total_candidates=passages.len();
                rag_query_text=Some(assist_question.clone());
            }
        }

        // When Gemini cache is active, skip RAG entirely — no Ollama embed needed.
        // The full context is already cached on Gemini servers.
        if include_rag && active_cache_name.is_none() && allow_legacy_rag {
            // Note: we don't check config.enabled here — the action-level include_rag
            // toggle is the user's intent. If they enabled RAG for this action and have
            // indexed files, we should search. (config.enabled defaults to false and is
            // inconsistently set, while Test Knowledge Base ignores it entirely.)
            {
                // RAG query sources (priority: custom_question > effective_question > transcript)
                // custom_question is what the user typed (Ask mode) or the clicked question (Assist mode)
                // effective_question is the auto-detected question from the meeting
                let question_text = custom_question
                    .as_deref()
                    .filter(|q| !q.is_empty())
                    .map(|q| q.to_string())
                    .or_else(|| effective_question.as_ref().map(|q| q.text.clone()));

                let transcript_excerpt: String = transcript_text
                    .chars()
                    .rev()
                    .take(500)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();

                // Dual search: search with question alone, then with question+transcript, merge results.
                // This prevents transcript noise from drowning out a clear question match,
                // while still benefiting from transcript context when relevant.
                let has_question = question_text.is_some();
                let has_transcript = !transcript_excerpt.is_empty();

                if has_question || has_transcript {
                    if let (Some(rag_arc), Some(db_arc)) =
                        (state.rag.as_ref(), state.database.as_ref())
                    {
                        let (mut config, embedder_url, embedding_model) = {
                            let rag_guard = rag_arc.lock().map_err(|e| e.to_string())?;
                            (
                                rag_guard.config().clone(),
                                rag_guard.embedder_url(),
                                rag_guard.embedding_model(),
                            )
                        };
                        config.top_k = rag_top_k;

                        let mut all_chunks: Vec<rag::search::ScoredChunk> = Vec::new();

                        // Search 1: question only (clean semantic match)
                        if let Some(ref q) = question_text {
                            rag_query_text = Some(q.clone());
                            match rag::RagManager::search_async(
                                db_arc,
                                q,
                                &config,
                                &embedder_url,
                                &embedding_model,
                            )
                            .await
                            {
                                Ok(chunks) => all_chunks.extend(chunks),
                                Err(e) => log::warn!("RAG search (question-only) failed: {}", e),
                            }
                        }

                        // The interview Assist path already has a focused question.
                        // A second embedding request adds latency and can dilute retrieval.
                        if has_question && has_transcript && mode != "Assist" {
                            let combined = format!(
                                "{}\n\n{}",
                                question_text.as_ref().unwrap(),
                                transcript_excerpt
                            );
                            if rag_query_text.is_none() {
                                rag_query_text = Some(combined.clone());
                            }
                            match rag::RagManager::search_async(
                                db_arc,
                                &combined,
                                &config,
                                &embedder_url,
                                &embedding_model,
                            )
                            .await
                            {
                                Ok(chunks) => all_chunks.extend(chunks),
                                Err(e) => log::warn!("RAG search (combined) failed: {}", e),
                            }
                        } else if !has_question && has_transcript {
                            // No question at all — search with transcript only as last resort
                            rag_query_text = Some(transcript_excerpt.clone());
                            match rag::RagManager::search_async(
                                db_arc,
                                &transcript_excerpt,
                                &config,
                                &embedder_url,
                                &embedding_model,
                            )
                            .await
                            {
                                Ok(chunks) => all_chunks.extend(chunks),
                                Err(e) => log::warn!("RAG search (transcript-only) failed: {}", e),
                            }
                        }

                        // Keep the strongest hit per indexed chunk, then remove
                        // identical text imported through multiple source files.
                        let candidate_count = all_chunks.len();
                        let mut best: std::collections::HashMap<String, rag::search::ScoredChunk> =
                            std::collections::HashMap::new();
                        for chunk in all_chunks {
                            let entry = best.entry(chunk.chunk_id.clone()).or_insert(chunk.clone());
                            if chunk.normalized_score > entry.normalized_score {
                                *entry = chunk;
                            }
                        }
                        let mut merged: Vec<rag::search::ScoredChunk> =
                            best.into_values().collect();
                        merged.sort_by(|a, b| {
                            b.normalized_score
                                .partial_cmp(&a.normalized_score)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        });
                        let mut seen_text = std::collections::HashSet::new();
                        merged.retain(|chunk| {
                            seen_text.insert(chunk.text.split_whitespace().collect::<String>())
                        });
                        merged.truncate(rag_top_k);

                        // Build metadata for AI log
                        for c in &merged {
                            rag_chunk_infos.push(RagChunkInfo {
                                source: c.source_file.clone(),
                                chunk_index: c.chunk_index,
                                text: c.text.clone(),
                                normalized_score: c.normalized_score,
                                raw_score: c.score,
                            });
                        }
                        rag_total_candidates = candidate_count;
                        rag_chunks_filtered = candidate_count.saturating_sub(merged.len());
                        if !merged.is_empty() {
                            parts.push(rag::prompt_builder::build_rag_context(&merged, ""));
                        }
                    }
                }
            }
        }

        parts.join("\n\n")
    };

    let include_context = !context_text.is_empty();

    if mode=="Assist" && assist_kind==crate::intelligence::question_route::QuestionType::Personal {
        if let Some(evidence)=personal_evidence.as_ref() {
            let headline=crate::intelligence::question_route::evidence_headline(&evidence,assist_chinese);
            let content=if assist_chinese {format!("- 项目依据：{}\n\n详情：资料原文：{}",headline,evidence)}
                else {format!("- Project evidence: {}\n\nDetails: Source excerpt: {}",headline,evidence)};
            let elapsed=answer_elapsed(&assist_started,question_end_wall_ms) as u64;
            let id=uuid::Uuid::new_v4().to_string();
            let sources:Vec<String>=rag_chunk_infos.iter().map(|chunk|chunk.source.clone()).collect();
            if let Some(db_arc)=state.database.as_ref(){let db=db_arc.lock().map_err(|e|e.to_string())?;
                db.connection().execute("INSERT INTO interview_answer_events(id,created_at,question,question_type,route,hit,source_paths,decision_ms,first_hint_ms,complete_hint_ms,quality,question_end_wall_ms,answer_text,model,provider) VALUES (?1,datetime('now'),?2,'personal','direct',1,?3,?4,?5,?5,'unreviewed',?6,?7,'source-excerpt','Local library')",rusqlite::params![id,assist_question,serde_json::to_string(&sources).unwrap_or_default(),decision_ms,elapsed as i64,question_end_wall_ms,content]).map_err(|e|e.to_string())?;}
            let _=app_handle.emit("llm_stream_start",crate::llm::provider::StreamStartPayload{mode:"Assist".into(),model:"source-excerpt".into(),provider:"Local library".into(),system_prompt:String::new(),user_prompt:assist_question.clone(),include_transcript:false,include_rag:true,include_instructions:false,include_question:true,temperature:0.0,rag_query:Some(assist_question.clone()),rag_chunks:rag_chunk_infos.clone(),rag_chunks_filtered:0,rag_total_candidates:rag_chunk_infos.len(),transcript_window_seconds:0,transcript_segments_count:0,transcript_segments_total:0,interview_event_id:Some(id),question_end_wall_ms,personal_evidence:None});
            let _=app_handle.emit("llm_stream_token",crate::llm::provider::StreamTokenPayload{token:content});
            let _=app_handle.emit("llm_stream_end",crate::llm::provider::StreamEndPayload{total_tokens:0,latency_ms:elapsed});
            if let Some(intel)=state.intelligence.as_ref(){if let Ok(engine)=intel.lock(){engine.set_generating(false);}}
            return Ok(());
        }
    }

    if mode=="Assist" && assist_kind==crate::intelligence::question_route::QuestionType::Personal && personal_evidence.is_none() {
        let content=if assist_chinese {"- 未找到支持这段个人经历的本地资料。\n- 请先补充并核对简历或项目材料，再回答具体职责与结果。"} else {"- No supporting personal material was retrieved.\n- Add and verify resume or project evidence before claiming specific responsibilities or results."};
        let elapsed=answer_elapsed(&assist_started,question_end_wall_ms) as u64;
        let id=uuid::Uuid::new_v4().to_string();
        if let Some(db_arc)=state.database.as_ref(){let db=db_arc.lock().map_err(|e|e.to_string())?;
            db.connection().execute("INSERT INTO interview_answer_events(id,created_at,question,question_type,route,hit,source_paths,decision_ms,first_hint_ms,complete_hint_ms,quality,question_end_wall_ms,answer_text,model,provider) VALUES (?1,datetime('now'),?2,'personal','direct',0,'[]',?3,?4,?4,'unreviewed',?5,?6,'evidence-gate','Local library')",rusqlite::params![id,assist_question,decision_ms,elapsed as i64,question_end_wall_ms,content]).map_err(|e|e.to_string())?;}
        let _=app_handle.emit("llm_stream_start",crate::llm::provider::StreamStartPayload{mode:"Assist".into(),model:"evidence-gate".into(),provider:"Local library".into(),system_prompt:String::new(),user_prompt:assist_question.clone(),include_transcript:false,include_rag:false,include_instructions:false,include_question:true,temperature:0.0,rag_query:Some(assist_question.clone()),rag_chunks:Vec::new(),rag_chunks_filtered:0,rag_total_candidates:0,transcript_window_seconds:0,transcript_segments_count:0,transcript_segments_total:0,interview_event_id:Some(id),question_end_wall_ms,personal_evidence:None});
        let _=app_handle.emit("llm_stream_token",crate::llm::provider::StreamTokenPayload{token:content.into()});
        let _=app_handle.emit("llm_stream_end",crate::llm::provider::StreamEndPayload{total_tokens:0,latency_ms:elapsed});
        if let Some(intel)=state.intelligence.as_ref(){if let Ok(engine)=intel.lock(){engine.set_generating(false);}}
        return Ok(());
    }

    // Get the LLM provider and model info
    let (provider_arc, model, provider_name) = {
        let llm = state
            .llm
            .as_ref()
            .ok_or_else(|| "LLM router not initialized".to_string())?;
        let router = llm
            .lock()
            .map_err(|e| format!("Failed to lock LLM router: {}", e))?;
        if mode=="Assist" && !(router.active_provider_type().map(|provider|provider.is_local()).unwrap_or(false)
            && router.active_base_url().map(loopback_model_endpoint).unwrap_or(false)) {
            return Err("Interview Assist generation requires Ollama or LM Studio at a loopback URL to keep personal materials on device".into());
        }

        let provider = router
            .get_provider()
            .map_err(|e| format!("No active LLM provider: {}", e))?;

        let model_name = router.active_model().to_string();
        if model_name.is_empty() {
            return Err("No active model selected".to_string());
        }

        let ptype = router
            .active_provider_type()
            .map(|pt| pt.display_name().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        (provider, model_name, ptype)
    };

    // Run the generation asynchronously
    let mode_clone = mode.clone();
    let answer_route=if interview_model_context_hit {"rag_generate"} else {"direct"};
    let answer_sources:Vec<String>=rag_chunk_infos.iter().map(|c|c.source.clone()).collect();
    let answer_event_id=if mode=="Assist" {Some(uuid::Uuid::new_v4().to_string())}else{None};
    if let (Some(id),Some(db_arc))=(answer_event_id.as_ref(),state.database.as_ref()) {
        let db=db_arc.lock().map_err(|e|e.to_string())?;
        db.connection().execute("INSERT INTO interview_answer_events(id,created_at,question,question_type,route,hit,source_paths,decision_ms,quality,question_end_wall_ms,model,provider) VALUES (?1,datetime('now'),?2,?3,?4,?5,?6,?7,'unreviewed',?8,?9,?10)",rusqlite::params![id,assist_question,assist_kind.as_str(),answer_route,(!answer_sources.is_empty()) as i64,serde_json::to_string(&answer_sources).unwrap_or_default(),decision_ms,question_end_wall_ms,model,provider_name]).map_err(|e|e.to_string())?;
    }
    let mixed_assist=mode=="Assist" && assist_kind==crate::intelligence::question_route::QuestionType::Mixed;
    let technical_question=if mixed_assist {Some(crate::intelligence::question_route::technical_part(&assist_question))}else{None};
    let generation_question=technical_question.as_deref().or(custom_question.as_deref());
    let mut generation_detected_question=effective_question;
    if let (Some(subject),Some(question))=(technical_question.as_ref(),generation_detected_question.as_mut()) {question.text=subject.clone();}
    let mixed_personal_evidence=if mixed_assist {Some(personal_evidence.unwrap_or_else(||if assist_chinese {"未找到支持个人项目部分的本地资料。".into()}else{"No supporting personal project material was retrieved.".into()}))}else{None};
    let result = IntelligenceEngine::generate_assist(
        &system_prompt,
        &mode_clone,
        generation_question,
        if mixed_assist {String::new()} else {transcript_text},
        generation_detected_question,
        context_text,
        include_context,
        include_transcript && !mixed_assist,
        include_question,
        include_rag,
        include_instructions,
        provider_arc,
        model,
        provider_name,
        params,
        temperature,
        rag_query_text,
        rag_chunk_infos,
        rag_chunks_filtered,
        rag_total_candidates,
        window_seconds,
        included_segments,
        total_segments,
        answer_event_id.clone(),
        question_end_wall_ms,
        mixed_personal_evidence,
        app_handle,
        cancel_flag,
    )
    .await;

    if let (Some(id),Some(db_arc))=(answer_event_id.as_ref(),state.database.as_ref()) {
        if let Ok(db)=db_arc.lock() {
            let _=db.connection().execute("UPDATE interview_answer_events SET complete_hint_ms=?1,quality=CASE WHEN ?2 THEN quality ELSE 'generation_error' END WHERE id=?3",rusqlite::params![answer_elapsed(&assist_started,question_end_wall_ms),result.is_ok(),id]);
        }
    }

    // Clear generating state
    {
        let intel = state.intelligence.as_ref();
        if let Some(intel) = intel {
            if let Ok(engine) = intel.lock() {
                engine.set_generating(false);
            }
        }
    }

    result
}

#[command]
pub async fn cancel_generation(state: State<'_, AppState>) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    engine.cancel();
    engine.set_generating(false);

    // Cancellation is handled via the atomic flag in IntelligenceEngine.
    // The LLM provider stream will check for cancellation on the next iteration.
    log::info!("Generation cancelled");
    Ok(())
}

#[command]
pub async fn set_auto_trigger(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    engine.set_auto_trigger(enabled);
    log::info!("Auto-trigger set to: {}", enabled);
    Ok(())
}

#[command]
pub async fn set_context_window_seconds(
    seconds: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let mut engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    engine.set_context_window(seconds);
    log::info!("Context window set to: {}s", seconds);
    Ok(())
}

/// Push a transcript segment to the intelligence engine's buffer.
/// Called from the frontend when Web Speech API produces results.
#[command]
pub async fn push_transcript(
    text: String,
    speaker: String,
    timestamp_ms: u64,
    is_final: bool,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let mut engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    // Clone text and speaker before they are moved into push_transcript
    let text_clone = text.clone();
    let speaker_clone = speaker.clone();

    let questions = engine.push_transcript(text, speaker, timestamp_ms, is_final);

    // Emit question detected events
    for q in questions {
        let payload = serde_json::json!({
            "text": q.text,
            "confidence": q.confidence,
            "timestamp_ms": q.timestamp_ms,
            "source": q.source,
        });
        let _ = app_handle.emit("question_detected", &payload);
    }

    // Feed transcript to RAG indexer if enabled
    if is_final {
        if let Some(rag_arc) = state.rag.as_ref() {
            if let Ok(mut rag_mgr) = rag_arc.lock() {
                if rag_mgr.config().enabled && rag_mgr.config().include_transcript {
                    if let Some(indexer) = rag_mgr.transcript_indexer_mut() {
                        indexer.push_segment(&text_clone, &speaker_clone, timestamp_ms);
                    }
                }
            }
        }
    }

    Ok(())
}

/// Update action configs from the frontend.
/// Frontend is the source of truth — this syncs to backend IntelligenceEngine.
#[command]
pub async fn update_action_configs(
    configs_json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let configs: AllActionConfigs = serde_json::from_str(&configs_json)
        .map_err(|e| format!("Failed to parse action configs: {}", e))?;

    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let mut engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    // Also sync global defaults to intelligence engine settings
    engine.set_auto_trigger(configs.global_defaults.auto_trigger);
    engine.set_context_window(configs.global_defaults.transcript_window_seconds);

    engine.set_action_configs(configs);

    log::info!("Action configs updated from frontend");
    Ok(())
}

/// Set the active scenario prompts from the frontend (called at meeting start).
/// The intelligence pipeline reads these for scenario-aware prompt assembly.
#[command]
pub async fn set_active_scenario(
    system_prompt: String,
    summary_prompt: String,
    question_detection_prompt: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut scenario = state
        .active_scenario
        .write()
        .map_err(|e| format!("Failed to lock active scenario: {}", e))?;
    scenario.system_prompt = system_prompt;
    scenario.summary_prompt = summary_prompt;
    scenario.question_detection_prompt = question_detection_prompt;
    log::info!(
        "Active scenario updated (system_prompt len={}, summary_prompt len={})",
        scenario.system_prompt.len(),
        scenario.summary_prompt.len()
    );
    Ok(())
}

/// Update the speaker context within the active scenario.
/// Called by the frontend when speaker information changes during a meeting.
#[command]
pub async fn update_speaker_context(
    speaker_context: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut scenario = state
        .active_scenario
        .write()
        .map_err(|e| format!("Failed to lock active scenario: {}", e))?;
    scenario.speaker_context = speaker_context;
    log::info!(
        "Speaker context updated (len={})",
        scenario.speaker_context.len()
    );
    Ok(())
}

/// Get current action configs from the backend.
#[command]
pub async fn get_action_configs(state: State<'_, AppState>) -> Result<String, String> {
    let intel = state
        .intelligence
        .as_ref()
        .ok_or_else(|| "Intelligence engine not initialized".to_string())?;

    let engine = intel
        .lock()
        .map_err(|e| format!("Failed to lock intelligence engine: {}", e))?;

    let configs = engine.get_action_configs();
    serde_json::to_string(configs).map_err(|e| format!("Failed to serialize action configs: {}", e))
}

// Dual-pass local Whisper.cpp STT provider.
//
// Two passes on the same audio stream:
//   Fast pass  (~4s chunks): interim text with enough acoustic context
//   Correction (full line audio): higher-accuracy result, word-level diff patches
//
// Key design:
//   - Energy gate: only queue inference when audio has actual speech
//   - Hallucination filter: strip [BLANK_AUDIO], brackets, common whisper artifacts
//   - Correction uses ALL audio for the current line (not a rolling window)
//   - Pause detection is based on acoustic silence, not model feedback latency
//   - Aggressive stop: drop channels immediately, don't block on pending tasks
//   - Queue limit: drop stale fast passes if inference falls behind

use async_trait::async_trait;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{DualPassConfig, STTProvider, STTProviderType, TranscriptResult};
use crate::stt::word_diff;

const SAMPLE_RATE: u32 = 16000;

/// Maximum line duration in seconds before force-finalize.
const MAX_LINE_SECS: f32 = 30.0;

/// Minimum RMS for audio to be considered "speech" (energy gate).
/// Below this, chunks are accumulated but NOT sent to inference.
// The audio pipeline's VAD starts at 300 RMS. Its SpeechEnding state stays
// active during a pause, so use a slightly higher instantaneous threshold here
// to avoid sending steady microphone noise to Whisper as speech.
const SPEECH_RMS_THRESHOLD: f64 = 450.0;

/// Minimum above-threshold audio inside a fast-pass window.
const MIN_SPEECH_SAMPLES: usize = (SAMPLE_RATE as usize) / 12;

/// Maximum number of pending tasks before we start dropping old fast passes.
const MAX_QUEUE_SIZE: usize = 6;

// ── Hallucination filter ──

/// Strip whisper hallucination artifacts from output text.
/// Returns empty string if the entire text is a hallucination.
fn clean_whisper_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Remove all bracket/paren-enclosed content: [anything], (anything)
    let mut result = String::new();
    let mut in_bracket = 0i32;
    let mut in_paren = 0i32;
    for ch in trimmed.chars() {
        match ch {
            '[' => in_bracket += 1,
            ']' if in_bracket > 0 => {
                in_bracket -= 1;
                continue;
            }
            '(' => in_paren += 1,
            ')' if in_paren > 0 => {
                in_paren -= 1;
                continue;
            }
            _ if in_bracket > 0 || in_paren > 0 => continue,
            _ => result.push(ch),
        }
    }

    let cleaned = result.trim().to_string();
    // A verified false transcript from the short-window Whisper probe.
    // Match the whole utterance after removing punctuation and spaces so
    // unrelated speech that happens to mention the same name is retained.
    let compact: String = cleaned.chars().filter(|ch| ch.is_alphanumeric()).collect();
    let known_promo = compact
        .strip_prefix("请不吝点赞订阅转发打赏")
        .and_then(|rest| rest.strip_suffix("支持明镜与点点栏目"))
        .is_some_and(|middle| middle.is_empty() || middle == "打赏");
    if known_promo {
        return String::new();
    }

    // Check for common hallucination patterns (whisper produces these on silence)
    let lower = cleaned.to_lowercase();
    if lower.is_empty()
        || lower == "you"
        || lower == "thank you."
        || lower == "thank you"
        || lower == "thanks for watching."
        || lower == "thanks for watching"
        || lower == "bye."
        || lower == "bye"
        || lower == "the end"
        || lower == "so"
        || lower == "hmm"
        || lower == "uh"
        || lower.starts_with("subscribe")
        || lower.starts_with("please subscribe")
        || lower.contains("blank_audio")
        || lower.contains("blank audio")
    {
        return String::new();
    }

    // Too short to be meaningful (single punctuation, etc.)
    if cleaned.len() < 2 {
        return String::new();
    }

    cleaned
}

#[cfg(test)]
mod hallucination_tests {
    use super::clean_whisper_text;

    #[test]
    fn drops_only_the_reproduced_promo_utterance() {
        assert_eq!(
            clean_whisper_text("请不吝点赞,订阅、转发、打赏支持明镜与点点栏目。"),
            ""
        );
        assert_eq!(
            clean_whisper_text("请不吝点赞、订阅、转发、打赏，打赏支持明镜与点点栏目。"),
            ""
        );
        assert_eq!(
            clean_whisper_text("这个项目为什么叫明镜？"),
            "这个项目为什么叫明镜？"
        );
    }
}

/// Check if an audio buffer has enough energy to contain speech.
fn has_speech_energy(samples: &[i16]) -> bool {
    if samples.is_empty() {
        return false;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let rms = (sum_sq / samples.len() as f64).sqrt();
    rms > SPEECH_RMS_THRESHOLD
}

// ── Inference task types ──

enum InferenceTask {
    FastPass {
        samples: Vec<f32>,
        segment_id: String,
        timestamp_ms: u64,
    },
    CorrectionPass {
        samples: Vec<f32>,
        segment_id: String,
        timestamp_ms: u64,
        fast_words: Vec<String>,
    },
    Finalize {
        segment_id: String,
        samples: Vec<f32>,
        timestamp_ms: u64,
    },
    Shutdown,
}

impl InferenceTask {
    fn priority(&self) -> u8 {
        match self {
            InferenceTask::FastPass { .. } => 5,
            InferenceTask::CorrectionPass { .. } => 8,
            InferenceTask::Finalize { .. } => 10,
            InferenceTask::Shutdown => 0,
        }
    }
}

struct PrioritizedTask {
    task: InferenceTask,
    seq: u64,
}

impl PartialEq for PrioritizedTask {
    fn eq(&self, other: &Self) -> bool {
        self.task.priority() == other.task.priority() && self.seq == other.seq
    }
}
impl Eq for PrioritizedTask {}

impl PartialOrd for PrioritizedTask {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PrioritizedTask {
    fn cmp(&self, other: &Self) -> Ordering {
        self.task
            .priority()
            .cmp(&other.task.priority())
            .then_with(|| other.seq.cmp(&self.seq))
    }
}

/// Feedback from inference thread back to the provider.
struct FastPassFeedback {
    text: String,
}

// ── WhisperCppSTT ──

pub struct WhisperCppSTT {
    model_path: PathBuf,
    language: String,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    stop_flag: Arc<AtomicBool>,
    start_time: Option<Instant>,
    config: Arc<RwLock<DualPassConfig>>,
    topic_prompt: Arc<RwLock<String>>,

    // Fast-pass buffer: drain when short_chunk_secs reached
    fast_buffer: Vec<i16>,

    // ALL audio for the current line (for correction pass)
    line_audio: Vec<i16>,

    // Whether the current fast_buffer has speech energy
    buffer_has_speech: bool,
    speech_samples_in_buffer: usize,

    // Accumulated fast-pass text for current line (fed by feedback channel)
    fast_text_this_line: String,

    // Line counter for segment IDs
    line_counter: u64,

    // Whether any fast pass produced real content on the current line
    has_content_this_line: bool,

    // Last audio chunk with speech energy; model inference can lag behind audio.
    last_speech_time: Option<Instant>,

    // Correction pass throttle
    last_correction_time: Option<Instant>,

    // Inference thread
    inference_tx: Option<std::sync::mpsc::Sender<InferenceTask>>,
    inference_thread: Option<std::thread::JoinHandle<()>>,

    // Feedback channel
    feedback_rx: Option<std::sync::Mutex<std::sync::mpsc::Receiver<FastPassFeedback>>>,
}

impl WhisperCppSTT {
    pub fn new(model_path: PathBuf, config: Arc<RwLock<DualPassConfig>>) -> Self {
        Self {
            model_path,
            language: "en".to_string(),
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            start_time: None,
            config,
            topic_prompt: Arc::new(RwLock::new(String::new())),
            fast_buffer: Vec::new(),
            line_audio: Vec::new(),
            buffer_has_speech: false,
            speech_samples_in_buffer: 0,
            fast_text_this_line: String::new(),
            line_counter: 0,
            has_content_this_line: false,
            last_speech_time: None,
            last_correction_time: None,
            inference_tx: None,
            inference_thread: None,
            feedback_rx: None,
        }
    }

    pub fn set_topic_prompt(&mut self, prompt: Arc<RwLock<String>>) {
        self.topic_prompt = prompt;
    }

    fn current_segment_id(&self) -> String {
        format!("line_{}", self.line_counter)
    }

    fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
        samples.iter().map(|&s| s as f32 / 32768.0).collect()
    }

    fn send_task(&self, task: InferenceTask) {
        if let Some(ref tx) = self.inference_tx {
            let _ = tx.send(task);
        }
    }

    fn drain_feedback(&mut self) {
        if let Some(ref rx_mutex) = self.feedback_rx {
            if let Ok(rx) = rx_mutex.lock() {
                while let Ok(fb) = rx.try_recv() {
                    if !fb.text.is_empty() {
                        if !self.fast_text_this_line.is_empty() {
                            self.fast_text_this_line.push(' ');
                        }
                        self.fast_text_this_line.push_str(&fb.text);
                    }
                }
            }
        }
    }

    fn start_new_line(&mut self) {
        self.line_counter += 1;
        self.fast_text_this_line.clear();
        self.fast_buffer.clear();
        self.line_audio.clear();
        self.buffer_has_speech = false;
        self.speech_samples_in_buffer = 0;
        self.has_content_this_line = false;
        self.last_speech_time = None;
        self.last_correction_time = None;
    }
}

#[async_trait]
impl STTProvider for WhisperCppSTT {
    fn provider_name(&self) -> &str {
        "Whisper.cpp (Local)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::WhisperCpp
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        if !self.model_path.exists() {
            return Err(
                format!("Whisper model not found at: {}", self.model_path.display()).into(),
            );
        }

        let config = self.config.read().unwrap().clone();
        log::info!(
            "WhisperCppSTT: Starting stream (model: {}, fast: {}s, correction: {}s, pause: {}s)",
            self.model_path.display(),
            config.short_chunk_secs,
            config.long_chunk_secs,
            config.pause_secs,
        );

        let (inf_tx, inf_rx) = std::sync::mpsc::channel::<InferenceTask>();
        let (fb_tx, fb_rx) = std::sync::mpsc::channel::<FastPassFeedback>();
        let model_path = self.model_path.clone();
        let language = self.language.clone();
        let stop_flag = Arc::clone(&self.stop_flag);
        let topic_prompt = Arc::clone(&self.topic_prompt);
        let tx = result_tx.clone();

        let thread = std::thread::spawn(move || {
            use whisper_rs::{
                FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
            };

            // Suppress whisper.cpp verbose output by setting log callback to no-op
            // (whisper-rs 0.16 may not expose this; we rely on params instead)

            let model_str = model_path.to_string_lossy().to_string();
            let ctx = match WhisperContext::new_with_params(
                &model_str,
                WhisperContextParameters::default(),
            ) {
                Ok(ctx) => ctx,
                Err(e) => {
                    log::error!("WhisperCppSTT: Failed to load model: {}", e);
                    return;
                }
            };

            let mut state = match ctx.create_state() {
                Ok(s) => s,
                Err(e) => {
                    log::error!("WhisperCppSTT: Failed to create state: {}", e);
                    return;
                }
            };

            log::info!("WhisperCppSTT: Model loaded, inference thread ready");

            let mut pending = BinaryHeap::<PrioritizedTask>::new();
            let mut seq_counter = 0u64;
            let mut last_emitted_text = String::new();
            let mut superseded_segments = HashSet::<String>::new();
            let mut finalized_segments = HashSet::<String>::new();

            let run_whisper = |state: &mut whisper_rs::WhisperState,
                               samples: &[f32],
                               lang: &str|
             -> String {
                let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                let lang_code = lang.split('-').next().unwrap_or(lang);
                params.set_language(if lang_code == "auto" {
                    None
                } else {
                    Some(lang_code)
                });
                params.set_print_special(false);
                params.set_print_progress(false);
                params.set_print_realtime(false);
                params.set_print_timestamps(false);
                params.set_n_threads(4);
                params.set_no_context(true);
                if let Ok(prompt) = topic_prompt.read() {
                    if !prompt.is_empty() {
                        params.set_initial_prompt(&prompt);
                    }
                }
                // Suppress blank/silence hallucinations
                params.set_suppress_blank(true);
                params.set_suppress_nst(true);
                // Higher no-speech threshold to avoid transcribing silence
                params.set_no_speech_thold(0.6);

                match state.full(params, samples) {
                    Ok(()) => {
                        if lang_code == "auto" {
                            let detected =
                                whisper_rs::get_lang_str(state.full_lang_id_from_state())
                                    .unwrap_or("");
                            if detected != "zh" && detected != "en" {
                                log::debug!(
                                    "WhisperCppSTT: Discarding unexpected auto-detected language: {}",
                                    detected
                                );
                                return String::new();
                            }
                        }
                        let n = state.full_n_segments();
                        let mut text = String::new();
                        for i in 0..n {
                            if let Some(seg) = state.get_segment(i) {
                                if let Ok(t) = seg.to_str() {
                                    text.push_str(t);
                                }
                            }
                        }
                        // Apply hallucination filter
                        clean_whisper_text(&text)
                    }
                    Err(e) => {
                        log::error!("WhisperCppSTT: Inference failed: {}", e);
                        String::new()
                    }
                }
            };

            loop {
                // Check stop flag FIRST — exit immediately if stopped
                if stop_flag.load(AtomicOrdering::SeqCst) {
                    log::info!("WhisperCppSTT: Stop flag set, exiting inference thread");
                    break;
                }

                // Drain all available tasks
                while let Ok(task) = inf_rx.try_recv() {
                    seq_counter += 1;
                    pending.push(PrioritizedTask {
                        task,
                        seq: seq_counter,
                    });
                }

                // If empty, block until one arrives (with timeout to check stop_flag)
                if pending.is_empty() {
                    match inf_rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(task) => {
                            seq_counter += 1;
                            pending.push(PrioritizedTask {
                                task,
                                seq: seq_counter,
                            });
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    // Drain any more that arrived
                    while let Ok(task) = inf_rx.try_recv() {
                        seq_counter += 1;
                        pending.push(PrioritizedTask {
                            task,
                            seq: seq_counter,
                        });
                    }
                }

                // Queue limit: if too many tasks, drop older fast passes
                while pending.len() > MAX_QUEUE_SIZE {
                    // Peek — if it's a FastPass, drop it; otherwise keep it
                    if let Some(ptask) = pending.peek() {
                        match ptask.task {
                            InferenceTask::FastPass { .. } => {
                                pending.pop(); // drop stale fast pass
                            }
                            _ => break, // don't drop non-fast tasks
                        }
                    } else {
                        break;
                    }
                }

                // Pop highest priority task
                let ptask = match pending.pop() {
                    Some(t) => t,
                    None => continue,
                };

                // Check stop flag again before expensive inference
                if stop_flag.load(AtomicOrdering::SeqCst) {
                    break;
                }

                match ptask.task {
                    InferenceTask::Shutdown => break,

                    InferenceTask::FastPass {
                        samples,
                        segment_id,
                        timestamp_ms,
                    } => {
                        // A full-line correction or final result is already better
                        // grounded than this older short-window preview.
                        if superseded_segments.contains(&segment_id) {
                            continue;
                        }
                        let text = run_whisper(&mut state, &samples, &language);
                        if !text.is_empty() {
                            let _ = fb_tx.send(FastPassFeedback { text: text.clone() });

                            if text != last_emitted_text {
                                last_emitted_text = text.clone();
                                let _ = tx.blocking_send(TranscriptResult {
                                    text,
                                    is_final: false,
                                    confidence: 0.80,
                                    timestamp_ms,
                                    speaker: None,
                                    language: Some(language.clone()),
                                    segment_id: Some(segment_id),
                                });
                            }
                        }
                    }

                    InferenceTask::CorrectionPass {
                        samples,
                        segment_id,
                        timestamp_ms,
                        fast_words,
                    } => {
                        if finalized_segments.contains(&segment_id) {
                            continue;
                        }
                        let correction_text = run_whisper(&mut state, &samples, &language);
                        if correction_text.is_empty() {
                            continue;
                        }
                        superseded_segments.insert(segment_id.clone());

                        let correction_words: Vec<&str> =
                            correction_text.split_whitespace().collect();
                        let old_words: Vec<&str> = fast_words.iter().map(|s| s.as_str()).collect();

                        let merged = word_diff::merge_correction(&old_words, &correction_words);

                        if !merged.is_empty() && merged != last_emitted_text {
                            last_emitted_text = merged.clone();
                            let _ = tx.blocking_send(TranscriptResult {
                                text: merged,
                                is_final: false,
                                confidence: 0.92,
                                timestamp_ms,
                                speaker: None,
                                language: Some(language.clone()),
                                segment_id: Some(segment_id),
                            });
                        }
                    }

                    InferenceTask::Finalize {
                        segment_id,
                        samples,
                        timestamp_ms,
                    } => {
                        superseded_segments.insert(segment_id.clone());
                        finalized_segments.insert(segment_id.clone());
                        last_emitted_text.clear();

                        // Commit only a decoding of the complete utterance. A
                        // speculative preview must never become a final transcript.
                        let text = run_whisper(&mut state, &samples, &language);

                        if !text.is_empty() {
                            let _ = tx.blocking_send(TranscriptResult {
                                text,
                                is_final: true,
                                confidence: 0.92,
                                timestamp_ms,
                                speaker: None,
                                language: Some(language.clone()),
                                segment_id: Some(segment_id),
                            });
                        }
                    }
                }
            }

            log::info!("WhisperCppSTT: Inference thread exiting");
        });

        self.result_tx = Some(result_tx);
        self.inference_tx = Some(inf_tx);
        self.feedback_rx = Some(std::sync::Mutex::new(fb_rx));
        self.inference_thread = Some(thread);
        self.is_streaming = true;
        self.stop_flag.store(false, AtomicOrdering::SeqCst);
        self.start_time = Some(Instant::now());
        self.fast_buffer.clear();
        self.line_audio.clear();
        self.buffer_has_speech = false;
        self.speech_samples_in_buffer = 0;
        self.fast_text_this_line.clear();
        self.line_counter = 0;
        self.has_content_this_line = false;
        self.last_speech_time = None;
        self.last_correction_time = None;

        log::info!("WhisperCppSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming || self.stop_flag.load(AtomicOrdering::SeqCst) {
            return Ok(());
        }

        // Drain feedback
        self.drain_feedback();

        // Read live config
        let config = self.config.read().unwrap().clone();
        let short_samples = (SAMPLE_RATE as f32 * config.short_chunk_secs) as usize;
        let max_line_samples = (SAMPLE_RATE as f32 * MAX_LINE_SECS) as usize;

        // Track if this chunk has speech energy
        if chunk.is_speech && has_speech_energy(&chunk.pcm_data) {
            self.speech_samples_in_buffer += chunk.pcm_data.len();
            self.buffer_has_speech = self.speech_samples_in_buffer >= MIN_SPEECH_SAMPLES;
            if self.buffer_has_speech {
                self.has_content_this_line = true;
            }
            self.last_speech_time = Some(Instant::now());
        }

        // Accumulate audio
        self.fast_buffer.extend_from_slice(&chunk.pcm_data);
        self.line_audio.extend_from_slice(&chunk.pcm_data);
        if !self.has_content_this_line
            && !self.buffer_has_speech
            && self.line_audio.len() > 2 * SAMPLE_RATE as usize
            && self
                .last_speech_time
                .map_or(true, |last| last.elapsed() > Duration::from_secs(2))
        {
            // Keep one second of pre-roll, but do not retain unbounded idle audio.
            let excess = self.line_audio.len() - SAMPLE_RATE as usize;
            self.line_audio.drain(..excess);
        }

        let timestamp_ms = self
            .start_time
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(chunk.timestamp_ms);

        // ── Fast pass: fire when buffer full AND contains speech ──
        if self.fast_buffer.len() >= short_samples {
            if self.buffer_has_speech {
                let samples_i16 = std::mem::take(&mut self.fast_buffer);
                let samples_f32 = Self::i16_to_f32(&samples_i16);
                let seg_id = self.current_segment_id();

                self.send_task(InferenceTask::FastPass {
                    samples: samples_f32,
                    segment_id: seg_id,
                    timestamp_ms,
                });

                self.has_content_this_line = true;
            } else {
                // No speech — discard the buffer, don't queue inference
                self.fast_buffer.clear();
            }
            self.buffer_has_speech = false;
            self.speech_samples_in_buffer = 0;
        }

        // ── Correction pass: transcribe FULL line audio, throttled ──
        let min_correction_samples = (SAMPLE_RATE as f32 * config.long_chunk_secs) as usize;
        let should_correct = self.has_content_this_line
            && self.line_audio.len() >= min_correction_samples
            && match self.last_correction_time {
                Some(last) => last.elapsed().as_secs_f32() >= config.long_chunk_secs,
                None => true,
            };

        if should_correct {
            let samples_f32 = Self::i16_to_f32(&self.line_audio);
            let seg_id = self.current_segment_id();
            let fast_words: Vec<String> = self
                .fast_text_this_line
                .split_whitespace()
                .map(|w| w.to_string())
                .collect();

            self.send_task(InferenceTask::CorrectionPass {
                samples: samples_f32,
                segment_id: seg_id,
                timestamp_ms,
                fast_words,
            });

            self.last_correction_time = Some(Instant::now());
        }

        // ── Pause detection: finalize after acoustic silence ──
        let should_finalize = self.has_content_this_line
            && match self.last_speech_time {
                Some(last) => last.elapsed().as_secs_f32() >= config.pause_secs,
                None => false,
            };

        let force_finalize =
            self.has_content_this_line && self.line_audio.len() >= max_line_samples;

        if should_finalize || force_finalize {
            self.drain_feedback();

            let seg_id = self.current_segment_id();
            let samples = Self::i16_to_f32(&self.line_audio);

            self.send_task(InferenceTask::Finalize {
                segment_id: seg_id,
                samples,
                timestamp_ms,
            });

            self.start_new_line();
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        log::info!("WhisperCppSTT: Stopping stream");

        // Set stop flag IMMEDIATELY — inference thread checks this before each task
        self.stop_flag.store(true, AtomicOrdering::SeqCst);

        // Send shutdown signal
        self.send_task(InferenceTask::Shutdown);

        // Drop channels immediately to prevent old results from leaking
        // into new meetings. This closes the mpsc channels, causing
        // blocking_send to fail and recv to return None.
        self.inference_tx = None;
        self.feedback_rx = None;
        self.result_tx = None;

        // Join with timeout — don't block forever if inference is stuck
        if let Some(thread) = self.inference_thread.take() {
            let join_deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if thread.is_finished() {
                    let _ = thread.join();
                    break;
                }
                if Instant::now() >= join_deadline {
                    log::warn!("WhisperCppSTT: Inference thread didn't stop in 2s, detaching");
                    // Thread will exit eventually when it checks stop_flag
                    // or when the channel is closed
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        self.is_streaming = false;
        self.start_time = None;

        log::info!("WhisperCppSTT: Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.model_path.exists())
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.split('-').next().unwrap_or(language).to_string();
        log::info!("WhisperCppSTT: Language set to {}", self.language);
    }
}

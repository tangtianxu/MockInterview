//! Streaming Chinese/English ASR through the official sherpa-onnx C API.
//! ABI pinned to sherpa-onnx v1.13.8. The three DLLs are app resources, while
//! model weights are downloaded separately into the user's model directory.

use async_trait::async_trait;
use libloading::Library;
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::{Path, PathBuf},
    sync::mpsc as std_mpsc,
    thread,
};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::{
    audio::AudioChunk,
    stt::provider::{STTProvider, STTProviderType, TranscriptResult},
};

#[repr(C)]
#[derive(Default)]
struct TransducerConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}
#[repr(C)]
#[derive(Default)]
struct ParaformerConfig {
    encoder: *const c_char,
    decoder: *const c_char,
}
#[repr(C)]
#[derive(Default)]
struct SingleModelConfig {
    model: *const c_char,
}
#[repr(C)]
#[derive(Default)]
struct OnlineModelConfig {
    transducer: TransducerConfig,
    paraformer: ParaformerConfig,
    zipformer2_ctc: SingleModelConfig,
    tokens: *const c_char,
    num_threads: i32,
    provider: *const c_char,
    debug: i32,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    tokens_buf: *const c_char,
    tokens_buf_size: i32,
    nemo_ctc: SingleModelConfig,
    t_one_ctc: SingleModelConfig,
}
#[repr(C)]
#[derive(Default)]
struct FeatureConfig {
    sample_rate: i32,
    feature_dim: i32,
}
#[repr(C)]
#[derive(Default)]
struct CtcFstConfig {
    graph: *const c_char,
    max_active: i32,
}
#[repr(C)]
#[derive(Default)]
struct HomophoneConfig {
    dict_dir: *const c_char,
    lexicon: *const c_char,
    rule_fsts: *const c_char,
}
#[repr(C)]
#[derive(Default)]
struct OnlineRecognizerConfig {
    feat_config: FeatureConfig,
    model_config: OnlineModelConfig,
    decoding_method: *const c_char,
    max_active_paths: i32,
    enable_endpoint: i32,
    rule1_min_trailing_silence: f32,
    rule2_min_trailing_silence: f32,
    rule3_min_utterance_length: f32,
    hotwords_file: *const c_char,
    hotwords_score: f32,
    ctc_fst_decoder_config: CtcFstConfig,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
    blank_penalty: f32,
    hotwords_buf: *const c_char,
    hotwords_buf_size: i32,
    hr: HomophoneConfig,
}
#[repr(C)]
struct OnlineResult {
    text: *const c_char,
}

type CreateRecognizer = unsafe extern "C" fn(*const OnlineRecognizerConfig) -> *const c_void;
type DestroyRecognizer = unsafe extern "C" fn(*const c_void);
type CreateStream = unsafe extern "C" fn(*const c_void) -> *const c_void;
type DestroyStream = unsafe extern "C" fn(*const c_void);
type AcceptWaveform = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type IsReady = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type Decode = unsafe extern "C" fn(*const c_void, *const c_void);
type GetResult = unsafe extern "C" fn(*const c_void, *const c_void) -> *const OnlineResult;
type DestroyResult = unsafe extern "C" fn(*const OnlineResult);
type IsEndpoint = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type Reset = unsafe extern "C" fn(*const c_void, *const c_void);
type InputFinished = unsafe extern "C" fn(*const c_void);

struct Api {
    _runtime: Library,
    _providers: Library,
    _sherpa: Library,
    create_recognizer: CreateRecognizer,
    destroy_recognizer: DestroyRecognizer,
    create_stream: CreateStream,
    destroy_stream: DestroyStream,
    accept: AcceptWaveform,
    ready: IsReady,
    decode: Decode,
    result: GetResult,
    destroy_result: DestroyResult,
    endpoint: IsEndpoint,
    reset: Reset,
    input_finished: InputFinished,
}

impl Api {
    unsafe fn load(dir: &Path) -> Result<Self, String> {
        let runtime = Library::new(dir.join("onnxruntime.dll"))
            .map_err(|e| format!("加载 ONNX Runtime 失败：{e}"))?;
        let providers = Library::new(dir.join("onnxruntime_providers_shared.dll"))
            .map_err(|e| format!("加载 ONNX Provider 失败：{e}"))?;
        let sherpa = Library::new(dir.join("sherpa-onnx-c-api.dll"))
            .map_err(|e| format!("加载 sherpa-onnx 失败：{e}"))?;
        unsafe fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            lib.get::<T>(name)
                .map(|s| *s)
                .map_err(|e| format!("sherpa-onnx 函数缺失：{e}"))
        }
        Ok(Self {
            create_recognizer: symbol(&sherpa, b"SherpaOnnxCreateOnlineRecognizer\0")?,
            destroy_recognizer: symbol(&sherpa, b"SherpaOnnxDestroyOnlineRecognizer\0")?,
            create_stream: symbol(&sherpa, b"SherpaOnnxCreateOnlineStream\0")?,
            destroy_stream: symbol(&sherpa, b"SherpaOnnxDestroyOnlineStream\0")?,
            accept: symbol(&sherpa, b"SherpaOnnxOnlineStreamAcceptWaveform\0")?,
            ready: symbol(&sherpa, b"SherpaOnnxIsOnlineStreamReady\0")?,
            decode: symbol(&sherpa, b"SherpaOnnxDecodeOnlineStream\0")?,
            result: symbol(&sherpa, b"SherpaOnnxGetOnlineStreamResult\0")?,
            destroy_result: symbol(&sherpa, b"SherpaOnnxDestroyOnlineRecognizerResult\0")?,
            endpoint: symbol(&sherpa, b"SherpaOnnxOnlineStreamIsEndpoint\0")?,
            reset: symbol(&sherpa, b"SherpaOnnxOnlineStreamReset\0")?,
            input_finished: symbol(&sherpa, b"SherpaOnnxOnlineStreamInputFinished\0")?,
            _runtime: runtime,
            _providers: providers,
            _sherpa: sherpa,
        })
    }
}

#[derive(Clone)]
struct ModelFiles {
    encoder: PathBuf,
    decoder: PathBuf,
    joiner: Option<PathBuf>,
    tokens: PathBuf,
}

fn files(dir: &Path, model_id: &str) -> Result<ModelFiles, String> {
    let (encoder, decoder, joiner) = match model_id {
        "zipformer-zh-en" => (
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            Some("joiner-epoch-99-avg-1.int8.onnx"),
        ),
        "paraformer-zh-en" => ("encoder.int8.onnx", "decoder.int8.onnx", None),
        _ => return Err(format!("未适配的模型：{model_id}")),
    };
    let paths = ModelFiles {
        encoder: dir.join(encoder),
        decoder: dir.join(decoder),
        joiner: joiner.map(|name| dir.join(name)),
        tokens: dir.join("tokens.txt"),
    };
    for path in [&paths.encoder, &paths.decoder, &paths.tokens]
        .into_iter()
        .chain(paths.joiner.iter())
    {
        if !path.is_file() {
            return Err(format!("模型缺少文件：{}", path.display()));
        }
    }
    Ok(paths)
}

pub(crate) fn model_files_available(dir: &Path, model_id: &str) -> bool {
    files(dir, model_id).is_ok()
}

fn dll_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let installed = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("sherpa-onnx");
    if installed.join("sherpa-onnx-c-api.dll").is_file() {
        return Ok(installed);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sherpa-onnx");
    if development.join("sherpa-onnx-c-api.dll").is_file() {
        return Ok(development);
    }
    Err("未找到 sherpa-onnx 运行库，请重新安装完整版本".into())
}

enum AudioMessage {
    Samples(Vec<i16>, u64),
    Stop,
}

pub struct SherpaBilingualSTT {
    model_dir: PathBuf,
    model_id: String,
    app: AppHandle,
    audio_tx: Option<std_mpsc::Sender<AudioMessage>>,
    worker: Option<thread::JoinHandle<()>>,
    language: String,
}

impl SherpaBilingualSTT {
    pub fn new(model_dir: PathBuf, model_id: &str, app: AppHandle) -> Result<Self, String> {
        files(&model_dir, model_id)?;
        dll_dir(&app)?;
        Ok(Self {
            model_dir,
            model_id: model_id.to_owned(),
            app,
            audio_tx: None,
            worker: None,
            language: "zh-CN".into(),
        })
    }
}

#[async_trait]
impl STTProvider for SherpaBilingualSTT {
    fn provider_name(&self) -> &str {
        "Sherpa-ONNX 中英双语流式"
    }
    fn provider_type(&self) -> STTProviderType {
        STTProviderType::SherpaBilingual
    }
    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.worker.is_some() {
            return Err("语音识别已启动".into());
        }
        let model_files = files(&self.model_dir, &self.model_id)?;
        let native_dir = dll_dir(&self.app)?;
        let model_id = self.model_id.clone();
        let language = self.language.clone();
        let (tx, rx) = std_mpsc::channel();
        let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("sherpa-bilingual-stt".into())
            .spawn(move || {
                let result = run_worker(
                    native_dir,
                    model_files,
                    model_id,
                    language,
                    rx,
                    result_tx,
                    ready_tx,
                );
                if let Err(error) = result {
                    log::error!("Sherpa bilingual STT: {error}");
                }
            })?;
        let ready = tokio::task::spawn_blocking(move || {
            ready_rx.recv_timeout(std::time::Duration::from_secs(45))
        })
        .await??;
        if let Err(error) = ready {
            let _ = worker.join();
            return Err(error.into());
        }
        self.audio_tx = Some(tx);
        self.worker = Some(worker);
        Ok(())
    }
    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !chunk.pcm_data.is_empty() {
            if let Some(tx) = &self.audio_tx {
                tx.send(AudioMessage::Samples(chunk.pcm_data, chunk.timestamp_ms))?;
            }
        }
        Ok(())
    }
    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(tx) = self.audio_tx.take() {
            let _ = tx.send(AudioMessage::Stop);
        }
        if let Some(worker) = self.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|_| "语音识别线程异常退出")?;
        }
        Ok(())
    }
    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        files(&self.model_dir, &self.model_id)?;
        dll_dir(&self.app)?;
        Ok(true)
    }
    fn set_language(&mut self, language: &str) {
        self.language = language.to_owned();
    }
}

fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| format!("文件路径包含空字符：{}", path.display()))
}

fn run_worker(
    native_dir: PathBuf,
    files: ModelFiles,
    model_id: String,
    language: String,
    audio_rx: std_mpsc::Receiver<AudioMessage>,
    result_tx: mpsc::Sender<TranscriptResult>,
    ready_tx: std_mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    // All C pointers, recognizer state and DLL handles stay on this one thread.
    let setup = (|| -> Result<(Api, *const c_void, *const c_void), String> {
        let api = unsafe { Api::load(&native_dir)? };
        let encoder = c_path(&files.encoder)?;
        let decoder = c_path(&files.decoder)?;
        let joiner = files.joiner.as_deref().map(c_path).transpose()?;
        let tokens = c_path(&files.tokens)?;
        let cpu = CString::new("cpu").unwrap();
        let greedy = CString::new("greedy_search").unwrap();
        let model_type = CString::new(if model_id == "zipformer-zh-en" {
            "zipformer"
        } else {
            "paraformer"
        })
        .unwrap();
        let mut config = OnlineRecognizerConfig::default();
        config.feat_config = FeatureConfig {
            sample_rate: 16_000,
            feature_dim: 80,
        };
        config.model_config.tokens = tokens.as_ptr();
        config.model_config.num_threads = 2;
        config.model_config.provider = cpu.as_ptr();
        config.model_config.model_type = model_type.as_ptr();
        if let Some(joiner) = &joiner {
            config.model_config.transducer = TransducerConfig {
                encoder: encoder.as_ptr(),
                decoder: decoder.as_ptr(),
                joiner: joiner.as_ptr(),
            };
        } else {
            config.model_config.paraformer = ParaformerConfig {
                encoder: encoder.as_ptr(),
                decoder: decoder.as_ptr(),
            };
        }
        config.decoding_method = greedy.as_ptr();
        config.enable_endpoint = 1;
        config.rule1_min_trailing_silence = 2.0;
        config.rule2_min_trailing_silence = 1.2;
        config.rule3_min_utterance_length = 20.0;
        let recognizer = unsafe { (api.create_recognizer)(&config) };
        if recognizer.is_null() {
            return Err("sherpa-onnx 无法加载模型；请检查模型文件与内存".into());
        }
        let stream = unsafe { (api.create_stream)(recognizer) };
        if stream.is_null() {
            unsafe { (api.destroy_recognizer)(recognizer) };
            return Err("sherpa-onnx 无法建立音频流".into());
        }
        Ok((api, recognizer, stream))
    })();
    let (api, recognizer, stream) = match setup {
        Ok(value) => {
            let _ = ready_tx.send(Ok(()));
            value
        }
        Err(error) => {
            let _ = ready_tx.send(Err(error.clone()));
            return Err(error);
        }
    };
    let mut segment = 0u64;
    let mut previous = String::new();
    let mut last_timestamp = 0u64;
    while let Ok(message) = audio_rx.recv() {
        match message {
            AudioMessage::Samples(pcm, timestamp) => {
                last_timestamp = timestamp;
                let samples: Vec<f32> = pcm.iter().map(|s| *s as f32 / 32768.0).collect();
                unsafe {
                    (api.accept)(stream, 16_000, samples.as_ptr(), samples.len() as i32);
                }
                while unsafe { (api.ready)(recognizer, stream) } != 0 {
                    unsafe {
                        (api.decode)(recognizer, stream);
                    }
                }
                let current = unsafe { result_text(&api, recognizer, stream) };
                if !current.is_empty() && current != previous {
                    previous = current.clone();
                    emit(&result_tx, current, false, timestamp, segment, &language);
                }
                if unsafe { (api.endpoint)(recognizer, stream) } != 0 {
                    if !previous.is_empty() {
                        emit(
                            &result_tx,
                            previous.clone(),
                            true,
                            timestamp,
                            segment,
                            &language,
                        );
                    }
                    unsafe {
                        (api.reset)(recognizer, stream);
                    }
                    segment += 1;
                    previous.clear();
                }
            }
            AudioMessage::Stop => break,
        }
    }
    unsafe {
        (api.input_finished)(stream);
    }
    while unsafe { (api.ready)(recognizer, stream) } != 0 {
        unsafe {
            (api.decode)(recognizer, stream);
        }
    }
    let final_text = unsafe { result_text(&api, recognizer, stream) };
    if !final_text.is_empty() {
        emit(
            &result_tx,
            final_text,
            true,
            last_timestamp,
            segment,
            &language,
        );
    }
    unsafe {
        (api.destroy_stream)(stream);
        (api.destroy_recognizer)(recognizer);
    }
    Ok(())
}

unsafe fn result_text(api: &Api, recognizer: *const c_void, stream: *const c_void) -> String {
    let result = (api.result)(recognizer, stream);
    if result.is_null() {
        return String::new();
    }
    let text = if (*result).text.is_null() {
        String::new()
    } else {
        CStr::from_ptr((*result).text)
            .to_string_lossy()
            .trim()
            .to_owned()
    };
    (api.destroy_result)(result);
    text
}

fn emit(
    tx: &mpsc::Sender<TranscriptResult>,
    text: String,
    is_final: bool,
    timestamp_ms: u64,
    segment: u64,
    language: &str,
) {
    let _ = tx.blocking_send(TranscriptResult {
        text,
        is_final,
        confidence: 0.0,
        timestamp_ms,
        speaker: Some("Them".into()),
        language: Some(language.into()),
        segment_id: Some(format!("sherpa_{segment}")),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_each_models_real_file_layout() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!model_files_available(dir.path(), "zipformer-zh-en"));
        for name in [
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "tokens.txt",
        ] {
            std::fs::write(dir.path().join(name), b"test").unwrap();
        }
        assert!(!model_files_available(dir.path(), "zipformer-zh-en"));
        std::fs::write(dir.path().join("joiner-epoch-99-avg-1.int8.onnx"), b"test").unwrap();
        assert!(model_files_available(dir.path(), "zipformer-zh-en"));
        for name in ["encoder.int8.onnx", "decoder.int8.onnx"] {
            std::fs::write(dir.path().join(name), b"test").unwrap();
        }
        assert!(model_files_available(dir.path(), "paraformer-zh-en"));
        assert!(!model_files_available(dir.path(), "other-model"));
    }

    #[test]
    #[cfg(windows)]
    fn packaged_native_runtime_exports_online_asr() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sherpa-onnx");
        unsafe {
            Api::load(&dir).expect("bundled sherpa-onnx runtime should load");
        }
    }
}

//! Session audio is tapped before STT. Silence and independent capture clocks
//! retain their positions; recognizer latency cannot concatenate the tracks.
use crate::audio::{AudioChunk, AudioSource};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex, OnceLock},
};
use tauri::{command, AppHandle, Manager};

const RATE: u64 = 16_000;
const MAX_FRAMES: u64 = RATE * 60 * 60 * 6;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    pub session_id: String,
    #[serde(default)]
    pub microphone: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: String,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    pub complete: bool,
    pub error: Option<String>,
    pub microphone: bool,
}
struct Active {
    session_id: String,
    task: tokio::task::JoinHandle<Result<(), String>>,
}
static ACTIVE: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
fn active() -> &'static Mutex<Option<Active>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("recordings"))
        .map_err(|e| e.to_string())
}
fn paths(app: &AppHandle, id: &str) -> Result<(PathBuf, PathBuf), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "录音会话 ID 无效")?;
    let p = root(app)?;
    Ok((p.join(format!("{id}.wav")), p.join(format!("{id}.json"))))
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn save_info(path: &Path, info: &RecordingInfo) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(info).map_err(|e| e.to_string())?)
        .and_then(|_| fs::rename(tmp, path))
        .map_err(|e| e.to_string())
}

struct Wave {
    file: File,
    frames: u64,
    cursors: [u64; 2],
    start: u64,
}
impl Wave {
    fn new(path: &Path, start: u64) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut w = Self {
            file,
            frames: 0,
            cursors: [0; 2],
            start,
        };
        w.header()?;
        Ok(w)
    }
    fn header(&mut self) -> Result<(), String> {
        let bytes = (self.frames * 4) as u32;
        let mut h = Vec::with_capacity(44);
        h.extend(b"RIFF");
        h.extend((36 + bytes).to_le_bytes());
        h.extend(b"WAVEfmt ");
        h.extend(16u32.to_le_bytes());
        h.extend(1u16.to_le_bytes());
        h.extend(2u16.to_le_bytes());
        h.extend((RATE as u32).to_le_bytes());
        h.extend((RATE as u32 * 4).to_le_bytes());
        h.extend(4u16.to_le_bytes());
        h.extend(16u16.to_le_bytes());
        h.extend(b"data");
        h.extend(bytes.to_le_bytes());
        self.file
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.file.write_all(&h))
            .and_then(|_| self.file.flush())
            .map_err(|e| e.to_string())
    }
    fn write(&mut self, chunk: &AudioChunk, microphone: bool) -> Result<(), String> {
        let ch = match chunk.source {
            AudioSource::Mic if microphone => 1,
            AudioSource::Mic => return Ok(()),
            _ => 0,
        };
        let end = chunk.timestamp_ms.saturating_sub(self.start) * RATE / 1000;
        let estimated = end.saturating_sub(chunk.pcm_data.len() as u64);
        // Callback jitter should not create gaps every 20 ms. Real pauses/device
        // outages remain silence; the two channels never wait for one another.
        let cursor = self.cursors[ch];
        let offset = if cursor > 0 && cursor.abs_diff(estimated) < RATE / 10 {
            cursor
        } else {
            estimated.max(cursor)
        };
        let count = chunk.pcm_data.len() as u64;
        if offset + count > MAX_FRAMES {
            return Err("录音已达到六小时上限，已保存前面的音频".into());
        }
        let next = self.frames.max(offset + count);
        self.file
            .set_len(44 + next * 4)
            .map_err(|e| e.to_string())?;
        let mut data = vec![0u8; count as usize * 4];
        self.file
            .seek(SeekFrom::Start(44 + offset * 4))
            .and_then(|_| self.file.read_exact(&mut data))
            .map_err(|e| e.to_string())?;
        for (i, sample) in chunk.pcm_data.iter().enumerate() {
            data[i * 4 + ch * 2..i * 4 + ch * 2 + 2].copy_from_slice(&sample.to_le_bytes());
        }
        self.file
            .seek(SeekFrom::Start(44 + offset * 4))
            .and_then(|_| self.file.write_all(&data))
            .map_err(|e| e.to_string())?;
        self.frames = next;
        self.cursors[ch] = offset + count;
        Ok(())
    }
    fn finish(&mut self, end: u64) -> Result<(), String> {
        self.frames = self
            .frames
            .max(end.saturating_sub(self.start) * RATE / 1000)
            .min(MAX_FRAMES);
        self.file
            .set_len(44 + self.frames * 4)
            .map_err(|e| e.to_string())?;
        self.header()
    }
}

pub fn tap(
    app: &AppHandle,
    opts: RecordingOptions,
    mut input: tokio::sync::mpsc::Receiver<AudioChunk>,
) -> Result<tokio::sync::mpsc::Receiver<AudioChunk>, String> {
    let mut guard = active().lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("上一场录音仍在结束，请稍后重试".into());
    }
    // A recording always belongs to an existing history session.
    super::history_commands::history_read(app.clone(), opts.session_id.clone())?;
    let (wav, meta) = paths(app, &opts.session_id)?;
    fs::create_dir_all(wav.parent().unwrap()).map_err(|e| e.to_string())?;
    let start = now();
    let mut writer = Wave::new(&wav, start)?;
    let info = RecordingInfo {
        path: wav.to_string_lossy().into(),
        started_at_ms: start,
        duration_ms: 0,
        complete: false,
        error: None,
        microphone: opts.microphone,
    };
    save_info(&meta, &info)?;
    let (audio_tx, audio_rx) = mpsc::sync_channel::<AudioChunk>(512);
    let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_overflow = overflow.clone();
    let worker = std::thread::spawn(move || {
        let mut info = info;
        let mut last = std::time::Instant::now();
        while let Ok(chunk) = audio_rx.recv() {
            if info.error.is_none() {
                if let Err(e) = writer.write(&chunk, info.microphone) {
                    info.error = Some(e);
                }
            }
            if last.elapsed().as_secs() >= 1 {
                if let Err(e) = writer.header() {
                    info.error = Some(e);
                }
                info.duration_ms = writer.frames * 1000 / RATE;
                let _ = save_info(&meta, &info);
                last = std::time::Instant::now();
            }
        }
        if let Err(e) = writer.finish(now()) {
            info.error = Some(e);
        }
        if worker_overflow.load(std::sync::atomic::Ordering::Relaxed) && info.error.is_none() {
            info.error = Some("部分录音未能及时写入，可能有缺失；缺失时间保留为空白".into());
        }
        info.duration_ms = writer.frames * 1000 / RATE;
        info.complete = info.error.is_none();
        save_info(&meta, &info)
    });
    let (tx, rx) = tokio::sync::mpsc::channel(256);
    let app = app.clone();
    let task = tokio::spawn(async move {
        let mut dropped = false;
        while let Some(chunk) = input.recv().await {
            if audio_tx.try_send(chunk.clone()).is_err() && !dropped {
                dropped = true;
                overflow.store(true, std::sync::atomic::Ordering::Relaxed);
                let _ = tauri::Emitter::emit(
                    &app,
                    "history_save_error",
                    "录音写入跟不上采集，部分音频缺失；转录仍会继续",
                );
            }
            // A slow recognizer must not block the recorder. The old capture queue also
            // dropped on overflow; this preserves its bounded, non-blocking behavior.
            let _ = tx.try_send(chunk);
        }
        drop(audio_tx);
        tokio::task::spawn_blocking(move || {
            worker.join().map_err(|_| "录音保存线程异常".to_string())?
        })
        .await
        .map_err(|e| e.to_string())?
    });
    *guard = Some(Active {
        session_id: opts.session_id,
        task,
    });
    Ok(rx)
}
pub async fn finish() -> Result<(), String> {
    let task = active().lock().map_err(|e| e.to_string())?.take();
    if let Some(a) = task {
        a.task.await.map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[command]
pub fn history_recording(app: AppHandle, id: String) -> Result<Option<RecordingInfo>, String> {
    let (wav, meta) = paths(&app, &id)?;
    if !meta.exists() {
        return Ok(None);
    }
    let mut info: RecordingInfo =
        serde_json::from_slice(&fs::read(meta).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    // Never trust paths saved in a mutable metadata file.
    info.path = wav.to_string_lossy().into();
    let len = fs::metadata(&wav).map_err(|e| e.to_string())?.len();
    info.duration_ms = len.saturating_sub(44) / 4 * 1000 / RATE;
    Ok(Some(info))
}
#[command]
pub fn history_export_audio(app: AppHandle, id: String, path: String) -> Result<(), String> {
    let (wav, _) = paths(&app, &id)?;
    let target = Path::new(&path);
    if !target.is_absolute()
        || target
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_lowercase)
            .as_deref()
            != Some("wav")
    {
        return Err("请选择完整的 WAV 文件保存位置".into());
    }
    if target == wav {
        return Err("请另选导出位置".into());
    }
    fs::copy(wav, target).map(|_| ()).map_err(|e| e.to_string())
}
pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    if active()
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .is_some_and(|a| a.session_id == id)
    {
        return Err("本场仍在录音，请结束聆听后再删除".into());
    }
    let (wav, meta) = paths(app, id)?;
    let tmp = meta.with_extension("json.tmp");
    for p in [wav, meta, tmp] {
        if p.exists() {
            fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independently_timed_tracks_preserve_silence_and_do_not_double_duration() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("test.wav");
        let mut w = Wave::new(&p, 1000).unwrap();
        for (source, timestamp_ms, samples) in [
            (AudioSource::System, 1100, vec![100; 1600]),
            (AudioSource::Mic, 1100, vec![200; 1600]),
            (AudioSource::System, 2100, vec![300; 1600]),
        ] {
            w.write(
                &AudioChunk {
                    source,
                    pcm_data: samples,
                    timestamp_ms,
                    is_speech: false,
                },
                true,
            )
            .unwrap();
        }
        w.finish(2200).unwrap();
        let mut r = hound::WavReader::open(p).unwrap();
        assert_eq!(r.duration(), 19200);
        assert_eq!(r.spec().channels, 2);
        let s = r.samples::<i16>().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(&s[..4], &[100, 200, 100, 200]);
        assert_eq!(&s[8000..8004], &[0, 0, 0, 0]);
        assert_eq!(&s[32000..32004], &[300, 0, 300, 0]);
    }
    #[test]
    fn offline_does_not_record_unselected_microphone() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.wav");
        let mut w = Wave::new(&p, 1000).unwrap();
        w.write(
            &AudioChunk {
                source: AudioSource::Mic,
                pcm_data: vec![123; 160],
                timestamp_ms: 1010,
                is_speech: true,
            },
            false,
        )
        .unwrap();
        w.finish(1010).unwrap();
        assert!(hound::WavReader::open(p)
            .unwrap()
            .samples::<i16>()
            .all(|s| s.unwrap() == 0));
    }
}

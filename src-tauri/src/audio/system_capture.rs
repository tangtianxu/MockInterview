// System audio capture via cpal loopback.
// Captures audio from a specific output device by building an input stream
// on it — cpal's WASAPI backend handles the loopback flag automatically.
// This approach works with Bluetooth, USB, and virtual audio devices.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::resampler::resample;
use super::{AudioChunk, AudioSource};

const TARGET_SAMPLE_RATE: u32 = 16000;

/// Start system audio loopback capture using cpal.
/// Uses the default output device.
pub fn start_system_capture(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
) -> Result<std::thread::JoinHandle<()>, String> {
    start_system_capture_device(tx, stop_flag, None)
}

/// Start system audio loopback capture on a specific output device.
/// If device_name is None, uses the default output device.
///
/// Works by calling build_input_stream() on an output device —
/// cpal's WASAPI backend automatically sets the loopback capture flag.
pub fn start_system_capture_device(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
) -> Result<std::thread::JoinHandle<()>, String> {
    let label = device_name.as_deref().unwrap_or("default").to_string();
    log::info!("Starting system audio capture on: {}", label);

    // Everything runs inside the spawned thread because cpal::Stream is !Send.
    // The stream must be created and kept alive on the same thread.
    let (ready_tx,ready_rx)=std::sync::mpsc::channel();
    let worker_stop=stop_flag.clone();
    let handle = std::thread::Builder::new()
        .name("system-audio-capture".into())
        .spawn(move || {
            if let Err(e) = run_cpal_loopback(tx, worker_stop, device_name, &ready_tx) {
                let _=ready_tx.send(Err(e.clone()));
                log::error!("System audio capture failed: {}", e);
            }
        })
        .map_err(|e| format!("Failed to spawn system capture thread: {}", e))?;

    match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(()))=>Ok(handle),
        result=>{
            stop_flag.store(true,Ordering::SeqCst);
            Err(match result {
                Ok(Err(error))=>error,
                Err(error)=>format!("系统音频设备初始化未完成：{error}，请刷新并重新选择设备"),
                _=>unreachable!(),
            })
        }
    }
}

fn run_cpal_loopback(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
    ready: &std::sync::mpsc::Sender<Result<(),String>>,
) -> Result<(), String> {
    let host = cpal::default_host();

    let device = if let Some(ref name) = device_name {
        let mut found = None;
        if let Ok(devices) = host.output_devices() {
            for d in devices {
                if let Ok(d_name) = d.name() {
                    log::info!("  Output device: {}", d_name);
                    if d_name == *name {
                        found = Some(d);
                        break;
                    }
                }
            }
        }
        match found {
            Some(d) => d,
            None => return Err(format!("所选输出设备 '{name}' 已不可用，请刷新并重新选择音频设备")),
        }
    } else {
        host.default_output_device()
            .ok_or_else(|| "No default output device".to_string())?
    };

    let actual_name = device.name().unwrap_or_else(|_| "unknown".into());
    log::info!("System loopback device: {}", actual_name);

    let config = device
        .default_output_config()
        .map_err(|e| format!("No output config for '{}': {}", actual_name, e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let sample_format = config.sample_format();
    log::info!("System capture: {}Hz, {}ch, {:?}", sample_rate, channels, sample_format);

    let err_fn = |err: cpal::StreamError| {
        log::error!("System capture error: {}", err);
    };

    let stop = stop_flag.clone();
    let tx2 = tx.clone();

    // Build INPUT stream on OUTPUT device = loopback capture
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                let pcm: Vec<i16> = data.iter()
                    .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();
                send_system_chunk(&pcm, sample_rate, channels, &tx2);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                send_system_chunk(data, sample_rate, channels, &tx2);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                let pcm: Vec<i16> = data.iter()
                    .map(|&s| (s as i32 - 32768) as i16)
                    .collect();
                send_system_chunk(&pcm, sample_rate, channels, &tx2);
            },
            err_fn,
            None,
        ),
        _ => return Err(format!("Unsupported format: {:?}", sample_format)),
    }
    .map_err(|e| format!("Failed to build loopback stream on '{}': {}", actual_name, e))?;

    stream.play().map_err(|e| format!("Failed to play loopback stream: {}", e))?;
    if ready.send(Ok(())).is_err(){return Ok(());}
    log::info!("System audio loopback ACTIVE on '{}'", actual_name);

    // Keep stream alive until stop flag
    while !stop_flag.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    drop(stream);
    log::info!("System audio loopback stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_output_device_is_reported_before_capture_is_started() {
        let (tx,_rx)=mpsc::channel(1);
        // Keep callbacks stopped even if a regression falls back to real hardware.
        let stopped=Arc::new(AtomicBool::new(true));
        let result=start_system_capture_device(tx,stopped.clone(),Some("__mock_interview_missing_output_device__".into()));
        stopped.store(true,Ordering::SeqCst);
        if let Ok(handle)=result {let _=handle.join();panic!("missing output must not report successful capture");}
    }
}

fn send_system_chunk(
    i16_data: &[i16],
    sample_rate: u32,
    channels: u16,
    tx: &mpsc::Sender<AudioChunk>,
) {
    if i16_data.is_empty() {
        return;
    }

    let pcm_data = resample(i16_data, sample_rate, TARGET_SAMPLE_RATE, channels);

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let chunk = AudioChunk {
        pcm_data,
        source: AudioSource::System,
        timestamp_ms,
        is_speech: false,
    };

    if tx.try_send(chunk).is_err() {
        // Channel full — drop chunk silently
    }
}

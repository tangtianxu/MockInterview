use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    verified_bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct UpdateState(Mutex<PendingUpdate>);

/// Information about an available update.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
}

/// Check for an available update.
///
/// Returns `Some(UpdateInfo)` if a newer version is available, or `None` if the
/// app is already up-to-date.
#[command]
pub async fn check_for_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行，请稍后重试".to_string())?;
    pending.update = None;
    pending.verified_bytes = None;
    let mut update = app.updater_builder().timeout(Duration::from_secs(30))
        .build().map_err(|e| format!("无法初始化更新检查：{e}"))?
        .check().await.map_err(|e| format!("无法连接更新源，请检查网络后重试：{e}"))?;
    if let Some(update) = update.as_mut() { update.timeout = Some(Duration::from_secs(600)); }
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), body: u.body.clone() });
    pending.update = update;
    Ok(info)
}

/// Verify the updater signature before retaining any installable bytes.
#[command]
pub async fn download_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行，请稍后重试".to_string())?;
    let update = pending.update.as_ref().ok_or("请先检查更新")?.clone();
    pending.verified_bytes = None;
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let bytes = update.download(|chunk, total| {
        downloaded += chunk as u64;
        if last_emit.elapsed() >= Duration::from_millis(100) || total == Some(downloaded) {
            let _ = app.emit("update_download_progress", DownloadProgress { downloaded, total });
            last_emit = Instant::now();
        }
    }, || {}).await.map_err(|e| format!("下载或签名校验失败，未安装更新；请重试：{e}"))?;
    let length = bytes.len() as u64;
    pending.verified_bytes = Some(bytes);
    let _ = app.emit("update_download_progress", DownloadProgress { downloaded: length, total: Some(length) });
    Ok(())
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[command]
pub async fn install_downloaded_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let pending = state.0.try_lock().map_err(|_| "更新操作正在进行，请稍后重试".to_string())?;
    let app_state = app.state::<crate::state::AppState>();
    let audio = app_state.audio.lock().map_err(|_| "无法读取音频状态".to_string())?;
    if audio.as_ref().is_some_and(|manager| manager.is_capturing()) {
        return Err("请先结束练习或转录，再安装更新".to_string());
    }
    drop(audio);
    let update = pending.update.as_ref().ok_or("请先检查更新")?;
    let bytes = pending.verified_bytes.as_ref().ok_or("请先下载并校验更新")?;
    // NSIS /UPDATE keeps the installation directory and relaunches on Windows.
    update.install(bytes).map_err(|e| format!("无法启动更新安装：{e}"))
}

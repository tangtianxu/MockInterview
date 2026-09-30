use serde::Serialize;
use tauri::{command, AppHandle};

/// Information about an available update.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Check for an available update.
///
/// Returns `Some(UpdateInfo)` if a newer version is available, or `None` if the
/// app is already up-to-date.
#[command]
pub async fn check_for_update(_app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    // This fork has no signed release channel. Never query or install upstream NexQ builds.
    Ok(None)
}

/// Download and install the latest update, emitting progress events.
///
/// Emits `update_download_progress` events with `{ chunk_length, content_length }`
/// during the download, and a final `update_ready` event with `{ version }` on
/// completion.
#[command]
pub async fn download_and_install_update(_app: AppHandle) -> Result<(), String> {
    Err("NexQ Laya does not have a signed automatic update channel yet".to_string())
}

/// Restart the application to apply a pending update.
#[command]
pub async fn restart_for_update(app: AppHandle) -> Result<(), String> {
    log::info!("Restarting application for update...");
    app.restart();
}

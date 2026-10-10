// Tauri commands for managing local STT model downloads.

use tauri::{command, AppHandle, Manager};

use crate::state::AppState;

/// List all local STT engines with their models and download status.
#[command]
pub async fn list_local_stt_engines(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;
    let mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;

    let engines = mgr.list_engines_with_status();
    serde_json::to_string(&engines)
        .map_err(|e| format!("Failed to serialize engine list: {}", e))
}

/// Start downloading a local STT model. Progress emitted via `model_download_progress` events.
#[command]
pub async fn download_local_stt_model(
    app: AppHandle,
    engine: String,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;

    let mut mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;

    mgr.download_model(&engine, &model_id, app.clone())
}

/// Cancel an active model download.
#[command]
pub async fn cancel_model_download(
    app: AppHandle,
    engine: String,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;

    let mut mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;

    mgr.cancel_download(&engine, &model_id);
    Ok(())
}

/// Delete a downloaded local STT model.
#[command]
pub async fn delete_local_stt_model(
    app: AppHandle,
    engine: String,
    model_id: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let model_mgr = state
        .model_manager
        .as_ref()
        .ok_or("Model manager not initialized")?;

    let mut mgr = model_mgr
        .lock()
        .map_err(|_| "Model manager lock poisoned".to_string())?;

    mgr.delete_model(&engine, &model_id)
}

fn ollama_delete_url(base_url: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(base_url.trim()).map_err(|_| "Ollama 地址无效")?;
    let local = url.host_str().is_some_and(|host|host=="localhost" ||
        host.trim_matches(['[',']']).parse::<std::net::IpAddr>().is_ok_and(|ip|ip.is_loopback()));
    if !local || !matches!(url.scheme(), "http"|"https") || !url.username().is_empty() ||
        url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path()!="/" {
        return Err("只能删除本机 Ollama 模型，请使用 localhost 或回环 IP 的根地址".into());
    }
    url.set_path("/api/delete"); Ok(url)
}

/// Ollama owns its model blobs; use its API instead of deleting shared files.
#[command]
pub async fn delete_ollama_model(base_url: String, model: String) -> Result<(), String> {
    let url = ollama_delete_url(&base_url)?;
    if model.trim().is_empty() || model.len()>512 { return Err("请选择要删除的 Ollama 模型".into()); }
    let response = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(60))
        .build().map_err(|_| "无法创建本地请求")?
        .delete(url).json(&serde_json::json!({"model":model})).send().await
        .map_err(|e| format!("删除失败，请确认本机 Ollama 服务已启动：{}",e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("Ollama 删除失败：HTTP {}。请重新检测模型列表", response.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_removal_accepts_only_local_root_endpoints() {
        for base in ["http://localhost:11434", "http://127.0.0.1:11434/", "http://[::1]:11434"] {
            assert_eq!(ollama_delete_url(base).unwrap().path(),"/api/delete");
        }
        for base in ["https://example.org", "http://localhost.example.org", "http://user:pass@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1/?x=1", "file:///models"] {
            assert!(ollama_delete_url(base).is_err(),"{base}");
        }
    }
}

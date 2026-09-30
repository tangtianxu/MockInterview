//! Start optional loopback model services from the desktop app.
//! Paths come from validated local configuration or known installed locations.

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::{fs::OpenOptions, path::{Path, PathBuf}, process::{Command, Stdio}, sync::OnceLock, time::Duration};
use tauri::{command, AppHandle, Emitter, Manager};
use crate::state::AppState;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalRuntime {
    model_root: Option<PathBuf>,
    ollama_exe: Option<PathBuf>,
    ollama_models: Option<PathBuf>,
    laya_python: Option<PathBuf>,
    laya_home: Option<PathBuf>,
}

fn manifest(app: &AppHandle) -> LocalRuntime {
    let primary = app.path().app_config_dir().ok()
        .map(|dir| dir.join("local-runtime.json"));
    // A portable launch can inherit a different application-data root from its
    // parent process. Preserve the user's existing runtime selection in that case.
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from)
        .map(|dir| dir.join("app.interviewcue.local/local-runtime.json"));
    primary.into_iter().chain(roaming)
        .filter_map(|file| std::fs::read_to_string(file).ok())
        .filter_map(|data| serde_json::from_str::<LocalRuntime>(&data).ok())
        .next().unwrap_or_default()
}

pub fn configured_model_root(app: &AppHandle) -> Option<PathBuf> {
    configured_path(manifest(app).model_root)
}

#[command]
pub fn local_stt_model_directory(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let manager = state.model_manager.as_ref().ok_or("语音模型管理器未初始化")?;
    let manager = manager.lock().map_err(|_| "语音模型管理器不可用")?;
    Ok(manager.models_dir().to_string_lossy().into_owned())
}

#[command]
pub fn save_local_stt_model_directory(app: AppHandle, directory: String) -> Result<(), String> {
    let path = PathBuf::from(directory.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("请选择已有的语音模型总文件夹".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("local-runtime.json");
    let mut value: serde_json::Value = std::fs::read_to_string(&file).ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let object = value.as_object_mut().ok_or("本地运行配置格式无效")?;
    object.insert("modelRoot".into(), serde_json::json!(path));
    std::fs::write(&file, serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    let manager = state.model_manager.as_ref().ok_or("语音模型管理器未初始化")?;
    manager.lock().map_err(|_| "语音模型管理器不可用")?.set_models_dir(path);
    Ok(())
}

fn configured_path(value: Option<PathBuf>) -> Option<PathBuf> {
    value.filter(|path| path.is_absolute() && path.exists())
}

fn installed_ollama() -> Option<PathBuf> {
    let common = ["LOCALAPPDATA", "ProgramFiles"]
        .iter()
        .filter_map(|key| std::env::var_os(key))
        .map(PathBuf::from)
        .flat_map(|root| [root.join("Programs/Ollama/ollama.exe"), root.join("Ollama/ollama.exe")])
        .find(|path| path.is_file());
    common.or_else(|| std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|dir| dir.join("ollama.exe"))
            .find(|path| path.is_file())
    }))
}

fn ollama_executable(app: &AppHandle) -> Option<PathBuf> {
    configured_path(manifest(app).ollama_exe)
        .or_else(|| std::env::var_os("NEXQ_OLLAMA_EXE").and_then(|p| configured_path(Some(p.into()))))
        .or_else(installed_ollama)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRuntimeStatus {
    executable: Option<String>,
    configured_executable: Option<String>,
    config_file: String,
    models_directory: Option<String>,
    connected: bool,
}

#[command]
pub async fn ollama_runtime_status(app: AppHandle) -> Result<OllamaRuntimeStatus, String> {
    let config = manifest(&app);
    let config_file = app.path().app_config_dir().map_err(|e| e.to_string())?
        .join("local-runtime.json");
    Ok(OllamaRuntimeStatus {
        executable: ollama_executable(&app).map(|path| path.to_string_lossy().into_owned()),
        configured_executable: config.ollama_exe.as_ref().map(|path| path.to_string_lossy().into_owned()),
        config_file: config_file.to_string_lossy().into_owned(),
        models_directory: configured_path(config.ollama_models).map(|path| path.to_string_lossy().into_owned()),
        connected: ready("ollama").await?,
    })
}

#[command]
pub fn save_ollama_runtime(app: AppHandle, executable: String, models_directory: String) -> Result<(), String> {
    let exe = executable.trim();
    let models = models_directory.trim();
    let exe = if exe.is_empty() { None } else {
        let path = Path::new(exe).canonicalize().map_err(|e| format!("找不到 Ollama 程序：{e}"))?;
        if !path.is_file() || !path.file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("ollama.exe")) {
            return Err("请选择有效的 ollama.exe 文件".into());
        }
        Some(path)
    };
    let models = if models.is_empty() { None } else {
        let path = Path::new(models).canonicalize().map_err(|e| format!("找不到模型目录：{e}"))?;
        if !path.is_dir() { return Err("请选择已有的模型文件夹".into()); }
        Some(path)
    };
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("local-runtime.json");
    let mut value: serde_json::Value = std::fs::read_to_string(&file).ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let object = value.as_object_mut().ok_or("本地运行配置格式无效")?;
    object.insert("ollamaExe".into(), serde_json::json!(exe));
    object.insert("ollamaModels".into(), serde_json::json!(models));
    let temporary = dir.join("local-runtime.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &file).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn pull_ollama_model(app: AppHandle, model: String) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() || model.len() > 128 || model.ends_with(":cloud") ||
        !model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)) {
        return Err("请输入有效的本地 Ollama 模型 ID".into());
    }
    if !ready("ollama").await? { return Err("请先启动 Ollama".into()); }
    let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(10))
        .build().map_err(|e| e.to_string())?;
    let response = client.post("http://127.0.0.1:11434/api/pull")
        .json(&serde_json::json!({"name":model,"stream":true}))
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut finished = false;
    while let Some(chunk) = stream.next().await {
        pending.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim().to_owned();
            pending.drain(..=index);
            if line.is_empty() { continue; }
            let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if let Some(error) = value["error"].as_str() { return Err(error.into()); }
            if value["status"].as_str() == Some("success") { finished = true; }
            let _ = app.emit("ollama_pull_progress", serde_json::json!({
                "model":model,"status":value["status"],
                "completed":value["completed"],"total":value["total"]
            }));
        }
    }
    if !pending.trim().is_empty() {
        let last: serde_json::Value = serde_json::from_str(pending.trim()).map_err(|e| e.to_string())?;
        if let Some(error) = last["error"].as_str() { return Err(error.into()); }
        finished |= last["status"].as_str() == Some("success");
    }
    if !finished { return Err("下载连接已中断，模型尚未完成".into()); }
    Ok(())
}

fn endpoint(service: &str) -> Result<&'static str, String> {
    match service {
        "ollama" => Ok("http://127.0.0.1:11434/api/tags"),
        "laya" => Ok("http://127.0.0.1:8000/health"),
        _ => Err("Unknown local service".into()),
    }
}

async fn ready(service: &str) -> Result<bool, String> {
    let url = endpoint(service)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).no_proxy()
        .build().map_err(|e| e.to_string())?;
    Ok(client.get(url).send().await.map(|response| response.status().is_success()).unwrap_or(false))
}

#[command]
pub async fn local_service_status(service: String) -> Result<bool, String> {
    ready(&service).await
}

fn log_stdio(app: &AppHandle, name: &str) -> Result<(Stdio, Stdio), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log = OpenOptions::new().create(true).append(true)
        .open(dir.join(format!("{name}-service.log"))).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    Ok((Stdio::from(log), Stdio::from(err)))
}

fn build_command(app: &AppHandle, service: &str) -> Result<Command, String> {
    let config = manifest(app);
    let mut command = match service {
        "ollama" => {
            let exe = ollama_executable(app)
                .ok_or("未找到 Ollama。请在设置中下载安装，或选择已有的 ollama.exe。")?;
            let mut cmd = Command::new(&exe);
            cmd.arg("serve").current_dir(exe.parent().unwrap_or(Path::new(".")));
            if let Some(models) = configured_path(config.ollama_models) {
                cmd.env("OLLAMA_MODELS", models);
            }
            cmd.env("OLLAMA_HOST", "127.0.0.1:11434")
                .env("OLLAMA_NO_CLOUD", "1").env("OLLAMA_KEEP_ALIVE", "1h");
            cmd
        }
        "laya" => {
            let python = configured_path(config.laya_python)
                .or_else(|| std::env::var_os("NEXQ_LAYA_PYTHON").and_then(|p| configured_path(Some(p.into()))))
                .ok_or("Laya runtime is not configured. Run the one-time local setup with Laya first.")?;
            let home = configured_path(config.laya_home)
                .ok_or("Laya model cache is not configured. Run the one-time local setup with Laya first.")?;
            let mut cmd = Command::new(python);
            cmd.arg("-m").arg("laya.serve")
                .env("HF_HOME", &home).env("HUGGINGFACE_HUB_CACHE", home.join("hub"))
                .env("HF_HUB_OFFLINE", "1").env("LAYA_HOST", "127.0.0.1")
                .env("LAYA_PORT", "8000").env("LAYA_MODELS", "multilingual")
                .env("LAYA_PRELOAD", "1").env("LAYA_DEVICE", "cpu")
                .env("LAYA_THREADS", "8");
            cmd
        }
        _ => return Err("Unknown local service".into()),
    };
    let (stdout, stderr) = log_stdio(app, service)?;
    command.stdout(stdout).stderr(stderr).stdin(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    Ok(command)
}

#[command]
pub async fn start_local_service(app: AppHandle, service: String) -> Result<(), String> {
    static START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = START_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    if ready(&service).await? { return Ok(()); }
    // No shell is involved, and the service name is restricted to two known values.
    let mut command = build_command(&app, &service)?;
    let mut child = command.spawn().map_err(|e| format!("Could not start {service}: {e}"))?;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if ready(&service).await? { return Ok(()); }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("{service} stopped during startup ({status}). See the service log."));
        }
    }
    Err(format!("{service} did not become ready within 60 seconds. See the service log."))
}

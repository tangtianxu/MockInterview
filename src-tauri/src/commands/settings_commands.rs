use std::{fs, path::Path};
use tauri::{command, AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use serde_json::{json, Value};

const STORE_FILE: &str = "config.json";
const PROFILE_KEY: &str = "interview_profile";

fn validate_profile(profile: &Value) -> Result<(), String> {
    if !profile.get("settings").is_some_and(Value::is_object) {
        return Err("配置文件缺少有效的设置内容".into());
    }
    if profile.get("resumeAnalysis").is_some_and(|value| !value.is_null() && !value.is_object()) {
        return Err("配置文件中的简历分析格式无效".into());
    }
    if profile.get("practiceConfig").is_some_and(|value| !value.is_null() && !value.is_object()) {
        return Err("备份文件中的练习设置格式无效".into());
    }
    if serde_json::to_vec(profile).map_err(|e| e.to_string())?.len() > 256 * 1024 {
        return Err("配置文件过大".into());
    }
    Ok(())
}

fn backup_path(path: &str) -> Result<&Path, String> {
    let path = Path::new(path);
    if !path.is_absolute() || !path.extension().is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("json")) {
        return Err("请选择完整的 JSON 文件路径".into());
    }
    Ok(path)
}

#[command]
pub fn load_interview_profile(app: AppHandle) -> Result<Option<Value>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let profile = store.get(PROFILE_KEY);
    if let Some(value) = &profile { validate_profile(value)?; }
    Ok(profile)
}

#[command]
pub fn save_interview_profile(app: AppHandle, profile: Value) -> Result<(), String> {
    validate_profile(&profile)?;
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(PROFILE_KEY, profile);
    store.save().map_err(|e| e.to_string())
}

#[command]
pub fn export_interview_profile(app: AppHandle, path: String, profile: Value) -> Result<(), String> {
    validate_profile(&profile)?;
    let path = backup_path(&path)?;
    let runtime_path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("local-runtime.json");
    let runtime: Option<Value> = fs::read_to_string(runtime_path).ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| value.as_object().map(|object| object.iter()
            .filter(|(key, _)| matches!(key.as_str(), "modelRoot" | "ollamaExe" | "ollamaModels" | "layaPython" | "layaHome"))
            .map(|(key, value)| (key.clone(), value.clone())).collect::<serde_json::Map<String, Value>>() ))
        .map(Value::Object);
    let backup = json!({"format":"interview-cue-profile","version":1,
        "profile":profile,"localRuntime":runtime});
    fs::write(path, serde_json::to_vec_pretty(&backup).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[command]
pub fn import_interview_profile(app: AppHandle, path: String) -> Result<Value, String> {
    let path = backup_path(&path)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("备份文件过大".into());
    }
    let backup: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("备份文件不是有效 JSON：{e}"))?;
    if backup.get("format").and_then(Value::as_str) != Some("interview-cue-profile")
        || backup.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("不支持的配置备份格式".into());
    }
    let profile = backup.get("profile").ok_or("备份缺少配置")?.clone();
    validate_profile(&profile)?;
    let runtime = backup.get("localRuntime").filter(|value| !value.is_null());
    if let Some(runtime) = runtime {
        let object = runtime.as_object().ok_or("本地运行路径格式无效")?;
        for (key, value) in object {
            if !matches!(key.as_str(), "modelRoot" | "ollamaExe" | "ollamaModels" | "layaPython" | "layaHome")
                || !(value.is_string() || value.is_null()) {
                return Err("本地运行路径包含不支持的字段".into());
            }
        }
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let runtime_file = dir.join("local-runtime.json");
        let mut current: Value = fs::read_to_string(&runtime_file).ok()
            .and_then(|content| serde_json::from_str(&content).ok()).unwrap_or_else(|| json!({}));
        let current_object = current.as_object_mut().ok_or("当前本地路径配置格式无效")?;
        for (key, value) in object { current_object.insert(key.clone(), value.clone()); }
        fs::write(runtime_file, serde_json::to_vec_pretty(&current).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    save_interview_profile(app, profile.clone())?;
    Ok(profile)
}

#[command]
pub async fn get_config(key: String, app: AppHandle) -> Result<Option<String>, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {}", e))?;

    let value = store.get(&key);

    match value {
        Some(val) => {
            // Return the JSON value as a string
            let s = serde_json::to_string(&val)
                .map_err(|e| format!("Failed to serialize config value: {}", e))?;
            Ok(Some(s))
        }
        None => Ok(None),
    }
}

#[command]
pub async fn set_config(key: String, value: String, app: AppHandle) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {}", e))?;

    // Parse the value as a JSON value so it's stored properly
    let json_value: serde_json::Value = serde_json::from_str(&value).unwrap_or_else(|_| {
        // If it's not valid JSON, store as a plain string
        serde_json::Value::String(value.clone())
    });

    store.set(key, json_value);

    Ok(())
}

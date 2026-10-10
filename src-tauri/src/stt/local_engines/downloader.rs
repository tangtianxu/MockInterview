// HTTP download with streaming progress and SHA256 verification.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub engine: String,
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub status: String, // connecting_proxy | downloading | verifying | extracting | complete | error | cancelled
    pub error: Option<String>,
}

/// Download a file with progress reporting and optional SHA256 verification.
pub async fn download_file(
    url: &str,
    dest: &Path,
    sha256_expected: &str,
    engine: &str,
    model_id: &str,
    cancel_flag: Arc<AtomicBool>,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!("Starting download: {} -> {}", url, dest.display());

    let emit = |downloaded: u64, total: u64, status: &str| {
        let percent = if total > 0 {
            (downloaded as f32 / total as f32) * 100.0
        } else {
            0.0
        };
        let _ = app_handle.emit(
            "model_download_progress",
            &DownloadProgress {
                engine: engine.to_string(),
                model_id: model_id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent,
                status: status.to_string(),
                error: None,
            },
        );
    };

    let domestic = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|host| host == "modelscope.cn" || host.ends_with(".modelscope.cn"));
    // Domestic model files should not depend on an abandoned local proxy.
    // A connection failure can still use the user's configured proxy; never bypass TLS checks.
    let client = model_http_client(domestic)?;
    let fallback = if domestic { Some(model_http_client(false)?) } else { None };
    download_with_routes(&client, fallback.as_ref(), url, dest, sha256_expected, cancel_flag, &emit).await
}

fn model_http_client(direct: bool) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        // ModelScope rejects full-file requests without a User-Agent with HTTP 403.
        .user_agent(concat!("MockInterview/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(60))
        .timeout(std::time::Duration::from_secs(30 * 60));
    (if direct { builder.no_proxy() } else { builder }).build().map_err(|e| network_error(&e))
}

async fn download_with_routes(
    client: &reqwest::Client, fallback: Option<&reqwest::Client>, url: &str, dest: &Path,
    sha256_expected: &str, cancel_flag: Arc<AtomicBool>, emit: &impl Fn(u64, u64, &str),
) -> Result<(), String> {
    let result = download_with_client(client, url, dest, sha256_expected, cancel_flag.clone(), emit).await;
    if let Some(fallback) = fallback.filter(|_| matches!(&result, Err(e) if e.starts_with("连接下载源失败")) && !cancel_flag.load(Ordering::SeqCst)) {
        emit(0, 0, "connecting_proxy");
        let retry = download_with_client(fallback, url, dest, sha256_expected, cancel_flag, emit).await;
        return retry.map_err(|e| format!("国内镜像直连失败；尝试系统/环境代理也失败：{e}"));
    }
    result
}

fn network_error(error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut details = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        let detail = cause.to_string();
        details.push(if detail.contains("://") { "地址详情已隐藏".into() } else { detail });
        source = cause.source();
    }
    // URL credentials and signed redirect queries must not appear in the UI or logs.
    let label = if error.is_timeout() { "连接或接收数据超时" } else { "网络、代理或证书连接错误" };
    format!("{label}（{}）。请检查网络、代理是否运行及系统时间；证书错误应修复信任配置", details.join("；"))
}

async fn download_with_client(
    client: &reqwest::Client, url: &str, dest: &Path, sha256_expected: &str,
    cancel_flag: Arc<AtomicBool>, emit: &impl Fn(u64, u64, &str),
) -> Result<(), String> {
    let tmp_path = dest.with_extension("download");
    let result = transfer_file(client, url, dest, &tmp_path, sha256_expected, cancel_flag, emit).await;
    if result.is_err() { let _ = tokio::fs::remove_file(&tmp_path).await; }
    result
}

async fn transfer_file(
    client: &reqwest::Client, url: &str, dest: &Path, tmp_path: &Path, sha256_expected: &str,
    cancel_flag: Arc<AtomicBool>, emit: &impl Fn(u64, u64, &str),
) -> Result<(), String> {
    use futures::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    if cancel_flag.load(Ordering::SeqCst) { return Err("下载已取消".into()); }
    // Validate the target before using network bandwidth.
    let mut file = tokio::fs::File::create(tmp_path).await
        .map_err(|e| format!("模型目录无法写入：{}（{e}）。请选择当前用户可写的目录", tmp_path.display()))?;
    let response = client.get(url).send().await
        .map_err(|e| format!("连接下载源失败：{}", network_error(&e)))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("下载源返回 HTTP {status}，请重试或使用浏览器下载；这不是 Ollama 未启动造成的"));
    }
    if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html")) {
        return Err("下载源返回了网页而不是模型文件，请检查代理或改用浏览器下载".into());
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();

    // Write to a temp file first, rename on success
    emit(0, total_size, "downloading");

    while let Some(chunk_result) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err("下载已取消".to_string());
        }

        let chunk = chunk_result.map_err(|e| format!("下载中断：{}。可重新下载", network_error(&e)))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("模型文件写入失败：{e}。请检查目标磁盘空间和目录权限"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        // Emit progress every ~100 KB to avoid flooding
        if downloaded % 102_400 < chunk.len() as u64 || downloaded == total_size {
            emit(downloaded, total_size, "downloading");
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    drop(file);
    if downloaded == 0 { return Err("下载源返回空文件，请重试下载".into()); }

    // Verify SHA256 if a hash is provided
    if !sha256_expected.is_empty() {
        emit(downloaded, total_size, "verifying");
        let hash = format!("{:x}", hasher.finalize());
        if hash != sha256_expected {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!(
                "模型 SHA-256 校验失败（文件损坏或下载源内容已变更）：预期 {}，收到 {}。请重试或使用浏览器下载，勿跳过校验",
                sha256_expected, hash
            ));
        }
        log::info!("SHA256 verification passed");
    }

    // Rename temp file to final destination
    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| format!("Failed to rename temp file: {}", e))?;

    // NOTE: We intentionally do NOT emit "complete" here.
    // The caller (ModelManager::download_model) handles the final status
    // because archive models need extraction before they're truly complete.
    log::info!(
        "Download complete: {} ({} bytes)",
        dest.display(),
        downloaded
    );

    Ok(())
}

/// Extract a .tar.bz2 archive into a destination directory.
/// Returns the path to the top-level extracted directory.
pub fn extract_tar_bz2(archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use bzip2::read::BzDecoder;
    use std::fs::File;

    log::info!(
        "Extracting archive: {} -> {}",
        archive_path.display(),
        dest_dir.display()
    );

    let file = File::open(archive_path)
        .map_err(|e| format!("Failed to open archive: {}", e))?;
    let decoder = BzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);

    archive
        .unpack(dest_dir)
        .map_err(|e| format!("Failed to extract archive: {}", e))?;

    // Find the extracted top-level directory by scanning dest_dir.
    // tar.bz2 archives from sherpa-onnx always have a single top-level directory
    // whose name matches the model filename in the registry.
    let mut extracted_dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dest_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    extracted_dirs.push(path);
                }
            }
        }
    }

    // If there's exactly one non-hidden directory, that's the extracted model dir
    if extracted_dirs.len() == 1 {
        log::info!("Extracted to: {}", extracted_dirs[0].display());
        return Ok(extracted_dirs[0].clone());
    }

    log::info!(
        "Extracted {} items to {}",
        extracted_dirs.len(),
        dest_dir.display()
    );
    Ok(dest_dir.to_path_buf())
}

/// Incomplete extraction must never make a model appear installed.
pub fn install_archive(
    archive: &Path, engine_dir: &Path, filename: &str,
    validate: impl Fn(&Path) -> bool,
) -> Result<std::path::PathBuf, String> {
    let staging = tempfile::Builder::new().prefix(".extract-").tempdir_in(engine_dir)
        .map_err(|e| format!("无法创建解压目录：{e}。请检查磁盘空间和目录权限"))?;
    extract_tar_bz2(archive, staging.path())
        .map_err(|e| format!("模型解压失败：{e}。请检查磁盘空间并重试"))?;
    let prepared = staging.path().join(filename);
    if !prepared.is_dir() || !validate(&prepared) {
        return Err("模型解压后缺少所需文件。请重新下载完整模型包，或检查手动解压的目录层级".into());
    }
    let target = engine_dir.join(filename);
    let backup = staging.path().join(".previous");
    let replaced = target.exists();
    if replaced { std::fs::rename(&target, &backup)
        .map_err(|e| format!("无法替换旧模型：{e}。请停止语音识别后重试"))?; }
    if let Err(e) = std::fs::rename(&prepared, &target) {
        if replaced { let _ = std::fs::rename(&backup, &target); }
        return Err(format!("无法保存解压后的模型：{e}。请检查目录权限"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(status: &str, content_type: &str, body: &[u8], length: usize, stall: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
        let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
        let body = body.to_vec();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048]; let _ = socket.read(&mut request).await;
            let _ = socket.write_all(headers.as_bytes()).await;
            if stall { tokio::time::sleep(std::time::Duration::from_secs(1)).await; }
            let _ = socket.write_all(&body).await;
        });
        url
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().read_timeout(std::time::Duration::from_millis(100)).build().unwrap()
    }
    fn uncancelled() -> Arc<AtomicBool> { Arc::new(AtomicBool::new(false)) }

    #[tokio::test]
    async fn production_download_client_supplies_the_header_required_by_the_mirror() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096]; let n = socket.read(&mut request).await.unwrap();
            let valid = String::from_utf8_lossy(&request[..n]).to_lowercase()
                .contains(&format!("user-agent: mockinterview/{}", env!("CARGO_PKG_VERSION")));
            let response = if valid { "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata" }
                else { "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" };
            socket.write_all(response.as_bytes()).await.unwrap(); valid
        });
        let dir = tempfile::tempdir().unwrap(); let dest = dir.path().join("model.bin");
        download_with_client(&model_http_client(true).unwrap(), &url, &dest, "", uncancelled(), &|_,_,_|{}).await.unwrap();
        assert!(server.await.unwrap()); assert_eq!(std::fs::read(dest).unwrap(), b"data");
    }

    #[tokio::test]
    async fn interrupted_or_corrupted_download_can_retry_without_false_completion() {
        let dir = tempfile::tempdir().unwrap(); let dest = dir.path().join("语音 模型.bin");
        let body = b"synthetic complete model";
        let hash = format!("{:x}", Sha256::digest(body));
        let url = server("200 OK", "application/octet-stream", body, body.len()+100, false).await;
        let progress = std::sync::Mutex::new(Vec::new());
        let emit = |_:u64, _:u64, status:&str| progress.lock().unwrap().push(status.to_owned());
        assert!(download_with_client(&client(), &url, &dest, &hash, uncancelled(), &emit).await.unwrap_err().contains("下载中断"));
        assert!(!dest.exists()); assert!(!dest.with_extension("download").exists());
        let url = server("200 OK", "application/octet-stream", body, body.len(), false).await;
        assert!(download_with_client(&client(), &url, &dest, "wrong-hash", uncancelled(), &emit).await.unwrap_err().contains("SHA-256"));
        assert!(!dest.exists()); assert!(!dest.with_extension("download").exists());
        let url = server("200 OK", "application/octet-stream", body, body.len(), false).await;
        download_with_client(&client(), &url, &dest, &hash, uncancelled(), &emit).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!progress.lock().unwrap().iter().any(|s| ["complete", "error", "cancelled"].contains(&s.as_str())), "only ModelManager sends a terminal event with details");
    }

    #[tokio::test]
    async fn user_errors_are_specific_and_failed_downloads_leave_no_partial_file() {
        let dir = tempfile::tempdir().unwrap(); let dest = dir.path().join("model.bin");
        for (status, mime, body, length, stall, message) in [
            ("503 Unavailable", "text/plain", b"bad".as_slice(), 3, false, "HTTP 503"),
            ("200 OK", "text/html", b"login".as_slice(), 5, false, "网页而不是模型"),
            ("200 OK", "application/octet-stream", b"data".as_slice(), 4, true, "超时"),
        ] {
            let url = server(status, mime, body, length, stall).await;
            let error = download_with_client(&client(), &url, &dest, "", uncancelled(), &|_,_,_|{}).await.unwrap_err();
            assert!(error.contains(message), "{error}");
            assert!(!dest.exists()); assert!(!dest.with_extension("download").exists());
        }
        let file_instead_of_directory = dir.path().join("not-a-directory");
        std::fs::write(&file_instead_of_directory, b"occupied").unwrap();
        let error = download_with_client(&client(), "http://127.0.0.1:1", &file_instead_of_directory.join("model.bin"), "", uncancelled(), &|_,_,_|{}).await.unwrap_err();
        assert!(error.contains("目录无法写入"), "{error}");
        assert_eq!(download_with_client(&client(), "http://127.0.0.1:1", &dest, "", Arc::new(AtomicBool::new(true)), &|_,_,_|{}).await.unwrap_err(), "下载已取消");
    }

    #[tokio::test]
    async fn connection_route_failure_can_fallback_but_http_or_file_errors_do_not_repeat_download() {
        let dead_proxy = reqwest::Client::builder().no_proxy()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap()).build().unwrap();
        let dir = tempfile::tempdir().unwrap(); let dest = dir.path().join("model.bin");
        let url = server("200 OK", "application/octet-stream", b"data", 4, false).await;
        let progress = std::sync::Mutex::new(Vec::new());
        let emit = |_:u64,_:u64,status:&str|progress.lock().unwrap().push(status.to_owned());
        download_with_routes(&dead_proxy, Some(&client()), &url, &dest, "", uncancelled(), &emit).await.unwrap();
        assert!(progress.lock().unwrap().iter().any(|s|s=="connecting_proxy"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"data");
        progress.lock().unwrap().clear();
        let url = server("404 Missing", "text/plain", b"bad", 3, false).await;
        assert!(download_with_routes(&client(), Some(&dead_proxy), &url, &dest, "", uncancelled(), &emit).await.unwrap_err().contains("HTTP 404"));
        assert!(!progress.lock().unwrap().iter().any(|s|s=="connecting_proxy"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"data", "failed replacement keeps the prior file");
    }

    #[test]
    fn extraction_is_committed_only_after_validation_and_preserves_existing_model_on_failure() {
        let dir = tempfile::tempdir().unwrap(); let archive = dir.path().join("model.tar.bz2");
        let encoder = bzip2::write::BzEncoder::new(std::fs::File::create(&archive).unwrap(), bzip2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu(); header.set_size(4); header.set_mode(0o644); header.set_cksum();
        builder.append_data(&mut header, "model/tokens.txt", b"test".as_slice()).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        assert!(install_archive(&archive, dir.path(), "model", |_|false).is_err());
        assert!(!dir.path().join("model").exists());
        std::fs::create_dir(dir.path().join("model")).unwrap();
        std::fs::write(dir.path().join("model/previous"), b"good").unwrap();
        assert!(install_archive(&archive, dir.path(), "model", |_|false).is_err());
        assert!(dir.path().join("model/previous").exists());
        install_archive(&archive, dir.path(), "model", |path|path.join("tokens.txt").is_file()).unwrap();
        assert!(dir.path().join("model/tokens.txt").exists()); assert!(!dir.path().join("model/previous").exists());
        assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".extract-")));
    }

    /// Explicit release audit: real public files, isolated empty directory, no Ollama.
    #[tokio::test]
    #[ignore = "downloads approximately 737 MB from the public domestic mirror"]
    async fn live_domestic_models_download_verify_and_install_in_clean_directory() {
        let root = tempfile::Builder::new().prefix("新用户 下载测试 ").tempdir().unwrap();
        let engine_dir = root.path().join("sherpa_bilingual"); std::fs::create_dir(&engine_dir).unwrap();
        let client = model_http_client(true).unwrap();
        for model_id in ["paraformer-zh-en", "zipformer-zh-en"] {
            let definition = super::super::model_registry::get_model("sherpa_bilingual", model_id).unwrap();
            let archive = engine_dir.join(format!("{}.tar.bz2", definition.filename));
            download_with_client(&client, definition.download_url, &archive, definition.sha256, uncancelled(), &|_,_,_|{}).await.unwrap();
            assert_eq!(std::fs::metadata(&archive).unwrap().len(), definition.size_bytes);
            let installed = install_archive(&archive, &engine_dir, definition.filename,
                |path|crate::stt::sherpa_bilingual::model_files_available(path, model_id)).unwrap();
            assert!(crate::stt::sherpa_bilingual::model_files_available(&installed, model_id));
            println!("{model_id}: complete mirror download, SHA-256, extraction and required files passed in a new Chinese/spaced path");
        }
    }
}

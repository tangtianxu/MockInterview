pub mod downloader;
pub mod model_discovery;
pub mod model_registry;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool,Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use model_registry::{get_engines, get_model, get_models_for_engine, ModelDefinition};

/// Manages local STT model downloads, verification, and storage.
///
/// Storage layout: `{app_data_dir}/models/{engine}/{filename}`
/// For archive models, `filename` is a directory after extraction.
pub struct ModelManager {
    models_dir: PathBuf,
    active_downloads: HashMap<String, DownloadJob>,
}
struct DownloadJob {cancel:Arc<AtomicBool>,finished:Arc<AtomicBool>}
struct FinishDownload(Arc<AtomicBool>);
impl Drop for FinishDownload {fn drop(&mut self){self.0.store(true,Ordering::SeqCst);}}

impl ModelManager {
    pub fn new(models_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&models_dir) {
            log::error!("Failed to create models directory: {}", e);
        }
        Self {
            models_dir,
            active_downloads: HashMap::new(),
        }
    }

    /// Get the base models directory path.
    pub fn models_dir(&self) -> &std::path::Path {
        &self.models_dir
    }

    pub fn set_models_dir(&mut self, models_dir: PathBuf) {
        self.models_dir = models_dir;
    }

    /// Get the path where a model file/directory would be stored.
    fn model_file_path(&self, engine: &str, filename: &str) -> PathBuf {
        self.models_dir.join(engine).join(filename)
    }

    /// Check if a model is downloaded and exists on disk.
    pub fn is_model_downloaded(&self, engine: &str, model_id: &str) -> bool {
        if let Some(def) = get_model(engine, model_id) {
            let path = self.model_file_path(engine, def.filename);
            if engine == "sherpa_bilingual" {
                return crate::stt::sherpa_bilingual::model_files_available(&path, model_id);
            }
            if def.is_archive {
                // Archive models are extracted to a directory
                path.is_dir()
            } else {
                path.exists()
            }
        } else {
            false
        }
    }

    /// Get the path to a downloaded model file/directory, if it exists.
    pub fn get_model_path(&self, engine: &str, model_id: &str) -> Option<PathBuf> {
        let def = get_model(engine, model_id)?;
        let path = self.model_file_path(engine, def.filename);
        if engine == "sherpa_bilingual" &&
            !crate::stt::sherpa_bilingual::model_files_available(&path, model_id) {
            return None;
        }
        if def.is_archive {
            if path.is_dir() {
                Some(path)
            } else {
                None
            }
        } else {
            if path.exists() {
                Some(path)
            } else {
                None
            }
        }
    }

    /// Start downloading a model. Spawns an async task that emits progress events.
    /// For archive models, automatically extracts after download.
    pub fn download_model(
        &mut self,
        engine: &str,
        model_id: &str,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let def = get_model(engine, model_id)
            .ok_or_else(|| format!("Unknown model: {}:{}", engine, model_id))?;

        // Ensure engine subdirectory exists
        let engine_dir = self.models_dir.join(engine);
        std::fs::create_dir_all(&engine_dir)
            .map_err(|e| format!("无法创建模型目录：{}（{e}）。请选择当前用户可写的目录", engine_dir.display()))?;

        let download_key = format!("{}:{}", engine, model_id);
        if self.active_downloads.get(&download_key).is_some_and(|job|!job.finished.load(Ordering::SeqCst)) {
            return Err("该模型正在下载或解压，请等待当前任务结束".into());
        }
        self.active_downloads.remove(&download_key);

        let is_archive = def.is_archive;
        let dest_path = if is_archive {
            // Download the archive to a .tar.bz2 file, extract afterward
            engine_dir.join(format!("{}.tar.bz2", def.filename))
        } else {
            self.model_file_path(engine, def.filename)
        };

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let finished=Arc::new(AtomicBool::new(false));
        self.active_downloads
            .insert(download_key,DownloadJob{cancel:Arc::clone(&cancel_flag),finished:finished.clone()});

        let url = def.download_url.to_string();
        let sha256 = def.sha256.to_string();
        let expected_bytes = def.size_bytes;
        let engine_str = engine.to_string();
        let model_id_str = model_id.to_string();

        // Also capture the expected model directory path for cleanup of old files
        let model_dir_path = engine_dir.join(def.filename);

        tokio::spawn(async move {
            let _finish=FinishDownload(finished);
            let result = downloader::download_file(
                &url,
                &dest_path,
                &sha256,
                &engine_str,
                &model_id_str,
                cancel_flag,
                app_handle.clone(),
            )
            .await;

            if let Err(e) = result {
                log::error!(
                    "Model download failed ({}:{}): {}",
                    engine_str,
                    model_id_str,
                    e
                );
                let _ = app_handle.emit(
                    "model_download_progress",
                    &downloader::DownloadProgress {
                        engine: engine_str,
                        model_id: model_id_str,
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        percent: 0.0,
                        status: if e == "下载已取消" { "cancelled" } else { "error" }.to_string(),
                        error: Some(e),
                    },
                );
                return;
            }

            // These two upstream archives do not publish a SHA-256 in the
            // release metadata. Check their exact advertised byte counts and
            // the required model files before claiming they are installed.
            if engine_str == "sherpa_bilingual" {
                let actual = tokio::fs::metadata(&dest_path).await.map(|m| m.len()).unwrap_or(0);
                if actual != expected_bytes {
                    let _ = tokio::fs::remove_file(&dest_path).await;
                    log::error!("Sherpa model size mismatch: expected {expected_bytes}, got {actual}");
                    let _ = app_handle.emit("model_download_progress", &downloader::DownloadProgress {
                        engine:engine_str, model_id:model_id_str, downloaded_bytes:actual,
                        total_bytes:expected_bytes, percent:0.0, status:"error".into(),
                        error:Some(format!("模型包大小不符：预期 {expected_bytes} 字节，收到 {actual} 字节，请重试下载")),
                    });
                    return;
                }
            }

            // Post-download extraction for archive models
            if is_archive {
                // Emit "extracting" status
                let _ = app_handle.emit(
                    "model_download_progress",
                    &downloader::DownloadProgress {
                        engine: engine_str.clone(),
                        model_id: model_id_str.clone(),
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        percent: 100.0,
                        status: "extracting".to_string(),
                        error: None,
                    },
                );

                let archive_for_extract = dest_path.clone();
                let extract_dest = engine_dir;
                let filename = def.filename.to_owned();
                let validate_engine = engine_str.clone();
                let validate_model = model_id_str.clone();

                let extract_result = tokio::task::spawn_blocking(move || {
                    downloader::install_archive(&archive_for_extract, &extract_dest, &filename, |path| {
                        validate_engine != "sherpa_bilingual" ||
                            crate::stt::sherpa_bilingual::model_files_available(path, &validate_model)
                    })
                })
                .await;

                match extract_result {
                    Ok(Ok(dir)) => {
                        if engine_str == "sherpa_bilingual" &&
                            !crate::stt::sherpa_bilingual::model_files_available(&model_dir_path, &model_id_str) {
                            log::error!("Sherpa model archive extracted without required files: {}", dir.display());
                            let _ = app_handle.emit("model_download_progress", &downloader::DownloadProgress {
                                engine:engine_str, model_id:model_id_str, downloaded_bytes:0,
                                total_bytes:0, percent:0.0, status:"error".into(),
                                error:Some("模型解压后缺少所需文件，请检查磁盘空间并重试下载".into()),
                            });
                            return;
                        }
                        // Delete the archive file
                        let _ = tokio::fs::remove_file(&dest_path).await;
                        log::info!("Model extracted to: {}", dir.display());
                        let _ = app_handle.emit(
                            "model_download_progress",
                            &downloader::DownloadProgress {
                                engine: engine_str,
                                model_id: model_id_str,
                                downloaded_bytes: 0,
                                total_bytes: 0,
                                percent: 100.0,
                                status: "complete".to_string(),
                                error: None,
                            },
                        );
                    }
                    Ok(Err(e)) => {
                        log::error!(
                            "Extraction failed ({}:{}): {}",
                            engine_str,
                            model_id_str,
                            e
                        );
                        let _ = app_handle.emit(
                            "model_download_progress",
                            &downloader::DownloadProgress {
                                engine: engine_str,
                                model_id: model_id_str,
                                downloaded_bytes: 0,
                                total_bytes: 0,
                                percent: 0.0,
                                status: "error".to_string(),
                                error: Some(e),
                            },
                        );
                    }
                    Err(e) => {
                        log::error!(
                            "Extraction task panicked ({}:{}): {}",
                            engine_str,
                            model_id_str,
                            e
                        );
                        let _ = app_handle.emit(
                            "model_download_progress",
                            &downloader::DownloadProgress {
                                engine: engine_str,
                                model_id: model_id_str,
                                downloaded_bytes: 0,
                                total_bytes: 0,
                                percent: 0.0,
                                status: "error".to_string(),
                                error: Some(e.to_string()),
                            },
                        );
                    }
                }
            } else {
                // Non-archive: download is the final step, emit complete
                let _ = app_handle.emit(
                    "model_download_progress",
                    &downloader::DownloadProgress {
                        engine: engine_str,
                        model_id: model_id_str,
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        percent: 100.0,
                        status: "complete".to_string(),
                        error: None,
                    },
                );
            }
        });

        Ok(())
    }

    /// Cancel an active download.
    pub fn cancel_download(&mut self, engine: &str, model_id: &str) {
        let key = format!("{}:{}", engine, model_id);
        if let Some(job) = self.active_downloads.get(&key) {
            job.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            log::info!("Cancelled download for {}:{}", engine, model_id);
        }
    }

    /// Delete a downloaded model from disk (handles both files and directories).
    pub fn delete_model(&mut self, engine: &str, model_id: &str) -> Result<(), String> {
        let key = format!("{engine}:{model_id}");
        if self.active_downloads.get(&key).is_some_and(|job|!job.finished.load(Ordering::SeqCst)) {
            return Err("模型正在下载或解压，请等待任务结束再删除".into());
        }
        let def = get_model(engine, model_id)
            .ok_or_else(|| format!("Unknown model: {}:{}", engine, model_id))?;

        let path = self.model_file_path(engine, def.filename);
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed to delete model directory: {}", e))?;
        } else if path.is_file() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete model file: {}", e))?;
        }
        if def.is_archive {
            let archive = path.with_file_name(format!("{}.tar.bz2", def.filename));
            for leftover in [archive.with_extension("download"), archive] {
                if leftover.is_file() { std::fs::remove_file(&leftover)
                    .map_err(|e| format!("模型已删除，但无法清理下载文件：{e}"))?; }
            }
        }
        log::info!(
            "Deleted model: {}:{} from {}",
            engine,
            model_id,
            path.display()
        );
        Ok(())
    }

    /// List all engines with their models and download status.
    pub fn list_engines_with_status(&self) -> Vec<EngineWithStatus> {
        get_engines()
            .into_iter()
            .map(|eng| {
                let models = get_models_for_engine(eng.engine)
                    .iter()
                    .map(|m| ModelWithStatus {
                        definition: m.clone(),
                        is_downloaded: self.is_model_downloaded(m.engine, m.model_id),
                    })
                    .collect();
                EngineWithStatus {
                    engine: eng.engine.to_string(),
                    name: eng.name.to_string(),
                    description: eng.description.to_string(),
                    models,
                }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelWithStatus {
    pub definition: ModelDefinition,
    pub is_downloaded: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineWithStatus {
    pub engine: String,
    pub name: String,
    pub description: String,
    pub models: Vec<ModelWithStatus>,
}

#[cfg(test)]
mod deletion_tests {
    use super::*;
    #[test]
    fn removal_is_scoped_to_selected_model_and_rejects_an_active_job() {
        let root=tempfile::tempdir().unwrap();
        let mut manager=ModelManager::new(root.path().to_owned());
        let dir=root.path().join("whisper_cpp"); std::fs::create_dir(&dir).unwrap();
        let selected=dir.join("ggml-tiny.bin"); let other=dir.join("ggml-base.bin");
        std::fs::write(&selected,b"selected").unwrap(); std::fs::write(&other,b"keep").unwrap();
        let finished=Arc::new(AtomicBool::new(false));
        manager.active_downloads.insert("whisper_cpp:tiny".into(),DownloadJob{cancel:Arc::new(AtomicBool::new(false)),finished:finished.clone()});
        assert!(manager.delete_model("whisper_cpp","tiny").is_err()); assert!(selected.exists());
        finished.store(true,Ordering::SeqCst);
        manager.delete_model("whisper_cpp","tiny").unwrap(); assert!(!selected.exists());
        assert_eq!(std::fs::read(other).unwrap(),b"keep");
        assert!(manager.delete_model("../","base").is_err());
    }
}

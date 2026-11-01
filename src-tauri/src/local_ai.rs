use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{app_data_dir, hash_file};

const RUNTIME_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b10728/llama-b10728-bin-macos-arm64.tar.gz";
const RUNTIME_SHA256: &str = "c7567b1510bdd674704e722fd90a5e6ed7d717cc0ed5a4e4cdb26635056bd4c8";
const RUNTIME_FOLDER: &str = "llama-b10728";
const MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf";
const MODEL_SHA256: &str = "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5";
const MODEL_BYTES: u64 = 2_497_280_256;

#[derive(Default)]
pub(crate) struct LocalAiManager {
    child: Mutex<Option<Child>>,
}

impl Drop for LocalAiManager {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if let Some(process) = child.as_mut() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalAiStatus {
    installed: bool,
    running: bool,
    model_path: String,
    runtime_path: String,
    model_size_bytes: u64,
    display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiDownloadProgress {
    component: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("runtime").join(RUNTIME_FOLDER))
}

fn server_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("llama-server"))
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app_data_dir(app)?.join("models");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("Qwen3-4B-Q4_K_M.gguf"))
}

fn status(app: &AppHandle, running: bool) -> Result<LocalAiStatus, String> {
    let runtime = server_path(app)?;
    let model = model_path(app)?;
    let model_size_bytes = fs::metadata(&model)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(LocalAiStatus {
        installed: runtime.is_file() && model_size_bytes == MODEL_BYTES,
        running,
        model_path: model.to_string_lossy().into_owned(),
        runtime_path: runtime.to_string_lossy().into_owned(),
        model_size_bytes,
        display_name: "Qwen3 4B · Q4_K_M".into(),
    })
}

#[tauri::command]
pub(crate) fn local_ai_status(
    app: AppHandle,
    state: tauri::State<'_, LocalAiManager>,
) -> Result<LocalAiStatus, String> {
    let mut process = state
        .child
        .lock()
        .map_err(|_| "Local AI process lock failed".to_string())?;
    let running = match process.as_mut() {
        Some(child) => match child.try_wait().map_err(|error| error.to_string())? {
            None => true,
            Some(_) => {
                *process = None;
                false
            }
        },
        None => false,
    };
    status(&app, running)
}

async fn download_verified(
    app: &AppHandle,
    url: &str,
    destination: &Path,
    expected_sha: &str,
    component: &str,
) -> Result<(), String> {
    let partial = destination.with_extension(format!(
        "{}.partial",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    let mut existing = fs::metadata(&partial)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not download {component}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The {component} host returned {}",
            response.status()
        ));
    }
    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if existing > 0 && !resumed {
        existing = 0;
    }
    let total = existing + response.content_length().unwrap_or(0);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&partial)
        .map_err(|error| error.to_string())?;
    let mut downloaded = existing;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("The {component} download was interrupted: {error}"))?;
        file.write_all(&chunk).map_err(|error| error.to_string())?;
        downloaded += chunk.len() as u64;
        let percent = if total == 0 {
            0
        } else {
            ((downloaded.saturating_mul(100) / total).min(100)) as u8
        };
        let _ = app.emit(
            "ai-download-progress",
            AiDownloadProgress {
                component: component.into(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent,
            },
        );
    }
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    let verification = partial.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || hash_file(&verification))
        .await
        .map_err(|error| error.to_string())??;
    if digest != expected_sha {
        return Err(format!(
            "The downloaded {component} failed its SHA-256 integrity check."
        ));
    }
    fs::rename(partial, destination).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn install_local_ai(app: AppHandle) -> Result<LocalAiStatus, String> {
    let runtime_parent = app_data_dir(&app)?.join("runtime");
    fs::create_dir_all(&runtime_parent).map_err(|error| error.to_string())?;
    let archive = runtime_parent.join("llama-macos-arm64.tar.gz");
    if !server_path(&app)?.is_file() {
        download_verified(
            &app,
            RUNTIME_URL,
            &archive,
            RUNTIME_SHA256,
            "llama.cpp runtime",
        )
        .await?;
        let output = Command::new("/usr/bin/tar")
            .args([
                "-xzf",
                archive.to_str().ok_or("Invalid runtime archive path")?,
                "-C",
                runtime_parent.to_str().ok_or("Invalid runtime folder")?,
            ])
            .output()
            .map_err(|error| format!("Could not unpack llama.cpp: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Could not unpack llama.cpp: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let _ = fs::remove_file(&archive);
    }
    let model = model_path(&app)?;
    if fs::metadata(&model)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        != MODEL_BYTES
    {
        download_verified(&app, MODEL_URL, &model, MODEL_SHA256, "Qwen3 4B model").await?;
    }
    status(&app, false)
}

#[tauri::command]
pub(crate) async fn start_local_ai(
    app: AppHandle,
    state: tauri::State<'_, LocalAiManager>,
) -> Result<LocalAiStatus, String> {
    let installed = status(&app, false)?;
    if !installed.installed {
        return Err("Install the Qwen model in Settings first.".into());
    }
    {
        let mut process = state
            .child
            .lock()
            .map_err(|_| "Local AI process lock failed".to_string())?;
        if let Some(child) = process.as_mut() {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return status(&app, true);
            }
        }
        let log_path = app_data_dir(&app)?.join("local-ai.log");
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|error| error.to_string())?;
        let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
        let child = Command::new(server_path(&app)?)
            .current_dir(runtime_root(&app)?)
            .args([
                "-m",
                model_path(&app)?
                    .to_str()
                    .ok_or("Invalid Qwen model path")?,
                "--host",
                "127.0.0.1",
                "--port",
                "8080",
                "-c",
                "8192",
                "-ngl",
                "99",
                "--jinja",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|error| format!("Could not start the local Qwen runtime: {error}"))?;
        *process = Some(child);
    }
    let client = reqwest::Client::new();
    for _ in 0..180 {
        if client
            .get("http://127.0.0.1:8080/health")
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return status(&app, true);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if let Ok(mut process) = state.child.lock() {
        if let Some(mut child) = process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Err("Qwen could not start within 90 seconds. MOCHI stopped the failed local process. Open Settings again to retry; local-ai.log contains the diagnostic.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_downloads_have_sha256_digests() {
        assert_eq!(RUNTIME_SHA256.len(), 64);
        assert_eq!(MODEL_SHA256.len(), 64);
        assert!(MODEL_BYTES > 2_000_000_000);
    }
}

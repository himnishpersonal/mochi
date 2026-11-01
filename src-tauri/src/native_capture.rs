use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub path: PathBuf,
    pub duration_secs: i64,
    pub file_bytes: u64,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioChunk {
    pub id: String,
    pub offset_ms: i64,
    pub source: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub compiled: bool,
    pub supported: bool,
    pub permission: String,
    pub screen_permission: bool,
    pub active: bool,
    pub note_id: Option<String>,
    pub duration_secs: i64,
    pub file_bytes: u64,
    pub system_audio: bool,
    pub system_audio_level: f32,
    pub microphone: bool,
    pub message: String,
}

#[cfg(not(all(target_os = "macos", feature = "native-system-audio")))]
impl CaptureStatus {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            compiled: false,
            supported: cfg!(target_os = "macos"),
            permission: "unavailable".into(),
            screen_permission: false,
            active: false,
            note_id: None,
            duration_secs: 0,
            file_bytes: 0,
            system_audio: false,
            system_audio_level: 0.0,
            microphone: false,
            message: message.into(),
        }
    }
}

#[cfg(all(target_os = "macos", feature = "native-system-audio"))]
mod platform {
    use super::{capture_failure, final_capture_path, CaptureResult, CaptureStatus, NativeAudioChunk};
    use std::{
        ffi::{CStr, CString},
        fs,
        os::raw::c_char,
        path::{Path, PathBuf},
        sync::Mutex,
        collections::HashMap,
        time::Instant,
    };

    extern "C" {
        #[link_name = "mochi_audio_tap_microphone_permission"]
        fn mochi_capture_microphone_preflight() -> bool;
        fn mochi_audio_tap_request_microphone();
        fn mochi_audio_tap_has_samples() -> bool;
        fn mochi_audio_tap_level() -> f32;
        #[link_name = "mochi_audio_tap_start"]
        fn mochi_capture_start(
            path: *const c_char,
            chunks: *const c_char,
            error_buffer: *mut c_char,
            error_capacity: i32,
        ) -> bool;
        #[link_name = "mochi_audio_tap_stop"]
        fn mochi_capture_stop(error_buffer: *mut c_char, error_capacity: i32) -> bool;
        #[link_name = "mochi_audio_tap_is_active"]
        fn mochi_capture_is_active() -> bool;
        #[link_name = "mochi_audio_tap_duration_seconds"]
        fn mochi_capture_duration_seconds() -> i64;
        #[link_name = "mochi_audio_tap_file_bytes"]
        fn mochi_capture_file_bytes() -> i64;
        #[link_name = "mochi_audio_tap_last_error"]
        fn mochi_capture_last_error(error_buffer: *mut c_char, error_capacity: i32);
    }

    fn screen_permission_granted() -> bool {
        unsafe { mochi_capture_microphone_preflight() }
    }

    fn bridge_error(buffer: &[c_char]) -> String {
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    struct ActiveCapture {
        note_id: String,
        partial_path: std::path::PathBuf,
        started_at: Instant,
    }

    #[derive(Default)]
    pub struct NativeCaptureManager {
        active: Mutex<Option<ActiveCapture>>,
        operation: Mutex<()>,
        chunk_directories: Mutex<HashMap<String, PathBuf>>,
    }

    impl NativeCaptureManager {
        pub fn register_chunk_directory(&self, note_id: &str, directory: &Path) -> Result<(), String> {
            self.chunk_directories.lock().map_err(|_| "Live audio storage is unavailable.".to_string())?.insert(note_id.to_owned(), directory.to_owned());
            Ok(())
        }

        pub fn start(&self, note_id: &str, partial_path: &Path, chunk_directory: &Path) -> Result<CaptureStatus, String> {
            let _operation = self.operation.try_lock().map_err(|_| "A recording is already starting or stopping.".to_string())?;
            let active = self
                .active
                .lock()
                .map_err(|_| "Capture state is unavailable.".to_string())?;
            if active.is_some() {
                return Err("A recording is already in progress.".into());
            }
            drop(active);
            if !screen_permission_granted() {
                return Err("Microphone access is required. Allow MOCHI in System Settings, then try again.".into());
            }
            let path = CString::new(partial_path.to_string_lossy().as_bytes())
                .map_err(|_| "The recording path contains an invalid null byte.".to_string())?;
            fs::create_dir_all(chunk_directory).map_err(|error| format!("Could not prepare live transcript storage: {error}"))?;
            let chunks = CString::new(chunk_directory.to_string_lossy().as_bytes())
                .map_err(|_| "The live transcript path contains an invalid null byte.".to_string())?;
            let mut error_buffer = vec![0 as c_char; 2_048];
            if !unsafe {
                mochi_capture_start(
                    path.as_ptr(),
                    chunks.as_ptr(),
                    error_buffer.as_mut_ptr(),
                    error_buffer.len() as i32,
                )
            } {
                return Err(bridge_error(&error_buffer));
            }

            *self.active.lock().map_err(|_| "Capture state is unavailable.".to_string())? = Some(ActiveCapture {
                note_id: note_id.to_owned(),
                partial_path: partial_path.to_owned(),
                started_at: Instant::now(),
            });
            self.chunk_directories.lock().map_err(|_| "Live audio storage is unavailable.".to_string())?.insert(note_id.to_owned(), chunk_directory.to_owned());
            Ok(self.status())
        }

        pub fn drain_chunks(&self, note_id: &str) -> Result<Vec<NativeAudioChunk>, String> {
            let directories = self.chunk_directories.lock().map_err(|_| "Live audio storage is unavailable.".to_string())?;
            let directory = directories.get(note_id).ok_or_else(|| "No live audio session exists for this note.".to_string())?;
            let mut paths = fs::read_dir(directory).map_err(|error| error.to_string())?.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|extension| extension == "m4a" || extension == "caf") && !path.to_string_lossy().contains(".partial.")).collect::<Vec<_>>();
            paths.sort_by_key(|path| {
                path.file_name().and_then(|name| name.to_str())
                    .and_then(|name| name.strip_prefix("audio-system-").and_then(|value| value.strip_suffix(".m4a").or_else(|| value.strip_suffix(".caf"))))
                    .and_then(|offset| offset.parse::<i64>().ok())
                    .unwrap_or(i64::MAX)
            });
            paths.into_iter().map(|path| {
                let id = path.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid live audio chunk name.".to_string())?.to_owned();
                let stem = id.strip_prefix("audio-system-").and_then(|value| value.strip_suffix(".m4a").or_else(|| value.strip_suffix(".caf"))).ok_or_else(|| "Invalid live audio chunk name.".to_string())?;
                let offset_ms = stem.parse::<i64>().map_err(|_| "Invalid live audio timestamp.".to_string())?;
                let bytes = fs::read(&path).map_err(|error| error.to_string())?;
                let mime_type = if id.ends_with(".caf") { "audio/x-caf" } else { "audio/mp4" };
                Ok(NativeAudioChunk { id, offset_ms, source: "system".into(), mime_type: mime_type.into(), bytes })
            }).take(3).collect()
        }

        pub fn acknowledge_chunk(&self, note_id: &str, id: &str) -> Result<(), String> {
            if Path::new(id).file_name().and_then(|name| name.to_str()) != Some(id) || !id.starts_with("audio-system-") || !(id.ends_with(".m4a") || id.ends_with(".caf")) || id.contains(".partial.") { return Err("Invalid live audio chunk identifier.".into()); }
            let directories = self.chunk_directories.lock().map_err(|_| "Live audio storage is unavailable.".to_string())?;
            let directory = directories.get(note_id).ok_or_else(|| "No live audio session exists for this note.".to_string())?;
            fs::remove_file(directory.join(id)).map_err(|error| error.to_string())
        }

        pub fn stop(&self, note_id: &str) -> Result<CaptureResult, String> {
            let _operation = self.operation.try_lock().map_err(|_| "A recording is already starting or stopping.".to_string())?;
            let (partial_path, duration_secs) = {
                let active = self
                    .active
                    .lock()
                    .map_err(|_| "Capture state is unavailable.".to_string())?;
                let capture = active
                    .as_ref()
                    .ok_or_else(|| "No native recording is in progress.".to_string())?;
                if capture.note_id != note_id {
                    return Err("That note does not own the active recording.".into());
                }
                (
                    capture.partial_path.clone(),
                    capture.started_at.elapsed().as_secs().max(1) as i64,
                )
            };

            let mut error_buffer = vec![0 as c_char; 2_048];
            if !unsafe {
                mochi_capture_stop(error_buffer.as_mut_ptr(), error_buffer.len() as i32)
            } {
                if !unsafe { mochi_capture_is_active() } {
                    self.active.lock().map_err(|_| "Capture state is unavailable.".to_string())?.take();
                }
                return Err(capture_failure(&partial_path, &bridge_error(&error_buffer)));
            }
            self.active
                .lock()
                .map_err(|_| "Capture state is unavailable after stopping.".to_string())?
                .take();

            let file_bytes = fs::metadata(&partial_path)
                .map_err(|error| format!("The recording file was not created: {error}"))?
                .len();
            if file_bytes < 1_024 {
                return Err(format!(
                    "The recording did not contain usable audio. The partial file was kept at {}.",
                    partial_path.display()
                ));
            }
            let final_path = final_capture_path(&partial_path)?;
            fs::rename(&partial_path, &final_path)
                .map_err(|error| format!("The recording was captured but could not be committed locally: {error}"))?;

            Ok(CaptureResult {
                path: final_path,
                duration_secs,
                file_bytes,
                warning: { let message = bridge_error(&error_buffer); if message.is_empty() { None } else { Some(message) } },
            })
        }

        pub fn status(&self) -> CaptureStatus {
            // Core Audio does not expose a public preflight API. Starting a tap
            // asks macOS for system-audio access; actual samples confirm it.
            let screen_permission = unsafe { mochi_audio_tap_has_samples() };
            let microphone = unsafe { mochi_capture_microphone_preflight() };
            let permission = if !microphone { "microphone_required" } else if screen_permission { "granted" } else { "audio_permission_unknown" };
            let Ok(active) = self.active.lock() else {
                return CaptureStatus {
                    compiled: true,
                    supported: true,
                    permission: permission.into(),
                    screen_permission,
                    active: false,
                    note_id: None,
                    duration_secs: 0,
                    file_bytes: 0,
                    system_audio: true,
                    system_audio_level: 0.0,
                    microphone,
                    message: "Capture state is unavailable.".into(),
                };
            };
            if let Some(capture) = active.as_ref() {
                let bridge_active = unsafe { mochi_capture_is_active() };
                CaptureStatus {
                    compiled: true,
                    supported: true,
                    permission: permission.into(),
                    screen_permission,
                    active: bridge_active,
                    note_id: Some(capture.note_id.clone()),
                    duration_secs: unsafe { mochi_capture_duration_seconds() }
                        .max(capture.started_at.elapsed().as_secs() as i64),
                    file_bytes: unsafe { mochi_capture_file_bytes() }.max(0) as u64,
                    system_audio: true,
                    system_audio_level: unsafe { mochi_audio_tap_level() },
                    microphone,
                    message: if bridge_active && screen_permission {
                        "Capturing Mac audio and microphone locally.".into()
                    } else if bridge_active {
                        "Waiting for Mac audio samples. Play audio and check System Audio Recording permission.".into()
                    } else {
                        let mut buffer = vec![0 as c_char; 2_048];
                        unsafe { mochi_capture_last_error(buffer.as_mut_ptr(), buffer.len() as i32) };
                        bridge_error(&buffer)
                    },
                }
            } else {
                CaptureStatus {
                    compiled: true,
                    supported: true,
                    permission: permission.into(),
                    screen_permission,
                    active: false,
                    note_id: None,
                    duration_secs: 0,
                    file_bytes: 0,
                    system_audio: true,
                    system_audio_level: 0.0,
                    microphone,
                    message: if permission == "audio_permission_unknown" {
                        "macOS requests System Audio Recording access when capture starts.".into()
                    } else if permission == "microphone_required" {
                        "Microphone permission is required.".into()
                    } else {
                        "Recording permissions need attention.".into()
                    },
                }
            }
        }
    }

    pub fn request_permission() -> bool {
        unsafe { mochi_audio_tap_request_microphone(); mochi_capture_microphone_preflight() }
    }
}

#[cfg(not(all(target_os = "macos", feature = "native-system-audio")))]
mod platform {
    use super::{CaptureResult, CaptureStatus, NativeAudioChunk};
    use std::path::Path;

    #[derive(Default)]
    pub struct NativeCaptureManager;

    impl NativeCaptureManager {
        pub fn register_chunk_directory(&self, _note_id: &str, _directory: &Path) -> Result<(), String> { Ok(()) }
        pub fn start(&self, _note_id: &str, _path: &Path, _chunk_directory: &Path) -> Result<CaptureStatus, String> {
            Err("This copy of MOCHI does not include system-audio capture. Install the system-audio build or choose Room microphone.".into())
        }
        pub fn drain_chunks(&self, _note_id: &str) -> Result<Vec<NativeAudioChunk>, String> { Ok(Vec::new()) }
        pub fn acknowledge_chunk(&self, _note_id: &str, _id: &str) -> Result<(), String> { Ok(()) }

        pub fn stop(&self, _note_id: &str) -> Result<CaptureResult, String> {
            Err("No system-audio recording is in progress.".into())
        }

        pub fn status(&self) -> CaptureStatus {
            CaptureStatus::unavailable(if cfg!(target_os = "macos") {
                "This build does not include system-audio capture."
            } else {
                "System-audio capture currently requires macOS 15 or later."
            })
        }
    }

    pub fn request_permission() -> bool {
        false
    }
}

pub use platform::NativeCaptureManager;

pub const fn is_available() -> bool {
    cfg!(all(target_os = "macos", feature = "native-system-audio"))
}

fn capture_failure(path: &Path, detail: &str) -> String {
    if std::fs::metadata(path).map(|file| file.len() > 0).unwrap_or(false) {
        format!("Recording could not be finalized. An incomplete file exists at {} and may not be playable. {detail}", path.display())
    } else if std::fs::metadata(format!("{}.system.caf", path.display())).map(|file| file.len() > 0).unwrap_or(false)
        || std::fs::metadata(format!("{}.microphone.caf", path.display())).map(|file| file.len() > 0).unwrap_or(false) {
        format!("Recording could not be combined. The separate audio source files were kept. {detail}")
    } else {
        format!("Recording failed. No recording file was saved. {detail}")
    }
}

pub fn capture_partial_path(audio_dir: &Path, note_id: &str, timestamp: i64) -> PathBuf {
    audio_dir.join(format!("{note_id}.{timestamp}.capture.partial.mp4"))
}

#[cfg(any(test, all(target_os = "macos", feature = "native-system-audio")))]
pub fn final_capture_path(partial: &Path) -> Result<PathBuf, String> {
    let filename = partial
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The partial recording filename is invalid.".to_string())?;
    let final_name = filename
        .strip_suffix(".partial.mp4")
        .map(|name| format!("{name}.mp4"))
        .ok_or_else(|| "The partial recording does not use MOCHI's safe filename format.".to_string())?;
    Ok(partial.with_file_name(final_name))
}

pub fn request_permission() -> bool {
    platform::request_permission()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_file_is_scoped_to_note_identifier_and_unique_session() {
        let partial = capture_partial_path(Path::new("/audio"), "note-id", 42);
        assert_eq!(
            partial,
            PathBuf::from("/audio/note-id.42.capture.partial.mp4")
        );
        assert_eq!(
            final_capture_path(&partial).unwrap(),
            PathBuf::from("/audio/note-id.42.capture.mp4")
        );
    }

    #[test]
    fn unrelated_partial_names_are_never_committed() {
        assert!(final_capture_path(Path::new("/audio/random.mp4")).is_err());
    }

    #[test]
    fn failure_only_offers_a_partial_file_when_it_exists() {
        let directory = std::env::temp_dir().join(format!("mochi-capture-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("test.partial.mp4");
        assert!(capture_failure(&path, "Writer failed").contains("No recording file was saved"));
        std::fs::write(&path, []).unwrap();
        assert!(capture_failure(&path, "Writer failed").contains("No recording file was saved"));
        std::fs::write(&path, [1, 2, 3]).unwrap();
        let message = capture_failure(&path, "Writer failed");
        assert!(message.contains("incomplete file exists"));
        assert!(message.contains("may not be playable"));
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
}

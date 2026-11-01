#[cfg(target_os = "macos")]
pub fn configure_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    extern "C" {
        fn mochi_configure_overlay_window(window: *mut std::ffi::c_void);
    }
    // Configure and show natively: Tauri's show() makes the window key, which
    // can move the user away from another app's full-screen Space.
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    unsafe { mochi_configure_overlay_window(pointer) };
    Ok(())
}

pub fn show_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    configure_overlay(window)?;
    #[cfg(not(target_os = "macos"))]
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn configure_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    window
        .set_visible_on_all_workspaces(true)
        .map_err(|error| error.to_string())
}
pub fn position_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" { fn mochi_position_overlay_window(window: *mut std::ffi::c_void); }
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        unsafe { mochi_position_overlay_window(pointer) };
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    window.center().map_err(|error| error.to_string())
}


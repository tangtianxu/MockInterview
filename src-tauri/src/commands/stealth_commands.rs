//! Display privacy controls for this application's two top-level windows.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "config.json";
const STORE_KEY: &str = "privacy_display";
const ERROR_KEY: &str = "privacy_display_last_error";

#[derive(Default, Deserialize, Serialize)]
struct SavedPrivacy {
    capture_exclusion: bool,
    taskbar_hidden: bool,
}

#[derive(Serialize)]
pub struct PrivacyDisplayState {
    pub launcher_capture_excluded: bool,
    pub overlay_capture_excluded: bool,
    pub taskbar_hidden: bool,
    pub errors: Vec<String>,
    pub capture_mode: &'static str,
    pub windows_build: Option<u32>,
}

fn capture_affinity(build: Option<u32>) -> u32 {
    // WDA_EXCLUDEFROMCAPTURE requires Windows 10 version 2004 (build 19041).
    // Older systems support WDA_MONITOR: captured content becomes a black block.
    if build.is_some_and(|value| value >= 19041) { 0x11 } else { 0x1 }
}

fn saved(app: &AppHandle) -> SavedPrivacy {
    app.store(STORE_FILE).ok()
        .and_then(|store| store.get(STORE_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, value: &SavedPrivacy) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(value).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

fn record_error(app: &AppHandle, error: Option<&str>) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(ERROR_KEY, error.unwrap_or(""));
        let _ = store.save();
    }
}

fn last_error(app: &AppHandle) -> Option<String> {
    app.store(STORE_FILE).ok()
        .and_then(|store| store.get(ERROR_KEY))
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
mod native {
    use std::{collections::HashMap, sync::{Mutex, OnceLock}};
    use tauri::{AppHandle, Manager};
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowDisplayAffinity, GetWindowLongPtrW, IsWindowVisible,
            SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            SW_HIDE, SW_SHOW, SW_SHOWNA, WINDOW_DISPLAY_AFFINITY,
            WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
        },
    };

    static ORIGINAL_STYLES: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();

    pub fn windows_build() -> Option<u32> {
        #[repr(C)]
        struct Version {size:u32,major:u32,minor:u32,build:u32,platform:u32,service_pack:[u16;128]}
        #[link(name="ntdll")]
        unsafe extern "system" { fn RtlGetVersion(version:*mut Version) -> i32; }
        static BUILD: OnceLock<Option<u32>>=OnceLock::new();
        *BUILD.get_or_init(|| {
            let mut version=Version{size:std::mem::size_of::<Version>() as u32,major:0,minor:0,build:0,platform:0,service_pack:[0;128]};
            // RtlGetVersion is independent of the application's compatibility manifest.
            if unsafe {RtlGetVersion(&mut version)} >= 0 {Some(version.build)} else {None}
        })
    }

    fn window(app: &AppHandle, label: &str) -> Result<HWND, String> {
        let window = app.get_webview_window(label)
            .ok_or_else(|| format!("窗口 {label} 不存在"))?;
        window.hwnd().map(|handle| HWND(handle.0 as *mut _))
            .map_err(|e| format!("窗口 {label} 句柄不可用：{e}"))
    }

    pub fn capture(app: &AppHandle, label: &str, enabled: bool) -> Result<(), String> {
        let hwnd = window(app, label)?;
        let wanted = if enabled { super::capture_affinity(windows_build()) } else { 0 };
        unsafe {
            SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(wanted))
                .map_err(|e| format!("窗口 {label} 捕获排除设置失败：{e}"))?;
            let mut actual = 0;
            GetWindowDisplayAffinity(hwnd, &mut actual)
                .map_err(|e| format!("窗口 {label} 无法读取捕获排除状态：{e}"))?;
            if actual != wanted {
                return Err(format!("窗口 {label} 捕获排除状态不一致：预期 {wanted:#x}，实际 {actual:#x}"));
            }
        }
        Ok(())
    }

    pub fn capture_enabled(app: &AppHandle, label: &str) -> Result<bool, String> {
        let hwnd = window(app, label)?;
        let mut actual = 0;
        unsafe { GetWindowDisplayAffinity(hwnd, &mut actual) }
            .map_err(|e| format!("窗口 {label} 无法读取捕获排除状态：{e}"))?;
        Ok(actual == super::capture_affinity(windows_build()))
    }

    pub fn taskbar(app: &AppHandle, enabled: bool) -> Result<(), String> {
        let hwnd = window(app, "launcher")?;
        let key = hwnd.0 as isize;
        let styles = ORIGINAL_STYLES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut styles = styles.lock().map_err(|e| e.to_string())?;
        let mask = (WS_EX_TOOLWINDOW.0 | WS_EX_APPWINDOW.0) as isize;
        unsafe {
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let had_original = styles.contains_key(&key);
            let desired = if enabled {
                styles.entry(key).or_insert(current);
                (current | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize)
            } else if let Some(original) = styles.get(&key) {
                (current & !mask) | (original & mask)
            } else { current };
            // Explorer needs the window hidden before a taskbar style change.
            // Repeat the hide/show when reapplying a saved style to refresh a stale button.
            let was_visible = IsWindowVisible(hwnd).as_bool();
            let was_foreground = GetForegroundWindow() == hwnd;
            if was_visible { let _ = ShowWindow(hwnd, SW_HIDE); }
            let result = (|| -> Result<(), String> {
                if desired != current { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desired); }
                if let Err(error) = SetWindowPos(hwnd, HWND(std::ptr::null_mut()), 0, 0, 0, 0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current);
                    let _ = SetWindowPos(hwnd, HWND(std::ptr::null_mut()), 0, 0, 0, 0,
                        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                    return Err(format!("刷新窗口样式失败：{error}"));
                }
                let actual = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                if actual & mask != desired & mask {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current);
                    let _ = SetWindowPos(hwnd, HWND(std::ptr::null_mut()), 0, 0, 0, 0,
                        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                    return Err(format!("窗口样式未生效：预期 {:#x}，实际 {:#x}", desired & mask, actual & mask));
                }
                Ok(())
            })();
            if was_visible { let _ = ShowWindow(hwnd, if was_foreground { SW_SHOW } else { SW_SHOWNA }); }
            if result.is_err() && enabled && !had_original { styles.remove(&key); }
            result?;
            if !enabled { styles.remove(&key); }
        }
        Ok(())
    }

    pub fn taskbar_hidden(app: &AppHandle) -> Result<bool, String> {
        let hwnd = window(app, "launcher")?;
        let flags = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        Ok(flags & WS_EX_TOOLWINDOW.0 as isize != 0 && flags & WS_EX_APPWINDOW.0 as isize == 0)
    }
}

pub fn restore_capture_on_startup(app: &AppHandle) {
    // Each launch starts protected, independently of the previous session's switches.
    // Reuse the runtime path so startup has the same verification and rollback.
    if let Err(error) = set_capture_exclusion(app.clone(), true) {
        log::error!("Privacy display startup: {error}");
        let mut config = saved(app);
        config.capture_exclusion = false;
        if let Err(error) = save(app, &config) {
            log::error!("Privacy display startup preference: {error}");
        }
    }
}

pub fn recheck_capture(app: &AppHandle, label: &str) {
    if !saved(app).capture_exclusion || !matches!(label, "launcher" | "overlay") { return; }
    #[cfg(windows)]
    match native::capture_enabled(app, label) {
        Ok(true) => {}
        Ok(false) => {
            if let Err(error) = native::capture(app, label, true) {
                log::error!("Privacy display reapply: {error}");
            }
        }
        Err(error) => log::error!("Privacy display check: {error}"),
    }
}

#[tauri::command]
pub fn get_privacy_display_state(app: AppHandle) -> PrivacyDisplayState {
    #[cfg(windows)]
    {
        let mut errors = Vec::new();
        if let Some(error) = last_error(&app) { errors.push(error); }
        let mut read_capture = |label| match native::capture_enabled(&app, label) {
            Ok(value) => value,
            Err(error) => { errors.push(error); false }
        };
        let launcher_capture_excluded = read_capture("launcher");
        let overlay_capture_excluded = read_capture("overlay");
        let taskbar_hidden = match native::taskbar_hidden(&app) {
            Ok(value) => value,
            Err(error) => { errors.push(error); false }
        };
        let windows_build=native::windows_build();
        PrivacyDisplayState { launcher_capture_excluded, overlay_capture_excluded, taskbar_hidden, errors,
            capture_mode:if capture_affinity(windows_build)==0x11 {"exclude"} else {"blackout"},windows_build }
    }
    #[cfg(not(windows))]
    { let _ = app; PrivacyDisplayState { launcher_capture_excluded:false, overlay_capture_excluded:false, taskbar_hidden:false, errors:vec!["仅支持 Windows".into()],capture_mode:"unsupported",windows_build:None } }
}

#[tauri::command]
pub fn set_capture_exclusion(app: AppHandle, enabled: bool) -> Result<PrivacyDisplayState, String> {
    #[cfg(windows)]
    {
        for label in ["launcher", "overlay"] {
            if let Err(error) = native::capture(&app, label, enabled) {
                for label in ["launcher", "overlay"] { let _ = native::capture(&app, label, false); }
                log::error!("Privacy display capture: {error}");
                record_error(&app, Some(&error));
                return Err(error);
            }
        }
        let mut config = saved(&app);
        config.capture_exclusion = enabled;
        save(&app, &config)?;
        record_error(&app, None);
        log::info!("Privacy display capture exclusion: {enabled}");
        Ok(get_privacy_display_state(app))
    }
    #[cfg(not(windows))]
    { let _ = (app, enabled); Err("仅支持 Windows".into()) }
}

#[tauri::command]
pub fn set_taskbar_hidden(app: AppHandle, enabled: bool) -> Result<PrivacyDisplayState, String> {
    #[cfg(windows)]
    {
        native::taskbar(&app, enabled).inspect_err(|error| {
            log::error!("Privacy display taskbar: {error}");
            record_error(&app, Some(error));
        })?;
        let mut config = saved(&app);
        config.taskbar_hidden = enabled;
        save(&app, &config)?;
        record_error(&app, None);
        log::info!("Privacy display taskbar hidden: {enabled}");
        Ok(get_privacy_display_state(app))
    }
    #[cfg(not(windows))]
    { let _ = (app, enabled); Err("仅支持 Windows".into()) }
}

#[tauri::command]
pub fn get_saved_taskbar_preference(app: AppHandle) -> bool {
    saved(&app).taskbar_hidden
}

#[cfg(test)]
mod tests {
    use super::capture_affinity;
    #[test]
    fn capture_compatibility_uses_real_windows_build() {
        assert_eq!(capture_affinity(Some(18363)),1);
        assert_eq!(capture_affinity(Some(19041)),0x11);
        assert_eq!(capture_affinity(Some(22631)),0x11);
        assert_eq!(capture_affinity(None),1);
    }
}

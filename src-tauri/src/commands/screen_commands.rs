//! One-shot local capture and OCR. Images never leave this command or touch disk.
use serde::Serialize;
use tauri::{AppHandle, command};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenText {
    text: String,
    width: u32,
    height: u32,
    preview: String,
}

static CAPTURING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[command]
pub async fn capture_code_screen(app: AppHandle) -> Result<ScreenText, String> {
    use std::sync::atomic::Ordering;
    if CAPTURING.swap(true, Ordering::SeqCst) { return Err("正在截屏，请稍候".into()); }
    struct Reset;
    impl Drop for Reset { fn drop(&mut self) { CAPTURING.store(false, Ordering::SeqCst); } }
    let reset = Reset;
    let result = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)] { native::capture(app) }
        #[cfg(not(windows))] { let _ = app; Err("截屏识题目前支持 Windows".into()) }
    }).await.map_err(|e| format!("截屏任务失败：{e}"))?;
    drop(reset);
    result
}

#[cfg(windows)]
mod native {
    use super::ScreenText;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use image::{DynamicImage, RgbaImage, ImageFormat};
    use std::io::Cursor;
    use tauri::{AppHandle, Manager};
    use windows::{
        Graphics::Imaging::{SoftwareBitmap, BitmapPixelFormat},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
        Win32::{
            Foundation::{HWND, POINT},
            Graphics::{Dwm::DwmFlush, Gdi::*},
            System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
            UI::WindowsAndMessaging::{GetCursorPos, IsWindowVisible, IsIconic, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE},
        },
    };

    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { RoUninitialize(); } } }
    // Store only windows we actually hide, so hidden/minimized windows stay that way.
    struct HiddenWindows(Vec<HWND>);
    impl Drop for HiddenWindows {
        fn drop(&mut self) { for hwnd in &self.0 { unsafe { let _ = ShowWindow(*hwnd, SW_SHOWNOACTIVATE); } } }
    }
    struct DesktopBitmap { screen: HDC, memory: HDC, bitmap: HBITMAP }
    impl Drop for DesktopBitmap {
        fn drop(&mut self) { unsafe {
            if !self.bitmap.is_invalid() { let _ = DeleteObject(self.bitmap); }
            if !self.memory.is_invalid() { let _ = DeleteDC(self.memory); }
            if !self.screen.is_invalid() { let _ = ReleaseDC(HWND::default(), self.screen); }
        } }
    }

    pub fn capture(app: AppHandle) -> Result<ScreenText, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| format!("初始化本机文字识别失败：{e}"))?;
        let _apartment = Apartment;
        // Resolve the engine before hiding any UI. Missing language packs have a useful remedy.
        let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| {
            "Windows 文字识别不可用。请在 Windows 设置→时间和语言→语言选项中安装中文／英文的“基本输入”和 OCR 语言组件，再重试。".to_string()
        })?;
        let max_dimension = OcrEngine::MaxImageDimension().map_err(|e| e.to_string())?;
        let mut cursor = POINT::default();
        unsafe { GetCursorPos(&mut cursor) }.map_err(|e| format!("读取鼠标所在屏幕失败：{e}"))?;
        let monitor = unsafe { MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() { return Err("无法读取当前屏幕范围".into()); }
        let width = info.rcMonitor.right - info.rcMonitor.left;
        let height = info.rcMonitor.bottom - info.rcMonitor.top;
        if width <= 0 || height <= 0 || (width as u64 * height as u64) > 80_000_000 { return Err("屏幕尺寸无效或过大".into()); }
        // Hide every app webview for this capture, even when persistent capture exclusion is off.
        // DwmFlush ensures the compositor has revealed the underlying question before BitBlt.
        let mut hidden = HiddenWindows(Vec::new());
        for window in app.webview_windows().values() {
            let handle = window.hwnd().map_err(|e| format!("无法排除软件窗口：{e}"))?;
            let hwnd = HWND(handle.0 as *mut _);
            if unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() } {
                hidden.0.push(hwnd);
                unsafe { let _ = ShowWindow(hwnd, SW_HIDE); }
                if unsafe { IsWindowVisible(hwnd) }.as_bool() { return Err("软件窗口尚未隐藏，已停止截图".into()); }
            }
        }
        unsafe { DwmFlush() }.map_err(|e| format!("等待屏幕刷新失败，已停止截图：{e}"))?;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        unsafe {
            let mut bitmap = DesktopBitmap {screen:GetDC(HWND::default()),memory:HDC::default(),bitmap:HBITMAP::default()};
            if bitmap.screen.is_invalid() { return Err("无法读取桌面，请检查是否处于锁屏或受保护桌面".into()); }
            bitmap.memory = CreateCompatibleDC(bitmap.screen);
            bitmap.bitmap = CreateCompatibleBitmap(bitmap.screen, width, height);
            if bitmap.memory.is_invalid() || bitmap.bitmap.is_invalid() { return Err("分配截屏缓冲区失败".into()); }
            let previous = SelectObject(bitmap.memory, bitmap.bitmap);
            let copied = BitBlt(bitmap.memory,0,0,width,height,bitmap.screen,info.rcMonitor.left,info.rcMonitor.top,SRCCOPY | CAPTUREBLT);
            // GetDIBits requires the bitmap to be deselected, including on failed copies.
            SelectObject(bitmap.memory, previous);
            copied.map_err(|e| format!("读取屏幕图像失败：{e}"))?;
            let mut format = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
                biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth:width, biHeight:-height,
                biPlanes:1, biBitCount:32, biCompression:BI_RGB.0, ..Default::default()
            }, ..Default::default() };
            if GetDIBits(bitmap.screen,bitmap.bitmap,0,height as u32,Some(pixels.as_mut_ptr().cast()),&mut format,DIB_RGB_COLORS) != height {
                return Err("截屏像素读取不完整，请重试".into());
            }
        }
        drop(hidden); // Restore immediately; OCR can take longer than the screen copy.
        for pixel in pixels.chunks_exact_mut(4) { pixel.swap(0,2); pixel[3]=255; }
        let rgba = RgbaImage::from_raw(width as u32,height as u32,pixels).ok_or("截屏图像格式无效")?;
        let image = DynamicImage::ImageRgba8(rgba);
        let bound = max_dimension.min(4096);
        let image = if image.width()>bound || image.height()>bound {image.resize(bound,bound,image::imageops::FilterType::Lanczos3)} else {image};
        let text = recognize_image(&image,&engine)?;
        if text.trim().is_empty() { return Err("本次未识别到文字。请将题目放大并完整显示后再按截屏键，也可直接输入题目。".into()); }
        if text.chars().count()>24_000 { return Err("屏幕文字过多，请放大题目、收起无关区域后重新截图，或直接粘贴题目。".into()); }
        let preview = image.thumbnail(1200,900);
        let mut png = Cursor::new(Vec::new());
        preview.write_to(&mut png,ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(ScreenText {text:text.trim().into(),width:width as u32,height:height as u32,
            preview:format!("data:image/png;base64,{}",STANDARD.encode(png.into_inner()))})
    }

    fn recognize_image(image:&DynamicImage,engine:&OcrEngine)->Result<String,String>{
        let mut bgra = image.to_rgba8().into_raw();
        for pixel in bgra.chunks_exact_mut(4) { pixel.swap(0,2); }
        let writer = DataWriter::new().map_err(|e| e.to_string())?;
        writer.WriteBytes(&bgra).map_err(|e| e.to_string())?;
        let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer,BitmapPixelFormat::Bgra8,image.width() as i32,image.height() as i32).map_err(|e| e.to_string())?;
        let recognized = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?.get().map_err(|e| format!("识别屏幕文字失败：{e}"))?;
        // Preserve line breaks and relative left margins instead of joining code into a paragraph.
        let mut text = String::new();
        let mut lines = Vec::new();
        for line in recognized.Lines().map_err(|e| e.to_string())? {
            let words=line.Words().map_err(|e|e.to_string())?;
            let left=words.GetAt(0).ok().and_then(|w|w.BoundingRect().ok()).map(|r|r.X).unwrap_or(0.0);
            lines.push((left,normalize_cjk_spacing(&line.Text().map_err(|e|e.to_string())?.to_string())));
        }
        let left=lines.iter().map(|(x,_)|*x).fold(f32::INFINITY,f32::min);
        for (x,line) in lines {
            let indent=((x-left)/8.0).round().clamp(0.0,80.0) as usize;
            text.push_str(&" ".repeat(indent));text.push_str(&line);
            text.push('\n');
        }
        Ok(text)
    }

    fn normalize_cjk_spacing(text:&str)->String {
        let chars:Vec<char>=text.chars().collect();
        let chinese=|c:char| ('\u{3400}'..='\u{9fff}').contains(&c)||"，。；：！？、（）【】《》".contains(c);
        chars.iter().enumerate().filter_map(|(i,c)| {
            if c.is_whitespace() && i>0 && chinese(chars[i-1]) && chars[i+1..].iter().find(|c|!c.is_whitespace()).is_some_and(|c|chinese(*c)){None}else{Some(*c)}
        }).collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn local_ocr_reads_chinese_question_and_english_code_without_network() {
            unsafe {RoInitialize(RO_INIT_MULTITHREADED)}.unwrap();let _apartment=Apartment;
            let engine=OcrEngine::TryCreateFromUserProfileLanguages().expect("Windows OCR language component must be installed");
            let image=image::load_from_memory(include_bytes!("../../../evaluation/fixtures/code-question.png")).unwrap();
            let text=recognize_image(&image,&engine).unwrap();
            assert!(text.contains("数组"),"Chinese question missing: {text}");
            assert!(text.contains("target"),"English code missing: {text}");
            assert!(text.lines().count()>=4,"Question layout lost: {text}");
        }
    }
}

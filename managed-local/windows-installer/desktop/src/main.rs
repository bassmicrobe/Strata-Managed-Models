#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, fs, io::Write, path::PathBuf, process::Command, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use std::os::windows::{ffi::OsStrExt, process::CommandExt};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, menu::{Menu, MenuItem, Submenu}, webview::{NewWindowResponse, PageLoadEvent}};
use tauri_plugin_clipboard_manager::ClipboardExt;
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::{MessageBoxW, IDYES, MB_OK, MB_YESNO, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONINFORMATION, SW_SHOWNORMAL}};

const TITLE: &str = "Strata Managed Models";
const CREATE_NO_WINDOW: u32 = 0x08000000;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode { View, Smoke, Close, Refresh }

#[derive(Debug)]
struct Options {
    mode: Mode,
    data: PathBuf,
    url: Option<Url>,
    shared: Option<Url>,
    managed: bool,
    update: Option<(String, String)>,
}

fn loopback(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

fn tailnet(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|host| host.ends_with(".ts.net") && host.len() > 7)
}

fn parse_url(value: &str, shared: bool, managed: bool) -> Result<Url> {
    let url = Url::parse(value)?;
    let allowed = if shared { tailnet(&url) && url.fragment().is_none() } else { loopback(&url) || !managed && tailnet(&url) };
    if !allowed || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.path() != "/" || url.port() == Some(0) {
        return Err("Strata の接続先が正しくありません。".into());
    }
    Ok(url)
}

fn valid_tag(value: &str) -> bool {
    let Some((version, build)) = value.strip_prefix("managed-v").and_then(|s| s.rsplit_once('-')) else { return false; };
    value.len() < 64 && version.split('.').count() == 3 && version.split('.').all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        && build.bytes().all(|b| b.is_ascii_digit()) && build.parse::<u64>().is_ok_and(|n| n > 0)
}

fn options(args: impl IntoIterator<Item=String>) -> Result<Options> {
    let (mut mode, mut data, mut url, mut shared, mut managed) = (Mode::View, None, None, None, false);
    let (mut installed, mut available) = (None, None);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data = Some(PathBuf::from(args.next().ok_or("データフォルダーがありません。")?)),
            "--url" => url = Some(args.next().ok_or("接続先がありません。")?),
            "--share-url" => shared = Some(args.next().ok_or("共有 URL がありません。")?),
            "--installed-release" => installed = args.next(),
            "--available-release" => available = args.next(),
            "--managed" => managed = true,
            "--smoke" if mode == Mode::View => mode = Mode::Smoke,
            "--exit-window" if mode == Mode::View => mode = Mode::Close,
            "--refresh-window" if mode == Mode::View => mode = Mode::Refresh,
            _ => return Err("デスクトップ起動オプションが正しくありません。".into()),
        }
    }
    let data = data.filter(|path| path.is_absolute() && path.parent().is_some()).ok_or("データフォルダーが正しくありません。")?;
    let url = url.as_deref().map(|value| parse_url(value, false, managed)).transpose()?;
    let shared = shared.as_deref().map(|value| parse_url(value, true, managed)).transpose()?;
    if matches!(mode, Mode::View | Mode::Smoke) && url.is_none() { return Err("Strata の接続先がありません。".into()); }
    let update = installed.zip(available).filter(|(old, new)| managed && old != new && valid_tag(old) && valid_tag(new));
    Ok(Options { mode, data, url, shared, managed, update })
}

fn wide(value: &str) -> Vec<u16> { std::ffi::OsStr::new(value).encode_wide().chain(Some(0)).collect() }
fn message(value: &str, error: bool) {
    let text = wide(value); let title = wide(TITLE);
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | if error { MB_ICONERROR } else { MB_ICONINFORMATION }); }
}
fn open_external(url: &Url) {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() { return; }
    let operation = wide("open"); let address = wide(url.as_str());
    unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), address.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL); }
}

struct State {
    data: PathBuf,
    launcher: Option<PathBuf>,
    url: Mutex<Option<Url>>,
    shared: Mutex<Option<Url>>,
    busy: AtomicBool,
    mode: Mode,
    last_prompted: Mutex<Option<String>>,
}

fn same_origin(a: &Url, b: &Url) -> bool { a.origin() == b.origin() }
fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
    }
}
fn navigate(app: &AppHandle, url: Url) {
    let state = app.state::<State>();
    if let Ok(mut current) = state.url.lock() { *current = Some(url.clone()); }
    if let Some(window) = app.get_webview_window("main") {
        if window.url().ok().as_ref() != Some(&url) { let _ = window.navigate(url); }
    }
}

fn open_window(app: &AppHandle, url: Url, smoke: bool) -> Result<()> {
    let data = app.state::<State>().data.clone();
    let navigation_app = app.clone();
    let smoke_url = url.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(TITLE).inner_size(1320.0, 860.0).min_inner_size(860.0, 580.0)
        .visible(!smoke).devtools(false).disable_drag_drop_handler()
        .data_directory(data.join(if smoke { "webview-smoke" } else { "webview" }))
        .on_navigation(move |target| {
            let allowed = navigation_app.state::<State>().url.lock().ok().and_then(|u| u.as_ref().map(|origin| same_origin(origin, target))).unwrap_or(false);
            if !allowed && !smoke { open_external(target); }
            allowed
        })
        .on_new_window(move |target, _| { if !smoke { open_external(&target); } NewWindowResponse::Deny })
        .on_page_load(move |window, payload| {
            if smoke && matches!(payload.event(), PageLoadEvent::Finished) && same_origin(payload.url(), &smoke_url) {
                let result = serde_json::json!({"ok":true,"windowCreated":true,"pageLoaded":true,"renderer":"WebView2","loopback":loopback(payload.url())});
                let ok = fs::write(data.join("desktop-smoke.json"), result.to_string()).is_ok();
                window.app_handle().exit(if ok { 0 } else { 1 });
            }
        })
        .build()?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeResult {
    cancelled: Option<bool>,
    local_url: Option<String>,
    tailscale_url: Option<String>,
    update_status: Option<String>,
    release_tag: Option<String>,
    installed_release_tag: Option<String>,
    latest_installer_tag: Option<String>,
}

fn prompt_update(app: &AppHandle, update: Option<(String, String)>, force: bool) -> bool {
    let Some((installed, available)) = update.filter(|(old, new)| old != new && valid_tag(old) && valid_tag(new)) else { return false; };
    let state = app.state::<State>();
    if state.mode != Mode::View || state.launcher.is_none() { return false; }
    if let Ok(mut last) = state.last_prompted.lock() {
        if !force && last.as_ref() == Some(&available) { return false; }
        *last = Some(available.clone());
    }
    let owner = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as _).unwrap_or(std::ptr::null_mut());
    let body = wide(&format!("新しい Windows 版があります。\n\nインストール済み: {installed}\n新しい版: {available}\n\n今すぐ更新しますか？\n「はい」で更新用インストーラーを取得し、セットアップを開きます。\n「いいえ」を選ぶと今の版を使い続けられます。\n設定・会話・モデルは引き継がれます。"));
    let title = wide("Strata の更新");
    if unsafe { MessageBoxW(owner, body.as_ptr(), title.as_ptr(), MB_YESNO | MB_DEFBUTTON2 | MB_ICONINFORMATION) } == IDYES {
        helper(app, "download", &["--download-update"]);
    }
    true
}

fn helper(app: &AppHandle, action: &'static str, args: &'static [&'static str]) {
    let state = app.state::<State>();
    let Some(launcher) = state.launcher.clone() else { return; };
    if state.busy.swap(true, Ordering::AcqRel) { message("Strata は起動または更新を処理中です。", false); return; }
    let data = state.data.clone(); let app = app.clone();
    std::thread::spawn(move || {
        let result = Command::new(launcher).args(args).arg("--desktop-bridge")
            .env("STRATA_MANAGED_DATA_DIR", data).creation_flags(CREATE_NO_WINDOW).output()
            .map_err(|e| e.to_string()).and_then(|output| {
                if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
                let value = String::from_utf8_lossy(&output.stdout);
                let line = value.lines().rev().find(|line| !line.trim().is_empty()).ok_or("Strata の応答を確認できません。")?;
                serde_json::from_str::<RuntimeResult>(line).map_err(|e| e.to_string())
            });
        let ui = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = ui.state::<State>(); state.busy.store(false, Ordering::Release);
            match result {
                Ok(value) if value.cancelled == Some(true) => {},
                Ok(_) if action == "quit" => ui.exit(0),
                Ok(_) if action == "download" => {},
                Ok(value) => {
                    if let Ok(mut shared) = state.shared.lock() { *shared = value.tailscale_url.as_deref().and_then(|url| parse_url(url, true, true).ok()); }
                    if let Some(url) = value.local_url.as_deref().and_then(|url| parse_url(url, false, true).ok()) { navigate(&ui, url); }
                    match action {
                        "share" => message("Tailscale共有を開始しました。メニューの「共有URLをコピー」を選ぶと接続先をコピーできます。", false),
                        "unshare" => message("Tailscale 共有を停止しました。", false),
                        "update" => {
                            if prompt_update(&ui, value.installed_release_tag.zip(value.latest_installer_tag), true) { return; }
                            let release = value.release_tag.as_deref().unwrap_or("不明");
                            let detail = match value.update_status.as_deref() { Some("applied") => "検証済みの更新を反映しました。", Some("deferred") => "処理中のため、更新は次回に回します。", Some("deferred-installer") => "この更新には新しい Windows インストーラーが必要です。", Some("rollback" | "unavailable") => "更新を反映できませんでした。保存済みの版を使います。", _ => "現在の Windows 版は最新です。" };
                            message(&format!("{detail}\n現在の配布版: {release}"), false);
                        }
                        _ => {}
                    }
                }
                Err(detail) => message(if detail.is_empty() { "Strata の操作を完了できませんでした。" } else { &detail }, true),
            }
        });
    });
}

fn menu(app: &AppHandle, managed: bool) -> Result<()> {
    let submenu = Submenu::new(app, "Strata", true)?;
    for (id, label, enabled) in [
        ("chat", "チャット", true), ("models", "モデル", true), ("api", "API接続", true),
        ("coding", "自動テストでコーディング", managed),
        ("share", "Tailscaleで共有", managed), ("copy", "共有URLをコピー", true),
        ("unshare", "Tailscale共有を停止", managed), ("update", "更新を確認", managed),
        ("quit", if managed { "Strataを終了" } else { "ウィンドウを閉じる" }, true),
    ] { submenu.append(&MenuItem::with_id(app, id, label, enabled, None::<&str>)?)?; }
    app.set_menu(Menu::with_items(app, &[&submenu])?)?;
    Ok(())
}

fn menu_action(app: &AppHandle, action: &str) {
    let state = app.state::<State>();
    match action {
        "chat" | "models" | "api" => {
            let target = state.url.lock().ok().and_then(|u| u.clone());
            if let Some(mut url) = target {
                url.set_fragment(Some(match action { "models" => "/models", "api" => "/settings?section=Models", _ => "/chat" }));
                navigate(app, url);
            }
        }
        "copy" => {
            let url = state.shared.lock().ok().and_then(|u| u.clone());
            if let Some(url) = url { match app.clipboard().write_text(url.as_str()) { Ok(()) => message("共有 URL をコピーしました。", false), Err(e) => message(&e.to_string(), true) } }
            else { message("Tailscale 共有は有効になっていません。", false); }
        }
        "share" => helper(app, "share", &["--tailscale"]),
        "coding" => helper(app, "coding", &["--coding"]),
        "unshare" => helper(app, "unshare", &["--tailscale-off"]),
        "update" => helper(app, "update", &[]),
        "quit" if state.launcher.is_some() => helper(app, "quit", &["--stop", "--wait"]),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn run(config: Options) -> Result<()> {
    fs::create_dir_all(&config.data)?;
    let data_identity = fs::canonicalize(&config.data)?;
    let exe = env::current_exe()?;
    let launcher = if config.managed { Some(exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).ok_or("Strata のインストール先が見つかりません。")?.join("StrataManaged.exe")) } else { None };
    let record = config.data.join("desktop-process.json");
    let record_setup = record.clone();
    let mut context = tauri::generate_context!();
    let key = format!("{}|{}|{}|{}", exe.to_string_lossy().to_uppercase(), data_identity.to_string_lossy().to_uppercase(), config.managed, config.mode == Mode::Smoke);
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    context.config_mut().identifier = format!("com.strata.managed-window.instance{}", &digest[..20]);
    let mode = config.mode;
    let state = State { data:config.data, launcher, url:Mutex::new(config.url.clone()), shared:Mutex::new(config.shared), busy:AtomicBool::new(false), mode, last_prompted:Mutex::new(None) };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            let Ok(request) = options(args.into_iter().skip(1)) else { return; };
            let state = app.state::<State>();
            if fs::canonicalize(&request.data).ok() != fs::canonicalize(&state.data).ok() || request.managed != state.launcher.is_some() || state.mode == Mode::Smoke { return; }
            if request.mode == Mode::Close { app.exit(0); return; }
            if let Ok(mut shared) = state.shared.lock() { *shared = request.shared; }
            if let Some(url) = request.url { navigate(app, url); }
            if request.mode != Mode::Refresh { focus(app); prompt_update(app,request.update,false); }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .setup(move |app| {
            if matches!(mode, Mode::Close | Mode::Refresh) { app.handle().exit(0); return Ok(()); }
            let smoke = mode == Mode::Smoke;
            if !smoke { menu(app.handle(), config.managed)?; }
            open_window(app.handle(), config.url.ok_or("Strata の接続先がありません。")?, smoke)?;
            if !smoke {
                fs::write(&record_setup, serde_json::json!({"pid":std::process::id()}).to_string())?;
                let handle=app.handle().clone(); let callback=handle.clone();
                handle.run_on_main_thread(move || { prompt_update(&callback,config.update,false); })?;
            }
            else { let app = app.handle().clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(45)); app.exit(1); }); }
            Ok(())
        })
        .on_menu_event(|app, event| menu_action(app, event.id().as_ref()))
        .build(context)?;
    app.run(move |_, event| {
        if mode == Mode::View && matches!(event, tauri::RunEvent::Exit) {
            let own = fs::read_to_string(&record).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).and_then(|v| v["pid"].as_u64()) == Some(std::process::id() as u64);
            if own { let _ = fs::remove_file(&record); }
        }
    });
    Ok(())
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let quiet = args.iter().any(|a| matches!(a.as_str(), "--smoke" | "--exit-window" | "--refresh-window"));
    for name in ["GITHUB_TOKEN", "GH_TOKEN", "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", "WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER"] { env::remove_var(name); }
    let parsed = options(args);
    let logs = parsed.as_ref().ok().map(|opts| opts.data.join("logs"));
    if let Err(error) = parsed.and_then(run) {
        if let Some(logs) = logs {
            if fs::create_dir_all(&logs).is_ok() {
                if let Ok(mut log) = fs::OpenOptions::new().create(true).append(true).open(logs.join("desktop-window.log")) { let _ = writeln!(log, "{error}"); }
            }
        }
        if !quiet { message(&format!("Strata のウィンドウを開けませんでした。\n\n{error}"), true); }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_local_or_explicit_private_window_origins() {
        assert!(parse_url("http://127.0.0.1:8792/#/settings?section=Models", false, true).is_ok());
        assert!(parse_url("https://device.example.ts.net:8443/", false, false).is_ok());
        assert!(parse_url("https://device.example.ts.net/", true, true).is_ok());
        for value in ["https://device.example.ts.net/", "http://192.0.2.1/", "https://unrelated.example/", "file:///C:/test", "http://a@127.0.0.1/", "http://127.0.0.1/?secret=x"] { assert!(parse_url(value, false, true).is_err(), "{value}"); }
    }
    #[test]
    fn update_prompts_use_fork_release_tags() {
        assert!(valid_tag("managed-v0.2.12-15"));
        assert!(!valid_tag("v0.2.12"));
        assert!(!valid_tag("managed-v0.2.12-0"));
        assert!(!valid_tag("managed-v0.2.12-15\n"));
    }
}

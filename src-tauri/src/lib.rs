mod core;
mod flow_model;
mod flows;
mod jev;
mod jev_model;
mod jev_runner;
#[cfg(test)]
mod jev_tests;
mod model;
mod store;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Html,
    routing::{get, post},
    Json, Router,
};
use core::Core;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Adding page webviews makes this a multi-webview Window. It is no longer
    // returned by get_webview_window, so reopening must use the native Window.
    if let Some(window) = app.get_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

#[tauri::command]
async fn tool_call(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    name: String,
    args: Value,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("只有本地管理界面可以调用应用命令".into());
    }
    // A page opened by the local UI is an explicit window interaction. Agent
    // calls enter through the HTTP dispatcher and keep their background behavior.
    if matches!(name.as_str(), "browser_open" | "browser_focus") {
        show_main_window(&app).map_err(|e| e.to_string())?;
    }
    if ["flow_archive", "flow_create_archived"].contains(&name.as_str()) {
        return Err("归档由用户自己的外部 Agent 通过 MCP/CLI 提交，界面不直接归档".into());
    }
    core::dispatch(&app, &name, args).await
}
#[tauri::command]
async fn jev_settings(app: tauri::AppHandle, webview: tauri::Webview) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("只有本地管理界面可管理 Jev 配置".into());
    }
    jev::settings_get(&app).await
}
#[tauri::command]
async fn jev_save_settings(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    settings: jev_model::Settings,
    api_key: Option<String>,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("只有本地管理界面可管理 Jev 配置".into());
    }
    jev::settings_save(&app, settings, api_key).await
}
#[tauri::command]
async fn jev_remove_credential(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    provider: String,
) -> Result<Value, String> {
    if webview.label() != "main" {
        return Err("只有本地管理界面可管理 Jev 配置".into());
    }
    jev::credential_remove(&app, provider).await
}
#[tauri::command]
fn workspace_layout(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    visible: bool,
    bounds: Option<[f64; 4]>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("禁止网页调用布局命令".into());
    }
    core::show_workspace(&app, visible, bounds)
}
#[tauri::command]
fn page_message(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    message: Value,
) -> Result<Value, String> {
    let session_id = webview
        .label()
        .strip_prefix("page-")
        .ok_or("仅网页会话可上报记录")?;
    if message["kind"].as_str() == Some("page_rendered") {
        return core::page_rendered(&app, session_id, message["url"].as_str().unwrap_or(""));
    }
    flows::page_message(&app, session_id, message)
}
#[tauri::command]
async fn export_flow_file(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    flow_id: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if webview.label() != "main" {
        return Err("只有管理界面可导出文件".into());
    }
    let package = flows::dispatch(&app, "flow_export", json!({"flowId":flow_id})).await?;
    let bytes = serde_json::to_vec_pretty(&package).map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出流程工作包")
        .set_file_name("workflow.flow.json")
        .add_filter("Flow 工作包", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let path = rx.await.map_err(|e| e.to_string())?;
    if let Some(path) = path {
        let path = path.into_path().map_err(|e| e.to_string())?;
        store::atomic_write(&path, &bytes)?;
        return Ok(Some(path.to_string_lossy().into()));
    }
    Ok(None)
}
fn authorized(app: &tauri::AppHandle, headers: &HeaderMap) -> bool {
    let expected = format!("Bearer {}", app.state::<Core>().token);
    headers.get("authorization").and_then(|h| h.to_str().ok()) == Some(expected.as_str())
        && !headers.contains_key("origin")
}
async fn http_tools(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&app, &headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Json(core::tools()))
}
async fn http_call(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&app, &headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let result = core::dispatch(
        &app,
        request["name"].as_str().unwrap_or(""),
        request.get("arguments").cloned().unwrap_or(json!({})),
    )
    .await;
    Ok(Json(match result {
        Ok(v) => json!({"ok":true,"result":v}),
        Err(e) => json!({"ok":false,"error":e}),
    }))
}
fn pause_all(app: &tauri::AppHandle) {
    let core = app.state::<Core>();
    let mut db = core.db.lock().unwrap();
    for r in &mut db.runs {
        if r.status == "running" {
            r.status = "paused".into();
        }
    }
    if let Err(e) = core.persist(&db) {
        eprintln!("暂停记录保存失败：{e}");
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            tool_call,
            workspace_layout,
            page_message,
            export_flow_file,
            jev_settings,
            jev_save_settings,
            jev_remove_credential
        ])
        .setup(|app| {
            let path = app.path().app_data_dir()?;
            std::fs::create_dir_all(&path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
            let db_path = path.join("store.json");
            let first_launch = !db_path.exists();
            let mut db = store::load(&db_path).map_err(std::io::Error::other)?;
            for task in &mut db.delegate_tasks {
                if task.active() {
                    task.finish(
                        "interrupted",
                        Some("应用退出，委派中断；请重新观察网页后继续".into()),
                    );
                }
            }
            for r in &mut db.recordings {
                if r.capture_state == "recording" {
                    r.capture_state = "interrupted".into();
                    r.ended_at = Some(model::now());
                    r.limitations.push("应用退出，录制中断".into());
                }
            }
            for r in &mut db.script_runs {
                if r.finished_at.is_none() && ["running", "uncertain"].contains(&r.status.as_str())
                {
                    r.status = "interrupted".into();
                    r.finished_at = Some(model::now());
                    r.error = Some("应用退出，执行结果需核查".into());
                }
            }
            for r in &mut db.runs {
                if ["running", "paused", "stopping"].contains(&r.status.as_str()) {
                    r.status = "interrupted".into();
                    r.error = Some("应用退出后任务中断。核查网页结果，再决定是否重新运行。".into());
                    r.finished_at = Some(model::now());
                }
            }
            if first_launch {
                db.guides.push(serde_json::from_str(include_str!(
                    "../../examples/customer-guide.json"
                ))?);
                db.workflows.push(serde_json::from_str(include_str!(
                    "../../examples/demo-workflow.json"
                ))?);
            }
            store::save(&db_path, &db).map_err(std::io::Error::other)?;
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            let endpoint = format!("http://{}", listener.local_addr()?);
            let token = format!("{}{}", model::id(), model::id());
            store::atomic_write(
                &path.join("agent.json"),
                &serde_json::to_vec(
                    &json!({"endpoint":endpoint,"token":token,"pid":std::process::id()}),
                )?,
            )
            .map_err(std::io::Error::other)?;
            app.manage(Core {
                db: Mutex::new(db),
                sessions: Mutex::new(HashMap::new()),
                gates: Mutex::new(HashMap::new()),
                active: Mutex::new(None),
                workspace: Mutex::new(core::WorkspaceLayout {
                    visible: true,
                    bounds: [228., 172., 800., 650.],
                }),
                native_top_inset: Mutex::new(0.0),
                path: db_path,
                endpoint,
                token,
                pending_scripts: Mutex::new(HashMap::new()),
            });
            app.manage(
                jev::JevState::new(path.clone(), &app.config().identifier)
                    .map_err(std::io::Error::other)?,
            );
            core::update_native_inset(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let router = Router::new()
                    .route("/tools", get(http_tools))
                    .route("/call", post(http_call))
                    .route("/demo", get(|| async { Html(include_str!("demo.html")) }))
                    .layer(axum::extract::DefaultBodyLimit::max(20_000_000))
                    .with_state(handle);
                if let Err(e) =
                    axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), router).await
                {
                    eprintln!("本地接入服务失败：{e}");
                }
            });
            let show = MenuItem::with_id(app, "show", "打开 Auto Browser", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Auto Browser")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        let _ = show_main_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let address = MenuItem::with_id(
                app,
                "focus-address",
                "前往地址栏",
                true,
                Some("CmdOrCtrl+L"),
            )?;
            let application_menu = Menu::default(app.handle())?;
            application_menu.append(&Submenu::with_items(app, "网页", true, &[&address])?)?;
            app.set_menu(application_menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "focus-address" {
                let _ = show_main_window(app);
                if let Some(main) = app.get_webview("main") {
                    let _ = main.set_focus();
                    let _ = app.emit_to("main", "focus-address", ());
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                core::update_native_inset(window.app_handle());
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    pause_all(window.app_handle());
                    jev::stop_all(window.app_handle());
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 Auto Browser")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = show_main_window(app);
            }
            if let tauri::RunEvent::Exit = event {
                jev::stop_all(app);
                pause_all(app);
                if let Ok(path) = app.path().app_data_dir() {
                    let _ = std::fs::remove_file(path.join("agent.json"));
                }
            }
        });
}

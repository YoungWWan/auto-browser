use crate::{model::*, store};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

pub struct Core {
    pub db: Mutex<Database>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub gates: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pub active: Mutex<Option<String>>,
    pub workspace: Mutex<WorkspaceLayout>,
    pub native_top_inset: Mutex<f64>,
    pub path: PathBuf,
    pub endpoint: String,
    pub token: String,
    pub pending_scripts: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<Value>)>>,
}
pub struct WorkspaceLayout {
    pub visible: bool,
    pub bounds: [f64; 4],
}
impl Core {
    pub fn persist(&self, db: &Database) -> Result<(), String> {
        store::save(&self.path, db)
    }
    pub fn gate(&self, id: &str) -> Arc<AsyncMutex<()>> {
        self.gates
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .clone()
    }
}
fn s<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数：{key}"))
}
pub fn view(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&format!("page-{id}"))
        .ok_or_else(|| "目标网页已关闭".into())
}
pub fn changed(app: &AppHandle) {
    let _ = app.emit_to("main", "state-changed", ());
}

fn skill_path(app: &AppHandle) -> PathBuf {
    let bundled = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("skills/auto-browser/SKILL.md");
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent-skills/auto-browser/SKILL.md")
    }
}

pub fn normalize_url(app: &AppHandle, raw: &str) -> Result<tauri::Url, String> {
    let input = if raw == "auto-browser://demo" {
        format!("{}/demo", app.state::<Core>().endpoint)
    } else if !raw.contains("://") {
        format!("https://{raw}")
    } else {
        raw.to_string()
    };
    let url = tauri::Url::parse(&input).map_err(|_| "请输入有效网址")?;
    if !["https", "http"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅允许没有嵌入凭据的 HTTP/HTTPS 网址".into());
    }
    Ok(url)
}

pub async fn evaluate(app: &AppHandle, id: &str, request: &Value) -> Result<Value, String> {
    let js = format!(
        "({})({})",
        include_str!("bridge.js"),
        serde_json::to_string(request).map_err(|e| e.to_string())?
    );
    evaluate_js(app, id, js).await
}
pub async fn evaluate_js(app: &AppHandle, id: &str, js: String) -> Result<Value, String> {
    let webview = view(app, id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(tx));
    webview
        .eval_with_callback(js, move |result| {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(std::time::Duration::from_secs(12), rx)
        .await
        .map_err(|_| "网页响应超时，请检查加载状态")?
        .map_err(|_| "网页执行回调已中断")?;
    let first: Value = serde_json::from_str(&raw).map_err(|_| {
        format!(
            "无法读取网页结果：{}",
            raw.chars().take(120).collect::<String>()
        )
    })?;
    let result = if let Some(encoded) = first.as_str() {
        serde_json::from_str(encoded).map_err(|e| e.to_string())?
    } else {
        first
    };
    if result.get("ok") != Some(&json!(true)) {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("网页操作失败")
            .into());
    }
    Ok(result)
}

pub async fn perform(app: &AppHandle, id: &str, step: &Step) -> Result<Value, String> {
    validate_step(step)?;
    if step.kind == "wait" {
        let ms = step
            .value
            .as_ref()
            .and_then(Value::as_u64)
            .filter(|m| *m <= 10000)
            .ok_or("等待时间需要 0–10000 毫秒整数")?;
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        return Ok(json!({"ok":true,"kind":"wait","verified":false}));
    }
    let v = view(app, id)?;
    let _ = v.eval("window.__AUTO_BROWSER_RECORDER__?.setActor('agent')");
    let result = evaluate(app, id, &serde_json::to_value(step).unwrap()).await;
    let _ = v.eval("window.__AUTO_BROWSER_RECORDER__?.setActor('user')");
    result
}

// Called only during setup or native window events on the main thread.
pub fn update_native_inset(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let (Some(core), Some(window)) = (app.try_state::<Core>(), app.get_window("main")) {
        if let Ok(ptr) = window.ns_window() {
            // Public AppKit APIs account for full-size content views and
            // fullscreen, where Tauri outer/inner geometry can be equal.
            let ns_window = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
            let inset = ns_window.frame().size.height - ns_window.contentLayoutRect().size.height;
            *core.native_top_inset.lock().unwrap() = inset.max(0.0);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

fn native_bounds(app: &AppHandle, mut bounds: [f64; 4]) -> [f64; 4] {
    bounds[1] += *app.state::<Core>().native_top_inset.lock().unwrap();
    bounds
}

pub fn show_workspace(
    app: &AppHandle,
    visible: bool,
    bounds: Option<[f64; 4]>,
) -> Result<(), String> {
    let core = app.state::<Core>();
    if let Some(b) = bounds {
        if b.iter().any(|n| !n.is_finite()) || b[2] < 1. || b[3] < 1. {
            return Err("网页区域大小无效".into());
        }
    }
    {
        let mut workspace = core.workspace.lock().unwrap();
        workspace.visible = visible;
        if let Some(b) = bounds {
            workspace.bounds = b;
        }
    }
    sync_workspace(app)
}

fn sync_workspace(app: &AppHandle) -> Result<(), String> {
    let layout_app = app.clone();
    // Worker-thread WebView operations are queued, but UI-thread operations are
    // immediate. Queue a reconciliation rather than stale show/hide calls, then
    // read the latest desired layout on the native thread when it actually runs.
    app.run_on_main_thread(move || {
        if let Err(error) = apply_workspace(&layout_app) {
            let _ = layout_app.emit_to("main", "workspace-layout-error", error);
        }
    })
    .map_err(|e| e.to_string())
}

fn apply_workspace(app: &AppHandle) -> Result<(), String> {
    let core = app.state::<Core>();
    let (visible, bounds) = {
        let workspace = core.workspace.lock().unwrap();
        (workspace.visible, workspace.bounds)
    };
    let b = native_bounds(app, bounds);
    let active = core.active.lock().unwrap().clone();
    let sessions: Vec<_> = core.sessions.lock().unwrap().keys().cloned().collect();
    for id in sessions {
        if let Ok(v) = view(app, &id) {
            if visible && active.as_deref() == Some(&id) {
                v.show().map_err(|e| e.to_string())?;
                // Apply position and size together: macOS child view coordinate
                // readback can differ from the layout coordinates in set_size.
                // Unhide before setting the frame so a newly attached child
                // participates in its parent's layout when bounds are applied.
                v.set_bounds(tauri::Rect {
                    position: tauri::LogicalPosition::new(b[0], b[1]).into(),
                    size: tauri::LogicalSize::new(b[2], b[3]).into(),
                })
                .map_err(|e| e.to_string())?;
            } else {
                v.hide().map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

pub async fn open(app: &AppHandle, raw: &str, domain_id: Option<String>) -> Result<Value, String> {
    let url = normalize_url(app, raw)?;
    let id = id();
    let session = Session {
        id: id.clone(),
        title: url.host_str().unwrap_or("网页").into(),
        url: url.to_string(),
        status: "loading".into(),
        created_at: now(),
        domain_id,
    };
    let core = app.state::<Core>();
    core.sessions
        .lock()
        .unwrap()
        .insert(id.clone(), session.clone());
    let b = native_bounds(app, core.workspace.lock().unwrap().bounds);
    let nav_app = app.clone();
    let nav_id = id.clone();
    let load_app = app.clone();
    let load_id = id.clone();
    let title_app = app.clone();
    let title_id = id.clone();
    let builder =
        tauri::webview::WebviewBuilder::new(format!("page-{id}"), tauri::WebviewUrl::External(url))
            .initialization_script(include_str!("recorder.js"))
            .on_navigation(move |url| {
                if !["http", "https", "about"].contains(&url.scheme()) {
                    return false;
                }
                if !crate::jev::navigation_allowed(&nav_app, &nav_id, url.as_str()) {
                    return false;
                }
                // This policy also receives subframe navigation. Only main-document
                // load and renderer callbacks may update the displayed page state.
                true
            })
            .on_page_load(move |_webview, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    crate::flows::navigation(&load_app, &load_id, payload.url().as_str());
                }
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    if let Some(session) = load_app
                        .state::<Core>()
                        .sessions
                        .lock()
                        .unwrap()
                        .get_mut(&load_id)
                    {
                        session.url = payload.url().to_string();
                        session.status = "loading".into();
                    }
                }
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    let _ = sync_workspace(&load_app);
                }
                changed(&load_app);
            })
            .on_document_title_changed(move |_v, title| {
                if let Some(session) = title_app
                    .state::<Core>()
                    .sessions
                    .lock()
                    .unwrap()
                    .get_mut(&title_id)
                {
                    session.title = title;
                }
                changed(&title_app);
            });
    let window = app.get_window("main").ok_or("管理窗口不可用")?;
    if let Err(e) = window.add_child(
        builder,
        tauri::LogicalPosition::new(b[0], b[1]),
        tauri::LogicalSize::new(b[2], b[3]),
    ) {
        core.sessions.lock().unwrap().remove(&id);
        return Err(e.to_string());
    }
    *core.active.lock().unwrap() = Some(id.clone());
    sync_workspace(app)?;
    changed(app);
    Ok(serde_json::to_value(session).unwrap())
}

pub fn page_rendered(app: &AppHandle, session_id: &str, url: &str) -> Result<Value, String> {
    let actual_url = view(app, session_id)?
        .url()
        .map_err(|e| e.to_string())?
        .to_string();
    let core = app.state::<Core>();
    let updated = {
        let mut sessions = core.sessions.lock().unwrap();
        let session = sessions.get_mut(session_id).ok_or("网页已关闭")?;
        reconcile_rendered(session, url, &actual_url)
    };
    if updated {
        changed(app);
    }
    Ok(json!({"ok":true}))
}

fn reconcile_rendered(session: &mut Session, reported_url: &str, actual_url: &str) -> bool {
    // Native load callbacks can omit History API and back/forward fragment changes.
    // Check the actual WebView URL so a late frame from another document cannot win.
    if reported_url != actual_url {
        return false;
    }
    let updated = session.url != actual_url || session.status != "ready";
    session.url = actual_url.into();
    session.status = "ready".into();
    updated
}

#[cfg(test)]
mod page_readiness_tests {
    use super::*;

    fn session(url: &str, status: &str) -> Session {
        Session {
            id: "page".into(),
            title: "Practice".into(),
            url: url.into(),
            status: status.into(),
            created_at: String::new(),
            domain_id: None,
        }
    }

    #[test]
    fn fragment_back_navigation_updates_the_address_without_a_load_callback() {
        let mut page = session("https://example.test/page#next", "ready");
        let actual = "https://example.test/page";
        assert!(reconcile_rendered(&mut page, actual, actual));
        assert_eq!(page.url, actual);
        assert_eq!(page.status, "ready");
        assert!(!reconcile_rendered(&mut page, actual, actual));
    }

    #[test]
    fn an_old_documents_frame_cannot_complete_a_new_navigation() {
        let actual = "https://example.test/new";
        let mut page = session(actual, "loading");
        assert!(!reconcile_rendered(
            &mut page,
            "https://example.test/old",
            actual
        ));
        assert_eq!(page.status, "loading");
        assert_eq!(page.url, actual);
        assert!(reconcile_rendered(&mut page, actual, actual));
        assert_eq!(page.status, "ready");
    }
}

pub fn tools() -> Value {
    let target = json!({"type":"object","properties":{"selector":{"type":"string"},"label":{"type":"string"},"text":{"type":"string"}},"additionalProperties":false});
    let step = json!({"type":"object","properties":{"kind":{"type":"string","enum":["click","fill","select","check","press","scroll","wait","assert_text","assert_url","assert_value","assert_visible"]},"target":target,"value":{},"description":{"type":"string"}},"required":["kind"],"additionalProperties":false});
    let definitions = vec![
        ("app_status", "查询应用、能力和接入状态", json!({})),
        (
            "browser_open",
            "在应用内打开 HTTP/HTTPS 网页；auto-browser://demo 打开练习页面",
            json!({"url":{"type":"string"},"domainId":{"type":"string"}}),
        ),
        ("browser_list", "列出应用内网页及稳定会话 ID", json!({})),
        (
            "browser_focus",
            "选择应用内网页",
            json!({"sessionId":{"type":"string"}}),
        ),
        (
            "browser_close",
            "关闭应用内网页（运行任务时拒绝关闭）",
            json!({"sessionId":{"type":"string"}}),
        ),
        (
            "browser_navigate",
            "网页导航、前进、后退或刷新",
            json!({"sessionId":{"type":"string"},"url":{"type":"string"},"direction":{"type":"string","enum":["back","forward","reload"]}}),
        ),
        (
            "browser_snapshot",
            "读取网页文本和可交互元素，包含定位信息",
            json!({"sessionId":{"type":"string"}}),
        ),
        (
            "browser_action",
            "执行 DOM 操作或断言；动作成功不代表业务完成。键盘事件为合成事件",
            json!({"sessionId":{"type":"string"},"action":step}),
        ),
        (
            "trace_get",
            "读取当前网页的可保存操作记录",
            json!({"sessionId":{"type":"string"}}),
        ),
        (
            "guide_list",
            "搜索 AI 操作指南的元信息（名称、网站、标签）；指南是上下文文档，交由 Agent 阅读和判断",
            json!({"query":{"type":"string"},"domain":{"type":"string"}}),
        ),
        (
            "guide_get",
            "读取指南的 Markdown 正文和输入说明。根据目标网页实时观察、决定下一步并验证结果；读取不执行网页动作",
            json!({"guideId":{"type":"string"}}),
        ),
        (
            "guide_save",
            "保存 AI 可读的操作指南，新建时 id 为空；正文 content 使用 Markdown，描述目标、前置条件、操作思路、完成判断与异常处理。保存生成新版本，不验证或执行页面",
            json!({"guide":{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"startUrl":{"type":"string"},"domain":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"parameters":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"label":{"type":"string"},"kind":{"type":"string","enum":["string","number","boolean"]},"required":{"type":"boolean"},"default":{}},"required":["name","label"]}},"content":{"type":"string"},"version":{"type":"integer"},"updatedAt":{"type":"string"}},"required":["id","name","startUrl","domain","content"],"additionalProperties":false}}),
        ),
        (
            "guide_delete",
            "删除一个 AI 操作指南及其保存的版本",
            json!({"guideId":{"type":"string"}}),
        ),
        (
            "workflow_list",
            "按关键词查找保留的自动化回放脚本；AI 操作指南请用 guide_list",
            json!({"query":{"type":"string"}}),
        ),
        (
            "workflow_get",
            "读取自动化回放脚本的固定动作与参数；AI 操作指南请用 guide_get",
            json!({"workflowId":{"type":"string"}}),
        ),
        (
            "workflow_save",
            "校验并保存自动化脚本草稿；修改形成新版本。参数引用格式 ${name}。AI 操作指南请用 guide_save",
            json!({"workflow":{"type":"object"}}),
        ),
        (
            "workflow_delete",
            "删除一个流程及其版本；历史任务保留定义",
            json!({"workflowId":{"type":"string"}}),
        ),
        (
            "workflow_run",
            "执行自动化脚本的固定动作，返回 runId；通过 run_get 查询结果。选定网页必须匹配域名。AI 操作指南由 Agent 自行判断执行，不使用此工具",
            json!({"workflowId":{"type":"string"},"sessionId":{"type":"string"},"inputs":{"type":"object"}}),
        ),
        ("run_list", "查询执行记录", json!({})),
        (
            "run_get",
            "查询任务进度、错误与断言结果",
            json!({"runId":{"type":"string"}}),
        ),
        (
            "run_control",
            "在步骤边界暂停、继续或停止任务",
            json!({"runId":{"type":"string"},"action":{"type":"string","enum":["pause","resume","stop"]}}),
        ),
    ];
    let mut list: Vec<Value>=definitions.into_iter().map(|(name,description,properties)| {
        let required: Vec<&str>=match name {
            "browser_open"=>vec!["url"], "browser_focus"|"browser_close"|"browser_snapshot"|"trace_get"=>vec!["sessionId"],
            "browser_navigate"=>vec!["sessionId"],"browser_action"=>vec!["sessionId","action"],
            "guide_get"|"guide_delete"=>vec!["guideId"],"guide_save"=>vec!["guide"],
            "workflow_get"|"workflow_delete"=>vec!["workflowId"],"workflow_save"=>vec!["workflow"],
            "workflow_run"=>vec!["workflowId","sessionId","inputs"],"run_get"=>vec!["runId"],"run_control"=>vec!["runId","action"],_=>vec![]};
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
    }).collect();
    list.extend(crate::flows::tools());
    list.extend(crate::jev::tools());
    json!({"tools":list})
}

pub async fn dispatch(app: &AppHandle, name: &str, args: Value) -> Result<Value, String> {
    if crate::jev::handles(name) {
        return crate::jev::dispatch(app, name, args).await;
    }
    if crate::flows::handles(name) {
        return crate::flows::dispatch(app, name, args).await;
    }
    let core = app.state::<Core>();
    match name {
        "app_status" => Ok(
            json!({"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"endpoint":core.endpoint,"dataPath":core.path.parent(),"connectionPath":core.path.with_file_name("agent.json"),"skillPath":skill_path(app),"agentBinary":std::env::current_exe().ok().and_then(|p|p.parent().map(|p|p.join(if cfg!(windows){"auto-browser-agent.exe"}else{"auto-browser-agent"}))),"capabilities":{"domains":true,"userRecording":true,"flowPackages":true,"webviewScripts":true,"jevDelegation":true,"domSnapshot":true,"domActions":true,"nativeInput":false,"screenshot":false,"fileUpload":false,"crossOriginFrames":false,"multiWebview":"tauri-unstable"},"sessionCount":core.sessions.lock().unwrap().len(),"activeSessionId":core.active.lock().unwrap().clone()}),
        ),
        "browser_open" => {
            let domain_id = args["domainId"].as_str().map(String::from);
            if let Some(did) = &domain_id {
                if !core.db.lock().unwrap().domains.iter().any(|d| &d.id == did) {
                    return Err("没有找到 业务空间".into());
                }
            }
            open(app, s(&args, "url")?, domain_id).await
        }
        "browser_list" => {
            let mut list: Vec<_> = core.sessions.lock().unwrap().values().cloned().collect();
            list.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            Ok(json!({"sessions":list,"activeSessionId":core.active.lock().unwrap().clone()}))
        }
        "browser_focus" => {
            let id = s(&args, "sessionId")?;
            view(app, id)?;
            *core.active.lock().unwrap() = Some(id.into());
            sync_workspace(app)?;
            changed(app);
            Ok(json!({"ok":true}))
        }
        "browser_close" => {
            let id = s(&args, "sessionId")?;
            let gate = core.gate(id);
            let guard = gate.try_lock();
            if guard.is_err()
                && !core
                    .pending_scripts
                    .lock()
                    .unwrap()
                    .values()
                    .any(|p| p.0 == id)
            {
                return Err("该网页有任务正在运行，请先停止任务".into());
            }
            crate::flows::navigation(app, id, "closed");
            crate::flows::interrupt_recording(app, id, "目标网页已关闭");
            view(app, id)?.close().map_err(|e| e.to_string())?;
            core.sessions.lock().unwrap().remove(id);
            if core.active.lock().unwrap().as_deref() == Some(id) {
                *core.active.lock().unwrap() = core.sessions.lock().unwrap().keys().next().cloned();
            }
            sync_workspace(app)?;
            changed(app);
            Ok(json!({"ok":true}))
        }
        "browser_navigate" => {
            let id = s(&args, "sessionId")?;
            let gate = core.gate(id);
            let guard = gate.try_lock();
            if guard.is_err()
                && !(args["direction"] == "reload"
                    && core
                        .pending_scripts
                        .lock()
                        .unwrap()
                        .values()
                        .any(|p| p.0 == id))
            {
                return Err("网页正在执行任务".into());
            }
            let v = view(app, id)?;
            if let Some(url) = args.get("url").and_then(Value::as_str) {
                v.navigate(normalize_url(app, url)?)
                    .map_err(|e| e.to_string())?;
            } else {
                match s(&args, "direction")? {
                    "back" => v.eval("history.back()"),
                    "forward" => v.eval("history.forward()"),
                    "reload" => v.reload(),
                    _ => return Err("无效导航方向".into()),
                }
                .map_err(|e| e.to_string())?;
            }
            Ok(json!({"ok":true,"verified":false}))
        }
        "browser_snapshot" => {
            let id = s(&args, "sessionId")?;
            let result = evaluate(app, id, &json!({"kind":"snapshot"})).await?;
            if let Some(session) = core.sessions.lock().unwrap().get_mut(id) {
                session.url = result["url"].as_str().unwrap_or(&session.url).into();
                session.title = result["title"].as_str().unwrap_or(&session.title).into();
            }
            Ok(result)
        }
        "browser_action" => {
            let id = s(&args, "sessionId")?;
            let gate = core.gate(id);
            let _guard = gate.try_lock().map_err(|_| "该网页已有任务占用")?;
            let step: Step =
                serde_json::from_value(args.get("action").cloned().ok_or("缺少 action")?)
                    .map_err(|e| e.to_string())?;
            let result = perform(app, id, &step).await?;
            if result.get("sensitive") != Some(&json!(true)) {
                let url = view(app, id)?.url().map_err(|e| e.to_string())?.to_string();
                let mut db = core.db.lock().unwrap();
                if let Some(trace) = db.traces.iter_mut().find(|t| t.session_id == id) {
                    if trace.steps.len() < 100 {
                        trace.steps.push(step);
                    }
                    trace.updated_at = now();
                } else {
                    db.traces.push(Trace {
                        session_id: id.into(),
                        url,
                        steps: vec![step],
                        updated_at: now(),
                    });
                }
                core.persist(&db)?;
            }
            changed(app);
            Ok(result)
        }
        "trace_get" => {
            let db = core.db.lock().unwrap();
            Ok(
                json!({"trace":db.traces.iter().find(|t|Some(t.session_id.as_str())==args["sessionId"].as_str())}),
            )
        }
        "guide_list" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let domain = args.get("domain").and_then(Value::as_str);
            let db = core.db.lock().unwrap();
            let mut latest: HashMap<String, &Guide> = HashMap::new();
            for g in &db.guides {
                if latest.get(&g.id).is_none_or(|v| v.version < g.version) {
                    latest.insert(g.id.clone(), g);
                }
            }
            let mut list: Vec<_> = latest
                .into_values()
                .filter(|g| {
                    domain.is_none_or(|d| g.domain.eq_ignore_ascii_case(d))
                        && format!(
                            "{} {} {} {}",
                            g.name,
                            g.description,
                            g.domain,
                            g.tags.join(" ")
                        )
                        .to_lowercase()
                        .contains(&query)
                })
                .collect();
            list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let metadata: Vec<Value> = list
                .into_iter()
                .map(|g| {
                    let mut value = serde_json::to_value(g).unwrap();
                    value.as_object_mut().unwrap().remove("content");
                    value
                })
                .collect();
            Ok(json!({"guides": metadata}))
        }
        "guide_get" => {
            let guide_id = s(&args, "guideId")?;
            let db = core.db.lock().unwrap();
            let g = db
                .guides
                .iter()
                .filter(|g| g.id == guide_id)
                .max_by_key(|g| g.version)
                .ok_or("没有找到指南")?;
            Ok(serde_json::to_value(g).unwrap())
        }
        "guide_save" => {
            let mut g: Guide =
                serde_json::from_value(args.get("guide").cloned().ok_or("缺少指南定义")?)
                    .map_err(|e| format!("指南格式错误：{e}"))?;
            validate_guide(&g)?;
            if g.id.is_empty() {
                g.id = id();
            }
            let mut db = core.db.lock().unwrap();
            g.version = db
                .guides
                .iter()
                .filter(|x| x.id == g.id)
                .map(|x| x.version)
                .max()
                .unwrap_or(0)
                + 1;
            g.updated_at = now();
            db.guides.push(g.clone());
            core.persist(&db)?;
            changed(app);
            Ok(serde_json::to_value(g).unwrap())
        }
        "guide_delete" => {
            let guide_id = s(&args, "guideId")?;
            let mut db = core.db.lock().unwrap();
            db.guides.retain(|g| g.id != guide_id);
            core.persist(&db)?;
            changed(app);
            Ok(json!({"ok":true}))
        }
        "workflow_list" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let db = core.db.lock().unwrap();
            let mut latest: HashMap<String, Workflow> = HashMap::new();
            for w in &db.workflows {
                if latest.get(&w.id).is_none_or(|v| v.version < w.version) {
                    latest.insert(w.id.clone(), w.clone());
                }
            }
            let mut list: Vec<_> = latest
                .into_values()
                .filter(|w| {
                    format!(
                        "{} {} {} {}",
                        w.name,
                        w.description,
                        w.domain,
                        w.tags.join(" ")
                    )
                    .to_lowercase()
                    .contains(&query)
                })
                .collect();
            list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!({"workflows":list}))
        }
        "workflow_get" => {
            let db = core.db.lock().unwrap();
            let w = db
                .workflows
                .iter()
                .filter(|w| Some(w.id.as_str()) == args["workflowId"].as_str())
                .max_by_key(|w| w.version)
                .ok_or("没有找到流程")?;
            Ok(serde_json::to_value(w).unwrap())
        }
        "workflow_save" => {
            let mut w: Workflow =
                serde_json::from_value(args.get("workflow").cloned().ok_or("缺少流程定义")?)
                    .map_err(|e| format!("流程格式错误：{e}"))?;
            validate_workflow(&w)?;
            if w.id.is_empty() {
                w.id = id();
            }
            let mut db = core.db.lock().unwrap();
            w.version = db
                .workflows
                .iter()
                .filter(|x| x.id == w.id)
                .map(|x| x.version)
                .max()
                .unwrap_or(0)
                + 1;
            w.status = "draft".into();
            w.updated_at = now();
            db.workflows.push(w.clone());
            core.persist(&db)?;
            changed(app);
            Ok(serde_json::to_value(w).unwrap())
        }
        "workflow_delete" => {
            let id = s(&args, "workflowId")?;
            let mut db = core.db.lock().unwrap();
            db.workflows.retain(|w| w.id != id);
            core.persist(&db)?;
            changed(app);
            Ok(json!({"ok":true}))
        }
        "workflow_run" => {
            let session_id = s(&args, "sessionId")?.to_string();
            let workflow_id = s(&args, "workflowId")?;
            let w = core
                .db
                .lock()
                .unwrap()
                .workflows
                .iter()
                .filter(|w| w.id == workflow_id)
                .max_by_key(|w| w.version)
                .cloned()
                .ok_or("没有找到流程")?;
            validate_workflow(&w)?;
            let inputs = args.get("inputs").cloned().unwrap_or(json!({}));
            let steps: Vec<Step> = w
                .steps
                .iter()
                .chain(std::iter::once(&w.completion))
                .map(|step| resolve_step(step, &w, &inputs))
                .collect::<Result<_, _>>()?;
            let actual = view(app, &session_id)?.url().map_err(|e| e.to_string())?;
            if actual.host_str() != Some(w.domain.as_str())
                || (w.start_url == "auto-browser://demo"
                    && actual.as_str() != format!("{}/demo", core.endpoint))
            {
                return Err("当前网页不属于该流程，请先打开流程入口网站".into());
            }
            let gate = core.gate(&session_id);
            let guard = gate.try_lock_owned().map_err(|_| "该网页已有任务占用")?;
            let run = Run {
                id: id(),
                session_id: session_id.clone(),
                workflow_id: Some(w.id.clone()),
                workflow_version: Some(w.version),
                name: w.name.clone(),
                status: "running".into(),
                current_step: 0,
                total_steps: steps.len(),
                started_at: now(),
                finished_at: None,
                error: None,
                events: vec![],
                definition: Some(w.clone()),
            };
            let run_id = run.id.clone();
            {
                let mut db = core.db.lock().unwrap();
                db.runs.push(run);
                core.persist(&db)?;
            }
            let task_app = app.clone();
            let task_id = run_id.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = guard;
                execute_run(&task_app, &task_id, &session_id, &w, steps).await;
            });
            changed(app);
            Ok(json!({"runId":run_id,"status":"running"}))
        }
        "run_list" => {
            let db = core.db.lock().unwrap();
            Ok(json!({"runs":db.runs.iter().rev().take(100).collect::<Vec<_>>()}))
        }
        "run_get" => {
            let id = s(&args, "runId")?;
            let db = core.db.lock().unwrap();
            Ok(
                serde_json::to_value(db.runs.iter().find(|r| r.id == id).ok_or("没有找到任务")?)
                    .unwrap(),
            )
        }
        "run_control" => {
            let id = s(&args, "runId")?;
            let action = s(&args, "action")?;
            let mut db = core.db.lock().unwrap();
            let r = db
                .runs
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or("没有找到任务")?;
            r.status = match (action, r.status.as_str()) {
                ("pause", "running") => "paused",
                ("resume", "paused") => "running",
                ("stop", "running" | "paused") => "stopping",
                _ => return Err("当前任务状态不允许该操作".into()),
            }
            .into();
            core.persist(&db)?;
            changed(app);
            Ok(json!({"ok":true}))
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

async fn execute_run(
    app: &AppHandle,
    run_id: &str,
    session_id: &str,
    w: &Workflow,
    steps: Vec<Step>,
) {
    let core = app.state::<Core>();
    let mut failure = None;
    let mut stopped = false;
    for (i, step) in steps.iter().enumerate() {
        loop {
            let status = core
                .db
                .lock()
                .unwrap()
                .runs
                .iter()
                .find(|r| r.id == run_id)
                .map(|r| r.status.clone())
                .unwrap_or_default();
            if status == "stopping" {
                stopped = true;
                break;
            }
            if status != "paused" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        if stopped {
            break;
        }
        let in_scope = view(app, session_id)
            .and_then(|v| v.url().map_err(|e| e.to_string()))
            .is_ok_and(|url| {
                url.host_str() == Some(w.domain.as_str())
                    && (w.start_url != "auto-browser://demo"
                        || url.as_str() == format!("{}/demo", core.endpoint))
            });
        if !in_scope {
            failure = Some(format!("第 {} 步：网页已离开流程适用域名", i + 1));
            break;
        }
        {
            let mut db = core.db.lock().unwrap();
            if let Some(r) = db.runs.iter_mut().find(|r| r.id == run_id) {
                r.current_step = i + 1;
            }
        }
        changed(app);
        // Never retry clicks/submits: an uncertain action may already have changed the website.
        let result = if step.kind.starts_with("assert_") {
            let mut latest = Err("断言未满足".into());
            for _ in 0..12 {
                let control = core
                    .db
                    .lock()
                    .unwrap()
                    .runs
                    .iter()
                    .find(|r| r.id == run_id)
                    .map(|r| r.status.clone())
                    .unwrap_or_default();
                if control == "stopping" {
                    stopped = true;
                    break;
                }
                latest = perform(app, session_id, step).await;
                if latest.is_ok() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            latest
        } else {
            perform(app, session_id, step).await
        };
        if stopped {
            break;
        }
        {
            let mut db = core.db.lock().unwrap();
            let r = db.runs.iter_mut().find(|r| r.id == run_id).unwrap();
            r.events.push(Event {
                at: now(),
                step: i + 1,
                description: if step.description.is_empty() {
                    step.kind.clone()
                } else {
                    step.description.clone()
                },
                result: match &result {
                    Ok(v) => v.clone(),
                    Err(e) => json!({"ok":false,"error":e}),
                },
            });
            if let Err(e) = core.persist(&db) {
                failure = Some(format!("执行记录保存失败：{e}"));
            }
        }
        changed(app);
        if let Err(e) = result {
            failure = Some(format!("第 {} 步：{e}", i + 1));
            break;
        }
        if failure.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    }
    let mut db = core.db.lock().unwrap();
    if let Some(r) = db.runs.iter_mut().find(|r| r.id == run_id) {
        let stop_requested = r.status == "stopping";
        r.status = if stopped || stop_requested {
            "stopped"
        } else if failure.is_some() {
            "failed"
        } else {
            "succeeded"
        }
        .into();
        r.error = failure;
        r.finished_at = Some(now());
        if r.status == "succeeded" {
            if let Some(w) = db
                .workflows
                .iter_mut()
                .find(|x| x.id == w.id && x.version == w.version)
            {
                w.status = "verified".into();
            }
        }
    }
    if let Err(e) = core.persist(&db) {
        eprintln!("保存执行结果失败：{e}");
    }
    drop(db);
    changed(app);
}

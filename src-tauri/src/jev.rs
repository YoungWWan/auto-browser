use crate::{
    core::{self, Core},
    jev_model::*,
    jev_runner::{self, BrowserPort, DecisionPort},
    model::{id, now},
    store,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

pub struct ActiveTask {
    pub task_id: String,
    pub origins: Vec<String>,
    pub cancel: watch::Sender<bool>,
    pub navigation_blocked: Arc<AtomicBool>,
}
pub struct JevState {
    pub settings: Mutex<Settings>,
    pub settings_error: Mutex<Option<String>>,
    pub active: Mutex<HashMap<String, ActiveTask>>,
    path: PathBuf,
    service: String,
    client: reqwest::Client,
}
impl JevState {
    pub fn new(directory: PathBuf, identifier: &str) -> Result<Self, String> {
        let path = directory.join("jev-settings.json");
        let loaded = if path.exists() {
            std::fs::read(&path)
                .map_err(|_| "无法读取 Jev 配置".into())
                .and_then(|bytes| {
                    serde_json::from_slice::<Settings>(&bytes)
                        .map_err(|_| "Jev 配置格式无效，请在配置页重新保存".into())
                })
                .and_then(|settings| {
                    validate_settings(&settings)?;
                    Ok(settings)
                })
        } else {
            Ok(Settings::default())
        };
        let (settings, error) = match loaded {
            Ok(settings) => (settings, None),
            Err(error) => (Settings::default(), Some(error)),
        };
        Ok(Self {
            settings: Mutex::new(settings),
            settings_error: Mutex::new(error),
            active: Mutex::new(HashMap::new()),
            path,
            service: format!("{identifier}.jev"),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|_| "无法初始化 Jev 请求".to_string())?,
        })
    }
    fn entry(&self, provider: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, provider).map_err(|_| "系统凭据库不可用".into())
    }
    fn credential(&self, provider: &str) -> Result<String, String> {
        self.entry(provider)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => "请先在「配置」页保存该供应商的 API Key".into(),
                _ => "无法访问系统凭据库，请检查系统授权".into(),
            })
    }
    fn has_credential(&self, provider: &str) -> Result<bool, String> {
        match self.entry(provider)?.get_password() {
            Ok(key) => Ok(!key.is_empty()),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err("无法访问系统凭据库，请检查系统授权".into()),
        }
    }
}
pub fn handles(name: &str) -> bool {
    name.starts_with("browser_delegate_") || name == "jev_status"
}
pub fn tools() -> Vec<Value> {
    let string = json!({"type":"string"});
    vec![
        json!({"name":"jev_status","description":"查询应用内可选 Jev 配置与已启用的业务空间，不返回凭据；配置只能由用户在应用配置页管理","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"browser_delegate_start","description":"委派指定 WebView 的有界子任务给 Jev；用户须在应用启用所属空间。仅点击、链接导航、滚动和等待，不填写、不调用包内 JS、不归档。返回任务 ID，完成仍需主 Agent 独立验证。allowedSelectors 可限制允许点击的控件（同时禁用自动滚动）。页面文字会发送已配置供应商","inputSchema":{"type":"object","properties":{"sessionId":string,"goal":{"type":"string","maxLength":2000},"allowedOrigins":{"type":"array","minItems":1,"maxItems":20,"items":string},"allowedSelectors":{"type":"array","maxItems":100,"items":string},"maxSteps":{"type":"integer","minimum":1,"maximum":30,"default":10},"maxMs":{"type":"integer","minimum":1000,"maximum":120000,"default":45000}},"required":["sessionId","goal","allowedOrigins"],"additionalProperties":false}}),
        json!({"name":"browser_delegate_get","description":"读取委派状态、最新页面文字、决策与执行记录；needs_verification 表示需独立核查，绝不表示业务成功","inputSchema":{"type":"object","properties":{"taskId":string},"required":["taskId"],"additionalProperties":false}}),
        json!({"name":"browser_delegate_list","description":"列出 Jev 委派记录，可按 sessionId 筛选；不返回完整快照","inputSchema":{"type":"object","properties":{"sessionId":string},"additionalProperties":false}}),
        json!({"name":"browser_delegate_stop","description":"停止后续操作；已发出的 DOM 动作等待回调结束后释放网页，已发生的效果不会撤销。查询 get 确认结束后再用基础工具接手","inputSchema":{"type":"object","properties":{"taskId":string},"required":["taskId"],"additionalProperties":false}}),
    ]
}
pub fn status(app: &AppHandle) -> Value {
    let state = app.state::<JevState>();
    let settings = state.settings.lock().unwrap().clone();
    json!({"provider":settings.provider,"model":settings.model,"enabledDomainIds":settings.enabled_domain_ids,"minConfidence":settings.min_confidence,"configurationError":state.settings_error.lock().unwrap().clone(),"activeCount":state.active.lock().unwrap().len()})
}
pub async fn settings_get(app: &AppHandle) -> Result<Value, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = status(&app);
        let state = app.state::<JevState>();
        result["credentials"] = json!({"typesafe":state.has_credential("typesafe")?,"openrouter":state.has_credential("openrouter")?});
        Ok(result)
    }).await.map_err(|_| "无法读取 Jev 配置".to_string())?
}
pub async fn settings_save(
    app: &AppHandle,
    settings: Settings,
    api_key: Option<String>,
) -> Result<Value, String> {
    validate_settings(&settings)?;
    let core = app.state::<Core>();
    if settings
        .enabled_domain_ids
        .iter()
        .any(|id| !core.db.lock().unwrap().domains.iter().any(|d| &d.id == id))
    {
        return Err("只能启用已有业务空间".into());
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<JevState>();
        if let Some(key) = api_key {
            if key.trim().is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
                return Err("API Key 无效".into());
            }
            state
                .entry(&settings.provider)?
                .set_password(key.trim())
                .map_err(|_| "API Key 未能保存到系统凭据库".to_string())?;
        }
        if !settings.enabled_domain_ids.is_empty() && !state.has_credential(&settings.provider)? {
            return Err("启用空间前需要保存该供应商的 API Key".into());
        }
        let mut current = state.settings.lock().unwrap();
        store::atomic_write(
            &state.path,
            &serde_json::to_vec_pretty(&settings).map_err(|_| "无法保存 Jev 配置".to_string())?,
        )?;
        *current = settings.clone();
        *state.settings_error.lock().unwrap() = None;
        for active in state.active.lock().unwrap().values() {
            let _ = active.cancel.send(true);
        }
        drop(current);
        core::changed(&app);
        Ok(status(&app))
    })
    .await
    .map_err(|_| "无法保存 Jev 配置".to_string())?
}
pub async fn credential_remove(app: &AppHandle, provider: String) -> Result<Value, String> {
    provider_endpoint(&provider)?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<JevState>();
        let mut current = state.settings.lock().unwrap();
        match state.entry(&provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("无法从系统凭据库移除 API Key".into()),
        }
        let mut settings = current.clone();
        if settings.provider == provider {
            settings.enabled_domain_ids.clear();
            *current = settings.clone();
            for active in state.active.lock().unwrap().values() {
                let _ = active.cancel.send(true);
            }
            if let Err(error) = store::atomic_write(
                &state.path,
                &serde_json::to_vec_pretty(&settings)
                    .map_err(|_| "无法保存 Jev 配置".to_string())?,
            ) {
                *state.settings_error.lock().unwrap() =
                    Some("密钥已移除且委派已停用，但配置落盘失败，请重新保存".into());
                drop(current);
                core::changed(&app);
                return Err(error);
            }
            *state.settings_error.lock().unwrap() = None;
        }
        drop(current);
        core::changed(&app);
        Ok(status(&app))
    })
    .await
    .map_err(|_| "无法移除 API Key".to_string())?
}
fn save_task(app: &AppHandle, task: &DelegateTask) -> Result<(), String> {
    let core = app.state::<Core>();
    let mut db = core.db.lock().unwrap();
    let mut next = db.clone();
    if let Some(existing) = next
        .delegate_tasks
        .iter_mut()
        .find(|existing| existing.id == task.id)
    {
        *existing = task.clone();
    } else {
        next.delegate_tasks.push(task.clone());
    }
    core.persist(&next)?;
    *db = next;
    core::changed(app);
    Ok(())
}
pub fn navigation_allowed(app: &AppHandle, session_id: &str, url: &str) -> bool {
    let state = app.state::<JevState>();
    let active = state.active.lock().unwrap();
    let Some(task) = active.get(session_id) else {
        return true;
    };
    if origin(url).is_ok_and(|origin| task.origins.contains(&origin)) {
        true
    } else {
        task.navigation_blocked.store(true, Ordering::Relaxed);
        false
    }
}
pub fn stop_all(app: &AppHandle) {
    for task in app.state::<JevState>().active.lock().unwrap().values() {
        let _ = task.cancel.send(true);
    }
}
struct NativeBrowser {
    app: AppHandle,
    session_id: String,
    navigation_blocked: Arc<AtomicBool>,
}
impl BrowserPort for NativeBrowser {
    async fn observe(&self) -> Result<Value, String> {
        if self.navigation_blocked.load(Ordering::Relaxed) {
            return Err("已阻止超出允许网站范围的导航，请主 Agent 接手".into());
        }
        let session = self
            .app
            .state::<Core>()
            .sessions
            .lock()
            .unwrap()
            .get(&self.session_id)
            .cloned()
            .ok_or("目标网页已关闭")?;
        if session.status == "loading" {
            return Ok(
                json!({"url":session.url,"title":session.title,"readyState":"loading","elements":[],"text":""}),
            );
        }
        core::evaluate(&self.app, &self.session_id, &json!({"kind":"snapshot"})).await
    }
    async fn execute(&self, snapshot: &Value, candidate: &Candidate) -> Result<(), String> {
        crate::model::validate_step(&candidate.step)?;
        let js = format!(
            "({})({},({}))",
            include_str!("jev_action.js"),
            json!({"snapshot":snapshot,"action":candidate.step}),
            include_str!("bridge.js")
        );
        core::evaluate_js(&self.app, &self.session_id, js).await?;
        Ok(())
    }
}
pub struct HttpDecider {
    pub client: reqwest::Client,
    pub settings: Settings,
    pub key: String,
    pub endpoint: String,
}
impl DecisionPort for HttpDecider {
    async fn decide(&self, body: Value) -> Result<Decision, String> {
        if body.to_string().contains(&self.key) {
            return Err("检测到凭据出现在页面或任务输入中，已停止发送".into());
        }
        let start = Instant::now();
        let mut response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Jev 网络请求失败或超时".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "Jev {} 请求失败（HTTP {}）",
                self.settings.provider,
                response.status().as_u16()
            ));
        }
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Jev 响应读取失败".to_string())?
        {
            if bytes.len() + chunk.len() > 262144 {
                return Err("Jev 响应超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Jev 返回了无效 JSON".to_string())?;
        parse_decision(
            &value,
            &self.settings,
            &body,
            start.elapsed().as_millis() as u64,
        )
    }
}
async fn start(app: &AppHandle, args: Value) -> Result<Value, String> {
    let request: TaskRequest =
        serde_json::from_value(args).map_err(|_| "委派参数格式无效".to_string())?;
    request.validate()?;
    let core = app.state::<Core>();
    let state = app.state::<JevState>();
    let settings = state.settings.lock().unwrap().clone();
    if state.settings_error.lock().unwrap().is_some() {
        return Err("请先修复 Jev 配置".into());
    }
    let session = core
        .sessions
        .lock()
        .unwrap()
        .get(&request.session_id)
        .cloned()
        .ok_or("目标网页已关闭")?;
    let domain_id = session
        .domain_id
        .ok_or("请先将网页分配到已启用 Jev 的业务空间")?;
    if !settings.enabled_domain_ids.contains(&domain_id) {
        return Err("用户尚未为该业务空间启用 Jev，请在「配置」页配置".into());
    }
    request.check_origin(&session.url)?;
    let credential_app = app.clone();
    let provider = settings.provider.clone();
    let key = tauri::async_runtime::spawn_blocking(move || {
        credential_app.state::<JevState>().credential(&provider)
    })
    .await
    .map_err(|_| "无法读取 Jev 凭据".to_string())??;
    let gate = core.gate(&request.session_id);
    let guard = gate.try_lock_owned().map_err(|_| "该网页已有任务占用")?;
    // Keep configuration stable until the task is registered for cancellation.
    let current_settings = state.settings.lock().unwrap();
    let current_session = core
        .sessions
        .lock()
        .unwrap()
        .get(&request.session_id)
        .cloned()
        .ok_or("目标网页已关闭")?;
    if *current_settings != settings || current_session.domain_id.as_ref() != Some(&domain_id) {
        return Err("配置或网页归属已变化，请重新委派".into());
    }
    request.check_origin(&current_session.url)?;
    let mut task = DelegateTask {
        id: id(),
        session_id: request.session_id.clone(),
        domain_id,
        goal: request.goal.clone(),
        provider: settings.provider.clone(),
        model: settings.model.clone(),
        status: "running".into(),
        started_at: now(),
        finished_at: None,
        max_steps: request.max_steps,
        max_ms: request.max_ms,
        allowed_origins: request.allowed_origins.clone(),
        events: vec![],
        last_snapshot: None,
        error: None,
        elapsed_ms: 0,
        api_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
    };
    save_task(app, &task)?;
    let (cancel, receiver) = watch::channel(false);
    let navigation_blocked = Arc::new(AtomicBool::new(false));
    state.active.lock().unwrap().insert(
        request.session_id.clone(),
        ActiveTask {
            task_id: task.id.clone(),
            origins: request.allowed_origins.clone(),
            cancel,
            navigation_blocked: navigation_blocked.clone(),
        },
    );
    drop(current_settings);
    let result = json!({"taskId":task.id,"status":"running"});
    let decider = HttpDecider {
        client: state.client.clone(),
        endpoint: provider_endpoint(&settings.provider)?.into(),
        settings: settings.clone(),
        key,
    };
    let browser = NativeBrowser {
        app: app.clone(),
        session_id: request.session_id.clone(),
        navigation_blocked,
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        if let Err(error) = jev_runner::run(
            &browser,
            &decider,
            &settings,
            &request,
            &mut task,
            receiver,
            |task| save_task(&handle, task),
        )
        .await
        {
            task.finish("error", Some(error));
            let _ = save_task(&handle, &task);
        }
        handle
            .state::<JevState>()
            .active
            .lock()
            .unwrap()
            .remove(&request.session_id);
        core::changed(&handle);
    });
    Ok(result)
}
fn task_value(app: &AppHandle, task: &DelegateTask) -> Value {
    let mut value = json!(task);
    if task.active()
        && app
            .state::<JevState>()
            .active
            .lock()
            .unwrap()
            .get(&task.session_id)
            .is_some_and(|active| active.task_id == task.id && *active.cancel.borrow())
    {
        value["status"] = json!("stopping");
    }
    value
}
pub async fn dispatch(app: &AppHandle, name: &str, args: Value) -> Result<Value, String> {
    match name {
        "jev_status" => Ok(status(app)),
        "browser_delegate_start" => start(app, args).await,
        "browser_delegate_get" => {
            let core = app.state::<Core>();
            let db = core.db.lock().unwrap();
            let task = db
                .delegate_tasks
                .iter()
                .find(|task| Some(task.id.as_str()) == args["taskId"].as_str())
                .ok_or("没有找到委派任务")?;
            Ok(task_value(app, task))
        }
        "browser_delegate_list" => {
            let core = app.state::<Core>();
            let db = core.db.lock().unwrap();
            let tasks: Vec<_> = db
                .delegate_tasks
                .iter()
                .rev()
                .filter(|task| {
                    args["sessionId"]
                        .as_str()
                        .is_none_or(|id| task.session_id == id)
                })
                .map(|task| {
                    let mut value = task_value(app, task);
                    value.as_object_mut().unwrap().remove("lastSnapshot");
                    value
                })
                .collect();
            Ok(json!({"tasks":tasks}))
        }
        "browser_delegate_stop" => {
            let core = app.state::<Core>();
            let mut task = core
                .db
                .lock()
                .unwrap()
                .delegate_tasks
                .iter()
                .find(|task| Some(task.id.as_str()) == args["taskId"].as_str())
                .cloned()
                .ok_or("没有找到委派任务")?;
            if task.active() {
                let state = app.state::<JevState>();
                let active = state.active.lock().unwrap();
                if let Some(active) = active
                    .get(&task.session_id)
                    .filter(|active| active.task_id == task.id)
                {
                    let _ = active.cancel.send(true);
                }
                // Return stopping without overwriting the worker's newer history.
                task.status = "stopping".into();
            }
            Ok(json!({"taskId":task.id,"status":task.status}))
        }
        _ => Err("未知委派工具".into()),
    }
}

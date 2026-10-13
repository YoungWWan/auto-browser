use crate::{
    jev::HttpDecider,
    jev_model::*,
    jev_runner::{self, BrowserPort, DecisionPort},
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
};

fn request() -> TaskRequest {
    serde_json::from_value(
        json!({"sessionId":"web","goal":"打开客户列表","allowedOrigins":["https://example.com"]}),
    )
    .unwrap()
}
fn snapshot(text: &str) -> Value {
    json!({"documentId":"doc","url":"https://example.com/list?token=private#section","title":"后台","readyState":"complete","text":text,"scroll":{"x":0,"y":0,"maxY":800},"elements":[
        {"selector":"#open","tag":"button","label":"打开客户列表","text":"打开客户列表","disabled":false},
        {"selector":"#input","tag":"input","type":"text","label":"姓名","value":"private-value"},
        {"selector":"#foreign","tag":"a","label":"其他网站","href":"https://other.example"},
        {"selector":"#disabled","tag":"button","label":"禁用","disabled":true}
    ]})
}
fn task() -> DelegateTask {
    serde_json::from_value(json!({"id":"task","sessionId":"web","domainId":"space","goal":"打开客户列表","provider":"typesafe","model":"jev-latest","status":"running","startedAt":"now","finishedAt":null,"maxSteps":10,"maxMs":45000,"allowedOrigins":["https://example.com"],"events":[],"lastSnapshot":null,"error":null,"elapsedMs":0,"apiMs":0,"inputTokens":0,"outputTokens":0})).unwrap()
}
fn response(choice: &str) -> Value {
    json!({"model":"jev-1","answers":{"next":{"type":"choice","choice":choice,"confidence":0.85,"probabilities":{"a0":0.85,"a1":0.05,"DONE":0.04,"BLOCKED":0.03,"WAIT":0.03}}},"usage":{"input_tokens":20,"output_tokens":2}})
}
#[test]
fn contract_filters_actions_and_excludes_input_values() {
    let req = request();
    req.validate().unwrap();
    let state = snapshot("列表入口");
    let actions = candidates(&state, &req);
    assert_eq!(actions.len(), 2); // one button and one possible scroll
    let body = decision_body(&Settings::default(), &req.goal, &state, &actions, &[]);
    assert!(!body.to_string().contains("private"));
    assert!(!body.to_string().contains("#open"));
    assert!(body["questions"]["next"]["criteria"]["BLOCKED"].is_string());
    let mut scoped = req;
    scoped.allowed_selectors = vec!["#open".into()];
    assert_eq!(candidates(&state, &scoped).len(), 1);
    scoped.allowed_selectors = vec!["#input".into()];
    assert!(candidates(&state, &scoped).is_empty());
}
#[test]
fn origins_and_config_cannot_expand_to_paths_credentials_or_other_providers() {
    let mut req = request();
    for bad in [
        "https://example.com/",
        "https://example.com/path",
        "file:///tmp/page",
        "https://user:pass@example.com",
    ] {
        req.allowed_origins = vec![bad.into()];
        assert!(req.validate().is_err(), "{bad}");
    }
    let mut settings = Settings::default();
    settings.provider = "openrouter".into();
    assert!(validate_settings(&settings).is_err());
    settings.model = "~typesafe/jev-latest".into();
    validate_settings(&settings).unwrap();
    settings.model = "anthropic/claude".into();
    assert!(validate_settings(&settings).is_err());
    settings.provider = "https://custom.example".into();
    assert!(validate_settings(&settings).is_err());
}
#[test]
fn decision_rejects_unknown_choices_malformed_probabilities_and_wrong_models() {
    let settings = Settings::default();
    let req = request();
    let body = decision_body(
        &settings,
        &req.goal,
        &snapshot("入口"),
        &candidates(&snapshot("入口"), &req),
        &[],
    );
    let valid = response("a0");
    assert_eq!(
        parse_decision(&valid, &settings, &body, 7)
            .unwrap()
            .input_tokens,
        20
    );
    for (field, value) in [
        ("choice", json!("unknown")),
        ("confidence", json!(1.1)),
        ("type", json!("text")),
        ("probabilities", json!({"a0":1.0})),
    ] {
        let mut invalid = valid.clone();
        invalid["answers"]["next"][field] = value;
        assert!(parse_decision(&invalid, &settings, &body, 0).is_err());
    }
    let mut invalid = response("DONE");
    assert!(parse_decision(&invalid, &settings, &body, 0).is_err());
    invalid["model"] = json!("unrelated-model");
    assert!(parse_decision(&invalid, &settings, &body, 0).is_err());
    let mut openrouter = settings;
    openrouter.provider = "openrouter".into();
    openrouter.model = "~typesafe/jev-latest".into();
    parse_decision(&valid, &openrouter, &body, 0).unwrap();
}
struct Browser {
    states: Mutex<VecDeque<Value>>,
    current: Mutex<Value>,
    actions: AtomicUsize,
    change: bool,
    action_delay: u64,
    stale_action: bool,
}
impl Browser {
    fn new(states: Vec<Value>) -> Self {
        Self {
            current: Mutex::new(states.last().unwrap().clone()),
            states: Mutex::new(states.into()),
            actions: AtomicUsize::new(0),
            change: true,
            action_delay: 0,
            stale_action: false,
        }
    }
}
impl BrowserPort for Browser {
    async fn observe(&self) -> Result<Value, String> {
        if let Some(state) = self.states.lock().unwrap().pop_front() {
            *self.current.lock().unwrap() = state;
        }
        Ok(self.current.lock().unwrap().clone())
    }
    async fn execute(&self, _: &Value, _: &Candidate) -> Result<(), String> {
        if self.stale_action {
            return Err("JEV_STALE_STATE".into());
        }
        tokio::time::sleep(Duration::from_millis(self.action_delay)).await;
        self.actions.fetch_add(1, Ordering::SeqCst);
        if self.change {
            self.current.lock().unwrap()["text"] = json!("已打开客户列表");
        }
        Ok(())
    }
}
struct Decider {
    choices: Mutex<VecDeque<(String, f64)>>,
    calls: AtomicUsize,
    delay: u64,
    error: bool,
}
impl Decider {
    fn new(choices: &[&str]) -> Self {
        Self {
            choices: Mutex::new(choices.iter().map(|c| (c.to_string(), 0.85)).collect()),
            calls: AtomicUsize::new(0),
            delay: 0,
            error: false,
        }
    }
}
impl DecisionPort for Decider {
    async fn decide(&self, _: Value) -> Result<Decision, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(self.delay)).await;
        if self.error {
            return Err("Jev typesafe 请求失败（HTTP 401）".into());
        }
        let (choice, confidence) = self
            .choices
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(("DONE".into(), 0.85));
        Ok(Decision {
            choice,
            confidence,
            model: "jev-1".into(),
            api_ms: 7,
            input_tokens: 20,
            output_tokens: 2,
        })
    }
}
async fn run(browser: &Browser, decider: &Decider, req: &TaskRequest) -> DelegateTask {
    let (_sender, receiver) = watch::channel(false);
    let mut task = task();
    let _ = jev_runner::run(
        browser,
        decider,
        &Settings::default(),
        req,
        &mut task,
        receiver,
        |_| Ok(()),
    )
    .await;
    assert!(task.finished_at.is_some());
    task
}
#[tokio::test]
async fn click_then_done_requires_independent_verification_and_records_usage() {
    let browser = Browser::new(vec![snapshot("入口")]);
    let task = run(&browser, &Decider::new(&["a0", "DONE"]), &request()).await;
    assert_eq!(task.status, "needs_verification");
    assert_eq!(browser.actions.load(Ordering::SeqCst), 1);
    assert_eq!(task.input_tokens, 40);
    assert!(task.events[0].executed);
    assert!(!task.events[1].executed);
}
#[tokio::test]
async fn uncertain_or_blocked_decision_never_clicks() {
    for (choice, confidence, expected) in [
        ("a0", 0.6, "low_confidence"),
        ("BLOCKED", 0.85, "blocked"),
        ("DONE", 0.85, "needs_verification"),
    ] {
        let browser = Browser::new(vec![snapshot("入口")]);
        let decider = Decider::new(&[]);
        decider
            .choices
            .lock()
            .unwrap()
            .push_back((choice.into(), confidence));
        assert_eq!(run(&browser, &decider, &request()).await.status, expected);
        assert_eq!(browser.actions.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn page_change_after_decision_discards_action_and_observes_again() {
    let browser = Browser::new(vec![snapshot("入口"), snapshot("其他页面")]);
    let task = run(&browser, &Decider::new(&["a0", "DONE"]), &request()).await;
    assert_eq!(task.status, "needs_verification");
    assert_eq!(task.events[0].reason.as_deref(), Some("stale_state"));
    assert_eq!(browser.actions.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn atomic_dom_guard_rejection_is_not_retried_blindly() {
    let mut browser = Browser::new(vec![snapshot("入口")]);
    browser.stale_action = true;
    let task = run(&browser, &Decider::new(&["a0", "DONE"]), &request()).await;
    assert_eq!(task.events[0].reason.as_deref(), Some("stale_state"));
    assert_eq!(browser.actions.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn unchanged_page_prevents_repeat_click_and_step_limit_is_bounded() {
    let mut browser = Browser::new(vec![snapshot("入口")]);
    browser.change = false;
    assert_eq!(
        run(&browser, &Decider::new(&["a0", "a0"]), &request())
            .await
            .status,
        "no_progress"
    );
    assert_eq!(browser.actions.load(Ordering::SeqCst), 1);
    let mut req = request();
    req.max_steps = 1;
    assert_eq!(
        run(
            &Browser::new(vec![snapshot("入口")]),
            &Decider::new(&["a0"]),
            &req
        )
        .await
        .status,
        "step_limit"
    );
}
#[tokio::test]
async fn cancellation_during_network_or_issued_action_retains_correct_effect_record() {
    for during_action in [false, true] {
        let mut browser = Browser::new(vec![snapshot("入口")]);
        browser.action_delay = if during_action { 60 } else { 0 };
        let mut decider = Decider::new(&["a0"]);
        decider.delay = if during_action { 0 } else { 10000 };
        let (sender, receiver) = watch::channel(false);
        let mut task = task();
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            sender.send(true).unwrap();
        };
        let req = request();
        let settings = Settings::default();
        let (result, _) = tokio::join!(
            jev_runner::run(
                &browser,
                &decider,
                &settings,
                &req,
                &mut task,
                receiver,
                |_| Ok(())
            ),
            cancel
        );
        result.unwrap();
        assert_eq!(task.status, "stopped");
        assert_eq!(
            browser.actions.load(Ordering::SeqCst),
            usize::from(during_action)
        );
        assert_eq!(
            task.events.iter().filter(|e| e.executed).count(),
            usize::from(during_action)
        );
    }
}
#[tokio::test]
async fn deadline_aborts_requests_and_loading_makes_no_model_calls() {
    let mut req = request();
    req.max_ms = 25;
    let mut decider = Decider::new(&["a0"]);
    decider.delay = 10000;
    let browser = Browser::new(vec![snapshot("入口")]);
    assert_eq!(run(&browser, &decider, &req).await.status, "budget");
    assert_eq!(browser.actions.load(Ordering::SeqCst), 0);
    let mut loading = snapshot("");
    loading["readyState"] = json!("loading");
    let decider = Decider::new(&[]);
    assert_eq!(
        run(&Browser::new(vec![loading]), &decider, &req)
            .await
            .status,
        "budget"
    );
    assert_eq!(decider.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn network_failure_is_visible_without_inventing_a_decision() {
    let browser = Browser::new(vec![snapshot("入口")]);
    let mut decider = Decider::new(&[]);
    decider.error = true;
    let task = run(&browser, &decider, &request()).await;
    assert_eq!(task.status, "error");
    assert_eq!(task.events[0].reason.as_deref(), Some("api_error"));
    assert_eq!(browser.actions.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn http_adapter_sends_typed_decision_and_does_not_echo_server_secrets() {
    for status in [200, 401, 302] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            let mut chunk = [0; 4096];
            loop {
                let n = stream.read(&mut chunk).await.unwrap();
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= index + 4 + length {
                        assert!(headers.contains("authorization: bearer synthetic-test-key"));
                        let body: Value = serde_json::from_slice(&bytes[index + 4..]).unwrap();
                        assert_eq!(body["questions"]["next"]["type"], "choice");
                        assert!(!body.to_string().contains("synthetic-test-key"));
                        break;
                    }
                }
                assert!(n > 0);
            }
            let body = if status == 200 {
                response("a0").to_string()
            } else {
                "synthetic-test-key provider detail".into()
            };
            let reply = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1\r\nConnection: close\r\n\r\n{body}",body.len());
            stream.write_all(reply.as_bytes()).await.unwrap();
        });
        let settings = Settings::default();
        let req = request();
        let body = decision_body(
            &settings,
            &req.goal,
            &snapshot("入口"),
            &candidates(&snapshot("入口"), &req),
            &[],
        );
        let adapter = HttpDecider {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            settings,
            key: "synthetic-test-key".into(),
            endpoint,
        };
        let result = adapter.decide(body).await;
        if status == 200 {
            assert_eq!(result.unwrap().choice, "a0");
        } else {
            let error = result.unwrap_err();
            assert!(error.contains(&status.to_string()));
            assert!(!error.contains("synthetic-test-key"));
        }
        server.await.unwrap();
    }
}

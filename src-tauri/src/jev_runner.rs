use crate::{jev_model::*, model::now};
use serde_json::{json, Value};
use std::{future::Future, time::Instant};
use tokio::sync::watch;

pub trait BrowserPort: Sync {
    fn observe(&self) -> impl Future<Output = Result<Value, String>> + Send;
    fn execute(
        &self,
        snapshot: &Value,
        candidate: &Candidate,
    ) -> impl Future<Output = Result<(), String>> + Send;
}
pub trait DecisionPort: Sync {
    fn decide(&self, body: Value) -> impl Future<Output = Result<Decision, String>> + Send;
}
pub fn signature(snapshot: &Value) -> Value {
    json!([
        snapshot["documentId"],
        snapshot["url"],
        snapshot["title"],
        snapshot["readyState"],
        snapshot["text"],
        snapshot["scroll"],
        snapshot["elements"]
    ])
}
fn event(
    choice: &str,
    confidence: Option<f64>,
    action: &str,
    executed: bool,
    reason: Option<&str>,
    api_ms: u64,
) -> TaskEvent {
    TaskEvent {
        at: now(),
        choice: choice.into(),
        confidence,
        action: action.into(),
        executed,
        reason: reason.map(String::from),
        api_ms,
    }
}
async fn observe<B: BrowserPort>(
    browser: &B,
    cancel: &mut watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<Value, String> {
    if *cancel.borrow() {
        return Err("__JEV_CANCELLED".into());
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("__JEV_CANCELLED".into()),
        _ = tokio::time::sleep_until(deadline) => Err("__JEV_BUDGET".into()),
        result = browser.observe() => result,
    }
}
// Cancellation can abort decision requests and waits. An already issued DOM action
// keeps the page lock until its callback completes; stopping never undoes an effect.
pub async fn run<B: BrowserPort, D: DecisionPort>(
    browser: &B,
    decider: &D,
    settings: &Settings,
    request: &TaskRequest,
    task: &mut DelegateTask,
    mut cancel: watch::Receiver<bool>,
    save: impl Fn(&DelegateTask) -> Result<(), String>,
) -> Result<(), String> {
    let start = Instant::now();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(request.max_ms);
    let mut decisions = 0;
    let mut waits = 0;
    let mut last_no_effect = None;
    let outcome: Result<(), String> = async {
        loop {
            task.elapsed_ms = start.elapsed().as_millis() as u64;
            if *cancel.borrow() { task.finish("stopped", None); break; }
            if tokio::time::Instant::now() >= deadline { task.finish("budget", Some("已达到本次时间限制，请主 Agent 核查后继续".into())); break; }
            if decisions >= request.max_steps { task.finish("step_limit", Some("已达到本次决策次数限制".into())); break; }
            let snapshot = observe(browser, &mut cancel, deadline).await?;
            request.check_origin(snapshot["url"].as_str().ok_or("网页地址不可用")?)?;
            task.last_snapshot = Some(decision_snapshot(&snapshot));
            save(task)?;
            if snapshot["readyState"] != "complete" {
                tokio::select! { _ = cancel.changed() => {}, _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {} }
                continue;
            }
            let actions = candidates(&snapshot, request);
            let body = decision_body(settings, &request.goal, &snapshot, &actions, &task.events);
            let api_start = Instant::now();
            let decision = tokio::select! {
                _ = cancel.changed() => { task.finish("stopped", None); break; },
                _ = tokio::time::sleep_until(deadline) => { task.finish("budget", Some("已达到本次时间限制".into())); break; },
                result = decider.decide(body) => match result {
                    Ok(decision) => decision,
                    Err(error) => {
                        let elapsed = api_start.elapsed().as_millis() as u64;
                        task.api_ms += elapsed;
                        task.events.push(event("ERROR", None, "决策请求失败", false, Some("api_error"), elapsed));
                        return Err(error);
                    }
                },
            };
            decisions += 1;
            task.model = decision.model.clone();
            task.api_ms += decision.api_ms;
            task.input_tokens += decision.input_tokens;
            task.output_tokens += decision.output_tokens;
            if *cancel.borrow() { task.finish("stopped", None); break; }
            let fresh = observe(browser, &mut cancel, deadline).await?;
            request.check_origin(fresh["url"].as_str().ok_or("网页地址不可用")?)?;
            task.last_snapshot = Some(decision_snapshot(&fresh));
            let action = actions.iter().find(|a| a.id == decision.choice);
            let description = action.map(|a| a.description.as_str()).unwrap_or(&decision.choice);
            let record = event(&decision.choice, Some(decision.confidence), description, false, None, decision.api_ms);
            if signature(&fresh) != signature(&snapshot) {
                task.events.push(TaskEvent { reason: Some("stale_state".into()), ..record }); save(task)?; continue;
            }
            if tokio::time::Instant::now() >= deadline { task.finish("budget", Some("决策完成时已达到时间限制".into())); break; }
            if decision.confidence < settings.min_confidence {
                task.events.push(record); task.finish("low_confidence", Some("Jev 不确定下一步，已返回主 Agent".into())); break;
            }
            if decision.choice == "DONE" {
                task.events.push(record); task.finish("needs_verification", None); break;
            }
            if decision.choice == "BLOCKED" {
                task.events.push(record); task.finish("blocked", Some("需要主 Agent 填写资料、处理控件或补充判断".into())); break;
            }
            if decision.choice == "WAIT" {
                waits += 1; task.events.push(TaskEvent { reason: Some("wait".into()), ..record }); save(task)?;
                if waits >= 5 { task.finish("loading_timeout", Some("连续等待后页面仍未就绪".into())); break; }
                tokio::select! { _ = cancel.changed() => {}, _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {} }
                continue;
            }
            waits = 0;
            let action = action.ok_or("Jev 选择了不存在的动作")?;
            if last_no_effect.as_deref() == Some(description) {
                task.events.push(record); task.finish("no_progress", Some("相同动作未产生可观察变化，已返回主 Agent".into())); break;
            }
            if *cancel.borrow() { task.finish("stopped", None); break; }
            match browser.execute(&snapshot, action).await {
                Err(e) if e == "JEV_STALE_STATE" => { task.events.push(TaskEvent { reason: Some("stale_state".into()), ..record }); save(task)?; continue; },
                Err(e) => { task.events.push(TaskEvent { reason: Some("action_error".into()), ..record }); task.finish("action_error", Some(e)); break; },
                Ok(_) => task.events.push(TaskEvent { executed: true, ..record }),
            }
            save(task)?;
            let next = observe(browser, &mut cancel, deadline).await?;
            request.check_origin(next["url"].as_str().ok_or("网页地址不可用")?)?;
            last_no_effect = if signature(&next) == signature(&snapshot) { Some(description.to_string()) } else { None };
            task.last_snapshot = Some(decision_snapshot(&next));
            save(task)?;
        }
        Ok(())
    }.await;
    if let Err(error) = &outcome {
        match error.as_str() {
            "__JEV_CANCELLED" => task.finish("stopped", None),
            "__JEV_BUDGET" => task.finish("budget", Some("已达到本次时间限制".into())),
            _ => task.finish("error", Some(error.clone())),
        }
    }
    task.elapsed_ms = start.elapsed().as_millis() as u64;
    save(task)?;
    if matches!(task.status.as_str(), "stopped" | "budget") {
        Ok(())
    } else {
        outcome
    }
}

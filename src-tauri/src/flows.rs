use crate::{
    core::{self, Core},
    flow_model::*,
    model::{id, now, Database},
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub fn handles(name: &str) -> bool {
    name.starts_with("domain_")
        || name.starts_with("flow_")
        || name.starts_with("recording_")
        || name.starts_with("script_run_")
        || name == "browser_bind_domain"
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数：{key}"))
}
fn recording_summary(events: &[Value]) -> Value {
    let mut actions: Vec<Value> = Vec::new();
    let mut last_edit_target: Option<(String, String)> = None;
    let mut pending_submit_click = false;
    for event in events {
        let target = &event["target"];
        let kind = match event["kind"].as_str() {
            Some("input") => "input",
            Some("change") => {
                if target["tag"] == "select"
                    || matches!(target["type"].as_str(), Some("checkbox" | "radio" | "file"))
                {
                    "change"
                } else {
                    "input"
                }
            }
            Some("click")
                if matches!(target["tag"].as_str(), Some("button" | "a"))
                    || matches!(target["type"].as_str(), Some("submit" | "image"))
                    || target["role"] == "button" =>
            {
                "click"
            }
            Some("submit") => "submit",
            Some("navigation") => "navigation",
            _ => {
                if matches!(
                    event["kind"].as_str(),
                    Some("page_context" | "page_leave" | "recording_end")
                ) {
                    pending_submit_click = false;
                }
                continue;
            }
        };
        if kind == "submit" && pending_submit_click {
            if let Some(last) = actions.last_mut() {
                last["kind"] = json!("submit");
            }
            pending_submit_click = false;
            last_edit_target = None;
            continue;
        }
        pending_submit_click =
            kind == "click" && matches!(target["type"].as_str(), Some("submit" | "image"));
        // Summaries describe actions, never field values, page contents or URLs.
        let label = match kind {
            "submit" => "表单".to_owned(),
            "navigation" => "页面".to_owned(),
            _ => target["label"]
                .as_str()
                .filter(|label| !label.trim().is_empty())
                .unwrap_or("未命名控件")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect(),
        };
        let edit_target = if kind == "input" {
            target["selector"]
                .as_str()
                .or_else(|| target["name"].as_str())
                .filter(|key| !key.is_empty())
                .map(|key| (key.to_owned(), label.clone()))
        } else {
            None
        };
        if edit_target.is_some() && edit_target == last_edit_target {
            continue;
        }
        last_edit_target = edit_target;
        actions.push(json!({"order": actions.len() + 1, "kind": kind, "label": label}));
    }
    let count = actions.len();
    let steps = if count > 5 {
        let mut steps = actions[..4].to_vec();
        steps.push(actions[count - 1].clone());
        steps
    } else {
        actions
    };
    json!({"actionCount":count,"steps":steps,"omittedActions":count.saturating_sub(5)})
}
fn transaction<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Database) -> Result<T, String>,
) -> Result<T, String> {
    let core = app.state::<Core>();
    let mut db = core.db.lock().unwrap();
    let mut next = db.clone();
    let result = f(&mut next)?;
    core.persist(&next)?;
    *db = next;
    core::changed(app);
    Ok(result)
}
pub fn tools() -> Vec<Value> {
    let string = json!({"type":"string"});
    let object = json!({"type":"object"});
    let definitions = vec![
        ("domain_list", "列出用户命名的业务空间；一个空间可包含多个网站", json!({}), vec![]),
        ("domain_get", "读取业务空间及网站入口", json!({"domainId":string}), vec!["domainId"]),
        ("domain_create", "创建业务空间，名称与网站 hostname 无关。websites 每项含 id、name、entryUrl", json!({"name":string,"description":string,"websites":{"type":"array","items":{"type":"object"}}}), vec!["name"]),
        ("domain_update", "更新空间名称、说明和网站入口", json!({"domainId":string,"name":string,"description":string,"websites":{"type":"array","items":{"type":"object"}}}), vec!["domainId","name"]),
        ("browser_bind_domain", "将已有网页绑定业务空间，录制期间不可更改归属", json!({"sessionId":string,"domainId":string}), vec!["sessionId","domainId"]),
        ("recording_status", "读取目标网页的采集器状态与最近上报错误",json!({"sessionId":string}),vec!["sessionId"]),
        ("recording_start", "开始采集目标网页的用户实际交互与页面上下文；创建未归档流程。可用 flowId 追加该未归档流程的录制", json!({"domainId":string,"sessionId":string,"name":string,"flowId":string}), vec!["domainId","sessionId","name"]),
        ("recording_stop", "结束录制并保留原始事件，仍为未归档；归档由用户自己的 Agent 提交", json!({"recordingId":string}), vec!["recordingId"]),
        ("recording_list", "列出录制元信息，支持 domainId；包含录制中和中断记录", json!({"domainId":string}), vec![]),
        ("recording_get", "分页读取完整原始事件与页面上下文，按 sequence 排序；offset 默认 0，limit 默认 100，最大 500", json!({"recordingId":string,"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":500}}), vec!["recordingId"]),
        ("flow_list", "默认发现全部空间的未归档和已归档流程；可按 domainId、archiveState、query 筛选和分页", json!({"domainId":string,"archiveState":{"type":"string","enum":["unarchived","archived"]},"query":string,"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":500}}), vec![]),
        ("flow_get", "读取流程、当前说明、JS 脚本清单、全部归档版本和原始录制索引；两种状态均可读取", json!({"flowId":string,"version":{"type":"integer","minimum":1}}), vec!["flowId"]),
        ("flow_archive", "仅用户自己的外部 Agent 提交：读取原始记录，整理 knowledge 并提交可选 scripts。knowledge 必含 purpose、procedureMarkdown、judgementMarkdown；scripts 每项含 id、name、content（async 函数体，可使用 inputs、signal、document，return JSON 结果）。保留原始记录，整体生成新版本。不会自动执行", json!({"flowId":string,"expectedRevision":{"type":"integer","minimum":1},"knowledge":object,"scripts":{"type":"array","items":object},"sourceRecordingIds":{"type":"array","items":string},"sourceNotes":string,"submittedBy":string}), vec!["flowId","expectedRevision","knowledge","submittedBy"]),
        ("flow_create_archived", "用户自己的 Agent 从零创建已归档工作包，不要求录制；knowledge 和 scripts 格式同 flow_archive。归档不等于验证", json!({"domainId":string,"name":string,"description":string,"tags":{"type":"array","items":string},"knowledge":object,"scripts":{"type":"array","items":object},"sourceNotes":string,"submittedBy":string}), vec!["domainId","name","knowledge","submittedBy"]),
        ("flow_script_get", "读取指定归档版本中的 JS 脚本内容和调用说明", json!({"flowId":string,"version":{"type":"integer","minimum":1},"scriptId":string}), vec!["flowId","version","scriptId"]),
        ("flow_script_run", "在指定内置 WebView 中执行已保存 JS 脚本，支持异步、inputs、signal 和 document；返回 scriptRunId，用 script_run_get 查询。需与 业务空间 绑定，版本固定。脚本成功不证明业务完成；超时不自动重试", json!({"flowId":string,"version":{"type":"integer","minimum":1},"scriptId":string,"sessionId":string,"inputs":object,"timeoutMs":{"type":"integer","minimum":50,"maximum":30000}}), vec!["flowId","version","scriptId","sessionId","inputs"]),
        ("script_run_list", "列出 JS 脚本执行状态，结果通过 script_run_get 读取",json!({}),vec![]),
        ("script_run_get", "读取 JS 脚本结果和错误；uncertain 时仍占用网页，需核查或重新加载页面结束旧脚本", json!({"scriptRunId":string}), vec!["scriptRunId"]),
        ("flow_export", "导出工作包及其全部版本、JS 脚本和原始录制，保留来源关联", json!({"flowId":string}), vec!["flowId"]),
        ("flow_import", "导入工作包到指定 业务空间。重置本地标识，保留包内版本和来源；导入不执行脚本", json!({"domainId":string,"package":object}), vec!["domainId","package"]),
    ];
    definitions.into_iter().map(|(name, description, properties, required)| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
pub fn active_recording(app: &AppHandle, session_id: &str) -> Option<String> {
    app.state::<Core>()
        .db
        .lock()
        .unwrap()
        .recordings
        .iter()
        .find(|r| r.session_id == session_id && r.capture_state == "recording")
        .map(|r| r.id.clone())
}
pub fn page_message(app: &AppHandle, session_id: &str, message: Value) -> Result<Value, String> {
    let core = app.state::<Core>();
    if !core.sessions.lock().unwrap().contains_key(session_id) {
        return Err("目标网页已关闭".into());
    }
    if message.to_string().len() > 90_000 {
        return Err("网页上报数据过大".into());
    }
    match message["kind"].as_str() {
        Some("recorder_ready") => Ok(json!({"recordingId":active_recording(app, session_id)})),
        Some("record") => {
            let recording_id = text(&message, "recordingId")?;
            let mut event = message.get("event").cloned().ok_or("缺少事件")?;
            if !event.is_object() || event["kind"].as_str().is_none() {
                return Err("事件格式无效".into());
            }
            transaction(app, |db| {
                let r = db
                    .recordings
                    .iter_mut()
                    .find(|r| {
                        r.id == recording_id
                            && r.session_id == session_id
                            && r.capture_state == "recording"
                    })
                    .ok_or("录制已结束或不属于当前网页")?;
                if r.events.len() >= 10000 {
                    if !r.limitations.iter().any(|l| l.contains("10000")) {
                        r.limitations
                            .push("已达到 10000 条记录上限，后续事件未保存".into());
                    }
                    return Ok(json!({"accepted":false}));
                }
                event["id"] = json!(id());
                event["sequence"] = json!(r.events.len() + 1);
                event["receivedAt"] = json!(now());
                event["sessionId"] = json!(session_id);
                // Password values must stay redacted even if a page submits an incorrect payload.
                if event["target"]["type"] == "password" {
                    event["value"] = json!("[redacted]");
                }
                r.events.push(event);
                Ok(json!({"accepted":true}))
            })
        }
        Some("script_result") => {
            let request_id = text(&message, "requestId")?;
            let mut pending = core.pending_scripts.lock().unwrap();
            if pending.get(request_id).is_none_or(|p| p.0 != session_id) {
                return Err("没有属于当前网页的脚本请求".into());
            }
            let (_, tx) = pending.remove(request_id).unwrap();
            let _ = tx.send(
                message
                    .get("result")
                    .cloned()
                    .unwrap_or(json!({"ok":false,"error":"脚本没有返回结果"})),
            );
            Ok(json!({"accepted":true}))
        }
        Some("recording_stopped") => transaction(app, |db| {
            let rid = text(&message, "recordingId")?;
            let r = db
                .recordings
                .iter_mut()
                .find(|r| {
                    r.id == rid && r.session_id == session_id && r.capture_state == "recording"
                })
                .ok_or("录制已结束")?;
            r.capture_state = "completed".into();
            r.ended_at = Some(now());
            Ok(json!({"accepted":true}))
        }),
        _ => Err("未知网页上报类型".into()),
    }
}
pub fn navigation(app: &AppHandle, session_id: &str, url: &str) {
    let core = app.state::<Core>();
    // Leaving the document invalidates every pending result for that document.
    let mut pending = core.pending_scripts.lock().unwrap();
    let ids: Vec<_> = pending
        .iter()
        .filter(|(_, p)| p.0 == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some((_, tx)) = pending.remove(&id) {
            let _ = tx.send(
                json!({"ok":false,"error":"脚本执行中网页发生导航，结果需核查","uncertain":true}),
            );
        }
    }
    drop(pending);
    if active_recording(app, session_id).is_none() {
        return;
    }
    let _ = transaction(app, |db| {
        if let Some(r) = db
            .recordings
            .iter_mut()
            .find(|r| r.session_id == session_id && r.capture_state == "recording")
        {
            if r.events.len() >= 10000 {
                return Ok(());
            }
            r.events.push(json!({"id":id(),"sequence":r.events.len()+1,"at":now(),"kind":"navigation","actor":"browser","pageUrl":url,"sessionId":session_id}));
        }
        Ok(())
    });
}
pub fn interrupt_recording(app: &AppHandle, session_id: &str, reason: &str) {
    let _ = transaction(app, |db| {
        for r in &mut db.recordings {
            if r.session_id == session_id && r.capture_state == "recording" {
                r.capture_state = "interrupted".into();
                r.ended_at = Some(now());
                r.limitations.push(reason.into());
            }
        }
        Ok(())
    });
}
fn archive(db: &mut Database, flow_id: &str, args: &Value) -> Result<Value, String> {
    let knowledge: Knowledge =
        serde_json::from_value(args.get("knowledge").cloned().ok_or("缺少归档知识")?)
            .map_err(|e| e.to_string())?;
    let scripts: Vec<FlowScript> =
        serde_json::from_value(args.get("scripts").cloned().unwrap_or(json!([])))
            .map_err(|e| e.to_string())?;
    validate_package(&knowledge, &scripts)?;
    let submitted_by = text(args, "submittedBy")?;
    name_ok(submitted_by)?;
    let flow = db
        .flows
        .iter()
        .find(|f| f.id == flow_id)
        .ok_or("没有找到流程")?;
    if args.get("expectedRevision").and_then(Value::as_u64) != Some(flow.revision as u64) {
        return Err("流程版本冲突，请重新读取后提交".into());
    }
    if db
        .recordings
        .iter()
        .any(|r| r.flow_id == flow_id && r.capture_state == "recording")
    {
        return Err("请结束录制后再归档".into());
    }
    let sources: Vec<String> = serde_json::from_value(
        args.get("sourceRecordingIds")
            .cloned()
            .unwrap_or(json!(flow.recording_ids)),
    )
    .map_err(|e| e.to_string())?;
    if sources.iter().any(|id| !flow.recording_ids.contains(id)) {
        return Err("来源录制不属于该流程".into());
    }
    if flow.origin == "human_recording" && sources.is_empty() {
        return Err("录制归档必须关联原始记录".into());
    }
    let revision = ArchivedRevision {
        id: id(),
        flow_id: flow_id.into(),
        version: db
            .archived_revisions
            .iter()
            .filter(|r| r.flow_id == flow_id)
            .map(|r| r.version)
            .max()
            .unwrap_or(0)
            + 1,
        knowledge,
        scripts,
        source_recording_ids: sources,
        source_notes: args["sourceNotes"].as_str().unwrap_or("").into(),
        submitted_by: submitted_by.into(),
        verification: "unverified".into(),
        created_at: now(),
    };
    let flow = db.flows.iter_mut().find(|f| f.id == flow_id).unwrap();
    flow.archive_state = "archived".into();
    flow.current_archived_revision_id = Some(revision.id.clone());
    flow.updated_at = now();
    flow.revision += 1;
    let result = json!({"flow":flow,"archivedRevision":revision});
    db.archived_revisions.push(revision);
    Ok(result)
}
fn revision<'a>(db: &'a Database, args: &Value) -> Result<&'a ArchivedRevision, String> {
    let flow_id = text(args, "flowId")?;
    let version = args["version"].as_u64();
    db.archived_revisions
        .iter()
        .filter(|r| r.flow_id == flow_id && version.is_none_or(|v| v == r.version as u64))
        .max_by_key(|r| r.version)
        .ok_or("没有找到归档版本".into())
}

pub async fn dispatch(app: &AppHandle, name: &str, args: Value) -> Result<Value, String> {
    let core = app.state::<Core>();
    match name {
        "browser_bind_domain" => {
            let sid = text(&args, "sessionId")?;
            let did = text(&args, "domainId")?;
            if active_recording(app, sid).is_some() {
                return Err("录制期间不能更改 业务空间".into());
            }
            let gate = core.gate(sid);
            let _guard = gate.try_lock().map_err(|_| "网页已有任务占用")?;
            if !core.db.lock().unwrap().domains.iter().any(|d| d.id == did) {
                return Err("没有找到 业务空间".into());
            }
            let mut sessions = core.sessions.lock().unwrap();
            let s = sessions.get_mut(sid).ok_or("网页已关闭")?;
            s.domain_id = Some(did.into());
            let result = json!(s);
            drop(sessions);
            core::changed(app);
            Ok(result)
        }
        "domain_list" => Ok(json!({"domains":core.db.lock().unwrap().domains})),
        "domain_get" => Ok(json!(core
            .db
            .lock()
            .unwrap()
            .domains
            .iter()
            .find(|d| Some(d.id.as_str()) == args["domainId"].as_str())
            .ok_or("没有找到 业务空间")?)),
        "domain_create" | "domain_update" => transaction(app, |db| {
            let name_value = text(&args, "name")?;
            name_ok(name_value)?;
            let websites: Option<Vec<Website>> = args
                .get("websites")
                .map(|v| serde_json::from_value(v.clone()).map_err(|e| e.to_string()))
                .transpose()?;
            if let Some(w) = &websites {
                validate_websites(w)?;
            }
            if name == "domain_create" {
                let d = Domain {
                    id: id(),
                    name: name_value.into(),
                    description: args["description"].as_str().unwrap_or("").into(),
                    websites: websites.unwrap_or_default(),
                    created_at: now(),
                    updated_at: now(),
                };
                db.domains.push(d.clone());
                Ok(json!(d))
            } else {
                let d = db
                    .domains
                    .iter_mut()
                    .find(|d| Some(d.id.as_str()) == args["domainId"].as_str())
                    .ok_or("没有找到 业务空间")?;
                d.name = name_value.into();
                if let Some(desc) = args["description"].as_str() {
                    d.description = desc.into();
                }
                if let Some(w) = websites {
                    d.websites = w;
                }
                d.updated_at = now();
                Ok(json!(d))
            }
        }),
        "recording_list" => {
            let db = core.db.lock().unwrap();
            let recordings:Vec<Value>=db.recordings.iter().filter(|r|args["domainId"].as_str().is_none_or(|d|r.domain_id==d)).rev().map(|r|json!({"id":r.id,"flowId":r.flow_id,"domainId":r.domain_id,"sessionId":r.session_id,"captureState":r.capture_state,"startedAt":r.started_at,"endedAt":r.ended_at,"eventCount":r.events.len(),"entryUrl":r.entry_url,"limitations":r.limitations})).collect();
            Ok(json!({"recordings":recordings}))
        }
        "recording_get" => {
            let db = core.db.lock().unwrap();
            let r = db
                .recordings
                .iter()
                .find(|r| Some(r.id.as_str()) == args["recordingId"].as_str())
                .ok_or("没有找到录制")?;
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let limit = args["limit"].as_u64().unwrap_or(100).clamp(1, 500) as usize;
            let mut value = json!(r);
            value["events"] = json!(r.events.iter().skip(offset).take(limit).collect::<Vec<_>>());
            value["totalEvents"] = json!(r.events.len());
            value["nextOffset"] = if offset + limit < r.events.len() {
                json!(offset + limit)
            } else {
                Value::Null
            };
            Ok(value)
        }
        "recording_status" => core::evaluate_js(
            app,
            text(&args, "sessionId")?,
            "JSON.stringify({ok:true,recorder:window.__AUTO_BROWSER_RECORDER__?.status()||null})"
                .into(),
        )
        .await,
        "recording_start" => {
            let session_id = text(&args, "sessionId")?;
            let domain_id = text(&args, "domainId")?;
            let name_value = text(&args, "name")?;
            name_ok(name_value)?;
            let gate = core.gate(session_id);
            let _guard = gate.try_lock().map_err(|_| "网页已有任务占用")?;
            let session = core
                .sessions
                .lock()
                .unwrap()
                .get(session_id)
                .cloned()
                .ok_or("网页已关闭")?;
            if session.domain_id.as_deref() != Some(domain_id) {
                return Err("先将目标网页绑定到该 业务空间".into());
            }
            let available = core::evaluate_js(
                app,
                session_id,
                "JSON.stringify({ok:true,available:!!window.__AUTO_BROWSER_RECORDER__})".into(),
            )
            .await?;
            if available["available"] != true {
                return Err("网页采集器未就绪，请等待页面加载后再开始录制".into());
            }
            let result = transaction(app, |db| {
                if !db.domains.iter().any(|d| d.id == domain_id) {
                    return Err("没有找到 业务空间".into());
                }
                if db
                    .recordings
                    .iter()
                    .any(|r| r.session_id == session_id && r.capture_state == "recording")
                {
                    return Err("该网页已在录制".into());
                }
                let flow_id = if let Some(flow_id) = args["flowId"].as_str() {
                    let flow = db
                        .flows
                        .iter()
                        .find(|f| {
                            f.id == flow_id
                                && f.domain_id == domain_id
                                && f.archive_state == "unarchived"
                        })
                        .ok_or("只能追加同一 业务空间 的未归档流程")?;
                    flow.id.clone()
                } else {
                    let f = new_flow(domain_id, name_value, "human_recording");
                    let fid = f.id.clone();
                    db.flows.push(f);
                    fid
                };
                let r = Recording {
                    id: id(),
                    flow_id: flow_id.clone(),
                    domain_id: domain_id.into(),
                    session_id: session_id.into(),
                    capture_state: "recording".into(),
                    started_at: now(),
                    ended_at: None,
                    entry_url: session.url,
                    events: vec![],
                    limitations: vec![
                        "当前录制覆盖顶层 DOM；iframe、Shadow DOM、文件内容和原生弹窗尚未采集"
                            .into(),
                    ],
                };
                let flow = db.flows.iter_mut().find(|f| f.id == flow_id).unwrap();
                flow.recording_ids.push(r.id.clone());
                flow.updated_at = now();
                flow.revision += 1;
                db.recordings.push(r.clone());
                Ok(json!(r))
            })?;
            if let Err(e)=core::evaluate_js(app,session_id,format!("(() => {{window.__AUTO_BROWSER_RECORDER__.configure({});return JSON.stringify({{ok:true}})}})()",json!(result["id"]))).await {
                interrupt_recording(app,session_id,"采集器无法启动"); return Err(e);
            }
            for _ in 0..50 {
                if core
                    .db
                    .lock()
                    .unwrap()
                    .recordings
                    .iter()
                    .any(|r| Some(r.id.as_str()) == result["id"].as_str() && !r.events.is_empty())
                {
                    return Ok(result);
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            interrupt_recording(
                app,
                session_id,
                "录制启动时未收到页面上下文，上报通道需核查",
            );
            Err("录制启动失败：没有收到网页事件，请重新加载后重试".into())
        }
        "recording_stop" => {
            let recording_id = text(&args, "recordingId")?;
            let sid = core
                .db
                .lock()
                .unwrap()
                .recordings
                .iter()
                .find(|r| r.id == recording_id && r.capture_state == "recording")
                .map(|r| r.session_id.clone())
                .ok_or("录制已结束或不存在")?;
            let _ = core::view(app, &sid)?.eval("window.__AUTO_BROWSER_RECORDER__?.stop()");
            // flush() waits for native receipt, then completes capture atomically.
            let result = core::evaluate_js(
                app,
                &sid,
                "JSON.stringify({ok:true,recorderAvailable:!!window.__AUTO_BROWSER_RECORDER__})"
                    .into(),
            )
            .await?;
            if result["recorderAvailable"] != true {
                return Err("采集器不可用，录制仍保留以便核查".into());
            }
            // The stop message itself completes the recording after queued events arrive.
            for _ in 0..250 {
                let done = core
                    .db
                    .lock()
                    .unwrap()
                    .recordings
                    .iter()
                    .find(|r| r.id == recording_id)
                    .filter(|r| r.capture_state != "recording")
                    .cloned();
                if let Some(r) = done {
                    return Ok(json!(r));
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Err("等待录制保存超时，请查询录制状态".into())
        }
        "flow_list" => {
            let db = core.db.lock().unwrap();
            let query = args["query"].as_str().unwrap_or("").to_lowercase();
            let mut list: Vec<_> = db
                .flows
                .iter()
                .filter(|f| {
                    args["domainId"].as_str().is_none_or(|d| f.domain_id == d)
                        && args["archiveState"]
                            .as_str()
                            .is_none_or(|s| f.archive_state == s)
                        && format!("{} {} {}", f.name, f.description, f.tags.join(" "))
                            .to_lowercase()
                            .contains(&query)
                })
                .collect();
            list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let limit = args["limit"].as_u64().unwrap_or(100).clamp(1, 500) as usize;
            Ok(
                json!({"flows":list.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":list.len(),"nextOffset":if offset+limit<list.len(){Some(offset+limit)}else{None}}),
            )
        }
        "flow_get" => {
            let db = core.db.lock().unwrap();
            let fid = text(&args, "flowId")?;
            let f = db
                .flows
                .iter()
                .find(|f| f.id == fid)
                .ok_or("没有找到流程")?;
            let revisions:Vec<_>=db.archived_revisions.iter().filter(|r|r.flow_id==fid).map(|r|json!({"id":r.id,"version":r.version,"createdAt":r.created_at,"scriptCount":r.scripts.len(),"submittedBy":r.submitted_by})).collect();
            let recs:Vec<_>=db.recordings.iter().filter(|r|r.flow_id==fid).map(|r| {
                let mut metadata = json!({"id":r.id,"captureState":r.capture_state,"eventCount":r.events.len(),"startedAt":r.started_at,"limitations":r.limitations});
                if f.archive_state == "unarchived" {
                    metadata["summary"] = recording_summary(&r.events);
                }
                metadata
            }).collect();
            let mut current = if args.get("version").is_some() {
                Some(revision(&db, &args)?.clone())
            } else {
                f.current_archived_revision_id
                    .as_ref()
                    .and_then(|id| db.archived_revisions.iter().find(|r| &r.id == id))
                    .cloned()
            };
            if let Some(r) = &mut current {
                for s in &mut r.scripts {
                    s.content.clear();
                }
            }
            Ok(json!({"flow":f,"archivedRevision":current,"revisions":revisions,"recordings":recs}))
        }
        "flow_archive" => transaction(app, |db| archive(db, text(&args, "flowId")?, &args)),
        "flow_create_archived" => transaction(app, |db| {
            let domain_id = text(&args, "domainId")?;
            if !db.domains.iter().any(|d| d.id == domain_id) {
                return Err("没有找到 业务空间".into());
            }
            let name_value = text(&args, "name")?;
            name_ok(name_value)?;
            let mut f = new_flow(domain_id, name_value, "agent_generated");
            f.description = args["description"].as_str().unwrap_or("").into();
            f.tags = serde_json::from_value(args.get("tags").cloned().unwrap_or(json!([])))
                .map_err(|e| e.to_string())?;
            let fid = f.id.clone();
            db.flows.push(f);
            let mut submit = args.clone();
            submit["expectedRevision"] = json!(1);
            submit["sourceRecordingIds"] = json!([]);
            archive(db, &fid, &submit)
        }),
        "flow_script_get" => {
            let db = core.db.lock().unwrap();
            let r = revision(&db, &args)?;
            Ok(json!(r
                .scripts
                .iter()
                .find(|s| Some(s.id.as_str()) == args["scriptId"].as_str())
                .ok_or("没有找到脚本")?))
        }
        "flow_script_run" => run_script(app, &args).await,
        "script_run_list" => {
            let db = core.db.lock().unwrap();
            let list:Vec<_>=db.script_runs.iter().rev().map(|r|json!({"id":r.id,"flowId":r.flow_id,"name":db.flows.iter().find(|f|f.id==r.flow_id).map(|f|f.name.clone()).unwrap_or_default(),"scriptId":r.script_id,"version":r.version,"sessionId":r.session_id,"status":r.status,"startedAt":r.started_at,"finishedAt":r.finished_at,"error":r.error})).collect();
            Ok(json!({"runs":list}))
        }
        "script_run_get" => Ok(json!(core
            .db
            .lock()
            .unwrap()
            .script_runs
            .iter()
            .find(|r| Some(r.id.as_str()) == args["scriptRunId"].as_str())
            .ok_or("没有找到脚本执行")?)),
        "flow_export" => {
            let db = core.db.lock().unwrap();
            let fid = text(&args, "flowId")?;
            let f = db
                .flows
                .iter()
                .find(|f| f.id == fid)
                .ok_or("没有找到流程")?;
            Ok(
                json!({"format":"auto-browser-flow","version":1,"flow":f,"archivedRevisions":db.archived_revisions.iter().filter(|r|r.flow_id==fid).collect::<Vec<_>>(),"recordings":db.recordings.iter().filter(|r|r.flow_id==fid).collect::<Vec<_>>()}),
            )
        }
        "flow_import" => import_package(app, &args),
        _ => Err("未知工作流程工具".into()),
    }
}

async fn run_script(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let core = app.state::<Core>();
    let sid = text(args, "sessionId")?.to_string();
    let (flow, archived, script) = {
        let db = core.db.lock().unwrap();
        let r = revision(&db, args)?.clone();
        let f = db
            .flows
            .iter()
            .find(|f| f.id == r.flow_id)
            .cloned()
            .ok_or("没有找到流程")?;
        let script = r
            .scripts
            .iter()
            .find(|s| Some(s.id.as_str()) == args["scriptId"].as_str())
            .cloned()
            .ok_or("没有找到脚本")?;
        (f, r, script)
    };
    if args["version"].as_u64() != Some(archived.version as u64) {
        return Err("执行必须指定明确归档版本".into());
    }
    if core
        .sessions
        .lock()
        .unwrap()
        .get(&sid)
        .and_then(|s| s.domain_id.as_deref())
        != Some(flow.domain_id.as_str())
    {
        return Err("目标网页不属于流程的 业务空间，请先绑定网页".into());
    }
    let inputs = inputs_for(
        &script.inputs,
        args.get("inputs").unwrap_or(&json!({})),
        true,
    )?;
    let timeout = args["timeoutMs"].as_u64().unwrap_or(15000).clamp(50, 30000);
    let guard = core
        .gate(&sid)
        .try_lock_owned()
        .map_err(|_| "该网页已有任务占用")?;
    let run = ScriptRun {
        id: id(),
        flow_id: flow.id,
        version: archived.version,
        script_id: script.id,
        session_id: sid.clone(),
        status: "running".into(),
        started_at: now(),
        finished_at: None,
        result: None,
        error: None,
    };
    let rid = run.id.clone();
    transaction(app, |db| {
        db.script_runs.push(run);
        Ok(())
    })?;
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    core.pending_scripts
        .lock()
        .unwrap()
        .insert(rid.clone(), (sid.clone(), tx));
    let js = format!(
        r#"(() => {{
      const requestId={request}, inputs={inputs}, controller=new AbortController();
      const recorder=window.__AUTO_BROWSER_RECORDER__;
      recorder?.setActor('agent');
      const timer=setTimeout(()=>controller.abort(),{timeout});
      (async()=>{{
        let result;
        try {{ const data=await (async function(inputs,signal){{{code}
}})(inputs,controller.signal);
          const encoded=JSON.stringify(data===undefined?null:data); if(encoded.length>60000)throw new Error('脚本结果超过 60 KB'); result={{ok:true,data:JSON.parse(encoded)}};
        }} catch(e) {{result={{ok:false,error:String(e.message||e)}};}}
        finally {{clearTimeout(timer);recorder?.setActor('user');}}
        try {{ await window.__TAURI_INTERNALS__.invoke('page_message',{{message:{{kind:'script_result',requestId,result}}}}); }} catch(e) {{console.error('Auto Browser result delivery failed',e);}}
      }})(); return JSON.stringify({{ok:true,started:true}});
    }})()"#,
        request = json!(rid),
        inputs = inputs,
        timeout = timeout,
        code = script.content
    );
    if let Err(e) = core::evaluate_js(app, &sid, js).await {
        core.pending_scripts.lock().unwrap().remove(&rid);
        finish_script(app, &rid, json!({"ok":false,"error":e}));
        return Ok(json!({"scriptRunId":rid,"status":"failed"}));
    }
    let task_app = app.clone();
    let task_id = rid.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        match tokio::time::timeout(std::time::Duration::from_millis(timeout), &mut rx).await {
            Ok(Ok(result)) => finish_script(&task_app, &task_id, result),
            Ok(Err(_)) => finish_script(
                &task_app,
                &task_id,
                json!({"ok":false,"error":"脚本结果回调中断","uncertain":true}),
            ),
            Err(_) => {
                let _ = transaction(&task_app, |db| {
                    if let Some(r) = db.script_runs.iter_mut().find(|r| r.id == task_id) {
                        r.status = "uncertain".into();
                        r.error=Some("脚本超时，已发送终止信号；仍占用网页直到脚本返回或页面重新加载。请先核查结果，勿重复提交。".into());
                    }
                    Ok(())
                });
                // Keep the per-page lock: JS promises cannot be forcibly cancelled.
                if let Ok(result) = rx.await {
                    finish_script(&task_app, &task_id, result);
                }
            }
        }
    });
    Ok(json!({"scriptRunId":rid,"status":"running"}))
}
fn finish_script(app: &AppHandle, rid: &str, result: Value) {
    let _ = transaction(app, |db| {
        if let Some(r) = db.script_runs.iter_mut().find(|r| r.id == rid) {
            let timed_out = r.status == "uncertain";
            r.status = if result["uncertain"] == true {
                "uncertain"
            } else if result["ok"] == true && !timed_out {
                "succeeded"
            } else {
                "failed"
            }
            .into();
            r.result = Some(result.clone());
            r.finished_at = Some(now());
            if timed_out {
                r.error = Some("此前已超时；脚本现已结束，请核查实际业务结果。".into());
            } else {
                r.error = result["error"].as_str().map(String::from);
            }
        }
        Ok(())
    });
}
fn prepare_import(args: &Value) -> Result<(Flow, Vec<Recording>, Vec<ArchivedRevision>), String> {
    let package = args.get("package").ok_or("缺少工作包")?;
    if package["format"] != "auto-browser-flow" || package["version"] != 1 {
        return Err("不支持的工作包格式".into());
    }
    if package.to_string().len() > 20_000_000 {
        return Err("工作包超过 20 MB".into());
    }
    let mut flow: Flow =
        serde_json::from_value(package["flow"].clone()).map_err(|e| e.to_string())?;
    let mut revisions: Vec<ArchivedRevision> =
        serde_json::from_value(package["archivedRevisions"].clone()).map_err(|e| e.to_string())?;
    let mut recordings: Vec<Recording> =
        serde_json::from_value(package["recordings"].clone()).map_err(|e| e.to_string())?;
    name_ok(&flow.name)?;
    if !["unarchived", "archived"].contains(&flow.archive_state.as_str())
        || !["human_recording", "agent_generated"].contains(&flow.origin.as_str())
    {
        return Err("工作包状态或来源无效".into());
    }
    let old_fid = flow.id.clone();
    let old_current = flow.current_archived_revision_id.clone();
    let mut ids = std::collections::HashMap::new();
    for r in &recordings {
        if r.flow_id != old_fid || ids.insert(r.id.clone(), id()).is_some() {
            return Err("原始录制关联无效".into());
        }
    }
    if flow.recording_ids.iter().any(|id| !ids.contains_key(id))
        || flow.recording_ids.len() != ids.len()
    {
        return Err("工作包缺少来源录制".into());
    }
    let mut versions = std::collections::HashSet::new();
    let mut revision_ids = std::collections::HashMap::new();
    for r in &revisions {
        validate_package(&r.knowledge, &r.scripts)?;
        if (flow.origin == "human_recording" && r.source_recording_ids.is_empty())
            || r.version == 0
            || r.verification != "unverified"
        {
            return Err("归档来源或版本声明无效".into());
        }
        if r.flow_id != old_fid
            || !versions.insert(r.version)
            || r.source_recording_ids
                .iter()
                .any(|id| !ids.contains_key(id))
            || revision_ids.insert(r.id.clone(), id()).is_some()
        {
            return Err("归档包版本或来源关联无效".into());
        }
    }
    if flow.archive_state == "archived"
        && old_current
            .as_ref()
            .is_none_or(|id| !revision_ids.contains_key(id))
    {
        return Err("工作包缺少当前归档版本".into());
    }
    if flow.archive_state == "unarchived" && (!revisions.is_empty() || old_current.is_some()) {
        return Err("未归档工作包不可包含归档版本".into());
    }
    flow.id = id();
    flow.domain_id = text(args, "domainId")?.into();
    flow.recording_ids = flow
        .recording_ids
        .iter()
        .map(|id| ids[id].clone())
        .collect();
    flow.current_archived_revision_id = old_current.and_then(|id| revision_ids.get(&id).cloned());
    flow.created_at = now();
    flow.updated_at = now();
    flow.revision = 1;
    for r in &mut recordings {
        r.id = ids[&r.id].clone();
        r.flow_id = flow.id.clone();
        r.domain_id = flow.domain_id.clone();
        r.session_id.clear();
        if r.capture_state == "recording" {
            r.capture_state = "interrupted".into();
            r.limitations.push("导入的录制没有活动网页会话".into());
        }
    }
    for r in &mut revisions {
        r.id = revision_ids[&r.id].clone();
        r.flow_id = flow.id.clone();
        r.source_recording_ids = r
            .source_recording_ids
            .iter()
            .map(|id| ids[id].clone())
            .collect();
    }
    Ok((flow, recordings, revisions))
}
fn import_package(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let (flow, recordings, revisions) = prepare_import(args)?;
    transaction(app, |db| {
        if !db.domains.iter().any(|d| d.id == flow.domain_id) {
            return Err("没有找到目标 业务空间".into());
        }
        db.flows.push(flow.clone());
        db.recordings.extend(recordings);
        db.archived_revisions.extend(revisions);
        Ok(json!(flow))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recording_summary_keeps_order_without_values_context_or_focus_clicks() {
        let events = vec![
            json!({"kind":"page_context","afterContext":{"text":"private page"}}),
            json!({"kind":"click","target":{"tag":"input","label":"邮箱"}}),
            json!({"kind":"input","value":"private@example.test","target":{"tag":"input","label":"邮箱","selector":"#email"}}),
            json!({"kind":"change","value":"private@example.test","target":{"tag":"input","label":"邮箱","selector":"#email"}}),
            json!({"kind":"click","target":{"tag":"button","label":"保存客户"},"pageUrl":"https://example.test/?token=secret"}),
            json!({"kind":"submit","target":{"tag":"form","label":"private form contents"}}),
        ];
        let summary = recording_summary(&events);
        assert_eq!(summary["actionCount"], 3);
        assert_eq!(
            summary["steps"][0],
            json!({"order":1,"kind":"input","label":"邮箱"})
        );
        assert_eq!(summary["steps"][1]["label"], "保存客户");
        assert_eq!(summary["steps"][2]["label"], "表单");
        assert!(!summary.to_string().contains("private"));
        assert!(!summary.to_string().contains("secret"));
    }
    #[test]
    fn recording_summary_merges_the_submit_click_but_keeps_other_clicks() {
        let events = vec![
            json!({"kind":"click","target":{"tag":"button","type":"submit","label":"保存客户"}}),
            json!({"kind":"submit","target":{"tag":"form"}}),
            json!({"kind":"click","target":{"tag":"button","type":"button","label":"展开说明"}}),
            json!({"kind":"submit","target":{"tag":"form"}}),
        ];
        let summary = recording_summary(&events);
        assert_eq!(summary["actionCount"], 3);
        assert_eq!(
            summary["steps"][0],
            json!({"order":1,"kind":"submit","label":"保存客户"})
        );
        assert_eq!(summary["steps"][1]["label"], "展开说明");
        assert_eq!(summary["steps"][2]["label"], "表单");
    }
    #[test]
    fn recording_summary_bounds_preview_and_keeps_the_final_action() {
        let events: Vec<_> = (0..8)
            .map(|i| json!({"kind":"input","target":{"label":format!("字段{i}")}}))
            .chain([json!({"kind":"submit"})])
            .collect();
        let summary = recording_summary(&events);
        assert_eq!(summary["actionCount"], 9);
        assert_eq!(summary["steps"].as_array().unwrap().len(), 5);
        assert_eq!(summary["steps"][4]["order"], 9);
        assert_eq!(summary["steps"][4]["kind"], "submit");
        assert_eq!(summary["omittedActions"], 4);
        assert_eq!(recording_summary(&[])["actionCount"], 0);
        let repeated = vec![
            json!({"kind":"click","target":{"tag":"button","label":"保存"}}),
            json!({"kind":"click","target":{"tag":"button","label":"保存"}}),
            json!({"kind":"input","target":{"label":"同名字段","selector":"#first"}}),
            json!({"kind":"input","target":{"label":"同名字段","selector":"#second"}}),
        ];
        assert_eq!(recording_summary(&repeated)["actionCount"], 4);
    }
    fn fixture() -> (Database, String, String) {
        let mut db = Database::default();
        let mut f = new_flow("space", "客户管理", "human_recording");
        let rid = id();
        f.recording_ids.push(rid.clone());
        let fid = f.id.clone();
        db.recordings.push(Recording {
            id: rid.clone(),
            flow_id: fid.clone(),
            domain_id: "space".into(),
            session_id: "page".into(),
            capture_state: "completed".into(),
            started_at: now(),
            ended_at: Some(now()),
            entry_url: "https://example.com".into(),
            events: vec![json!({"kind":"input","value":"sample"})],
            limitations: vec![],
        });
        db.flows.push(f);
        (db, fid, rid)
    }
    fn submit() -> Value {
        json!({"expectedRevision":1,"submittedBy":"test agent","knowledge":{"purpose":"create customer","procedureMarkdown":"Observe and fill","judgementMarkdown":"Verify the saved record"},"scripts":[{"id":"fill","name":"Fill","content":"return {name:inputs.name};"}]})
    }
    #[test]
    fn archive_preserves_recording_and_versions_package_together() {
        let (mut db, fid, rid) = fixture();
        let original = json!(db.recordings);
        archive(&mut db, &fid, &submit()).unwrap();
        assert_eq!(json!(db.recordings), original);
        assert_eq!(db.flows[0].id, fid);
        assert_eq!(db.flows[0].archive_state, "archived");
        assert_eq!(db.archived_revisions[0].source_recording_ids, vec![rid]);
        assert_eq!(db.archived_revisions[0].verification, "unverified");
        let mut next = submit();
        next["expectedRevision"] = json!(2);
        next["scripts"][0]["content"] = json!("return 2;");
        archive(&mut db, &fid, &next).unwrap();
        assert_eq!(
            db.archived_revisions[0].scripts[0].content,
            "return {name:inputs.name};"
        );
        assert_eq!(db.archived_revisions[1].version, 2);
    }
    #[test]
    fn archive_rejects_conflicts_active_capture_and_foreign_sources_without_mutation() {
        let (mut db, fid, _) = fixture();
        let original = json!(db);
        let mut invalid = submit();
        invalid["expectedRevision"] = json!(99);
        assert!(archive(&mut db, &fid, &invalid).is_err());
        assert_eq!(json!(db), original);
        invalid = submit();
        invalid["sourceRecordingIds"] = json!(["foreign"]);
        assert!(archive(&mut db, &fid, &invalid).is_err());
        assert_eq!(json!(db), original);
        db.recordings[0].capture_state = "recording".into();
        assert!(archive(&mut db, &fid, &submit()).is_err());
        assert!(db.archived_revisions.is_empty());
    }
    #[test]
    fn generated_package_needs_no_recording_and_import_remaps_all_source_links() {
        let mut db = Database::default();
        let f = new_flow("space", "Generated", "agent_generated");
        let fid = f.id.clone();
        db.flows.push(f);
        archive(&mut db, &fid, &submit()).unwrap();
        assert!(db.archived_revisions[0].source_recording_ids.is_empty());
        let (mut db, fid, _) = fixture();
        archive(&mut db, &fid, &submit()).unwrap();
        let package = json!({"format":"auto-browser-flow","version":1,"flow":db.flows[0],"archivedRevisions":db.archived_revisions,"recordings":db.recordings});
        let (f, rs, vs) = prepare_import(&json!({"domainId":"other","package":package})).unwrap();
        assert_ne!(f.id, fid);
        assert_eq!(f.domain_id, "other");
        assert_eq!(rs[0].flow_id, f.id);
        assert_eq!(f.recording_ids[0], rs[0].id);
        assert_eq!(vs[0].source_recording_ids[0], rs[0].id);
        assert_eq!(f.current_archived_revision_id.as_ref(), Some(&vs[0].id));
        assert_eq!(rs[0].events, db.recordings[0].events);
        assert_eq!(
            vs[0].scripts[0].content,
            db.archived_revisions[0].scripts[0].content
        );
        let mut broken = package;
        broken["recordings"] = json!([]);
        assert!(prepare_import(&json!({"domainId":"other","package":broken})).is_err());
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub url: String,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub domain_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub selector: Option<String>,
    pub label: Option<String>,
    pub text: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    pub kind: String,
    #[serde(default)]
    pub target: Option<Target>,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub name: String,
    pub label: String,
    #[serde(default = "string_type")]
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}
fn string_type() -> String {
    "string".into()
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: u32,
    pub start_url: String,
    pub domain: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    pub steps: Vec<Step>,
    pub completion: Step,
    #[serde(default = "draft")]
    pub status: String,
    #[serde(default)]
    pub updated_at: String,
}
fn draft() -> String {
    "draft".into()
}

/// Context for an agent, never a list of commands for the replay executor.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Guide {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: u32,
    pub start_url: String,
    pub domain: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    pub content: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at: String,
    pub step: usize,
    pub description: String,
    pub result: Value,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub session_id: String,
    pub workflow_id: Option<String>,
    pub workflow_version: Option<u32>,
    pub name: String,
    pub status: String,
    pub current_step: usize,
    pub total_steps: usize,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub events: Vec<Event>,
    pub definition: Option<Workflow>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub session_id: String,
    pub url: String,
    pub steps: Vec<Step>,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub schema_version: u32,
    #[serde(default)]
    pub domains: Vec<crate::flow_model::Domain>,
    #[serde(default)]
    pub flows: Vec<crate::flow_model::Flow>,
    #[serde(default)]
    pub recordings: Vec<crate::flow_model::Recording>,
    #[serde(default)]
    pub archived_revisions: Vec<crate::flow_model::ArchivedRevision>,
    #[serde(default)]
    pub script_runs: Vec<crate::flow_model::ScriptRun>,
    #[serde(default)]
    pub delegate_tasks: Vec<crate::jev_model::DelegateTask>,
    #[serde(default)]
    pub guides: Vec<Guide>,
    #[serde(default)]
    pub workflows: Vec<Workflow>,
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(default)]
    pub traces: Vec<Trace>,
}

pub fn validate_guide(g: &Guide) -> Result<(), String> {
    if g.name.trim().is_empty() || g.name.chars().count() > 120 {
        return Err("指南名称不能为空且不超过 120 个字符".into());
    }
    if g.content.trim().is_empty() || g.content.len() > 100_000 {
        return Err("指南正文不能为空且不超过 100 KB".into());
    }
    if g.domain.trim().is_empty() {
        return Err("指南需要适用域名".into());
    }
    if g.start_url != "auto-browser://demo" {
        let url = tauri::Url::parse(&g.start_url).map_err(|_| "入口网址无效")?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str() != Some(g.domain.as_str()) {
            return Err("入口网址必须是指南域名下的 HTTP/HTTPS 页面".into());
        }
    }
    let mut names = std::collections::HashSet::new();
    for p in &g.parameters {
        if p.name.is_empty()
            || !p
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || !names.insert(&p.name)
        {
            return Err("参数名只能包含字母、数字、下划线，且不可重复".into());
        }
        if !["string", "number", "boolean"].contains(&p.kind.as_str()) {
            return Err("参数类型只支持 string / number / boolean".into());
        }
        if let Some(value) = &p.default {
            let valid = match p.kind.as_str() {
                "string" => value.is_string(),
                "number" => value.is_number(),
                "boolean" => value.is_boolean(),
                _ => false,
            };
            if !valid {
                return Err(format!("参数 {} 的默认值类型不符", p.name));
            }
        }
    }
    Ok(())
}

pub fn validate_workflow(w: &Workflow) -> Result<(), String> {
    if w.name.trim().is_empty() || w.name.len() > 120 {
        return Err("流程名称不能为空且不超过 120 个字符".into());
    }
    if w.steps.is_empty() || w.steps.len() > 100 {
        return Err("流程需要 1–100 个步骤".into());
    }
    if w.domain.is_empty() {
        return Err("流程需要适用域名".into());
    }
    if w.start_url != "auto-browser://demo" {
        let url = tauri::Url::parse(&w.start_url).map_err(|_| "入口网址无效")?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str() != Some(w.domain.as_str()) {
            return Err("入口网址必须是流程域名下的 HTTP/HTTPS 页面".into());
        }
    }
    let mut names = std::collections::HashSet::new();
    for p in &w.parameters {
        if p.name.is_empty()
            || !p
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || !names.insert(p.name.clone())
        {
            return Err("参数名只能包含字母、数字、下划线，且不可重复".into());
        }
        if !["string", "number", "boolean"].contains(&p.kind.as_str()) {
            return Err("参数类型只支持 string / number / boolean".into());
        }
    }
    for step in w.steps.iter().chain(std::iter::once(&w.completion)) {
        validate_step(step)?;
        if let Some(v) = &step.value {
            validate_refs(v, &names)?;
        }
    }
    if ![
        "assert_text",
        "assert_url",
        "assert_value",
        "assert_visible",
    ]
    .contains(&w.completion.kind.as_str())
    {
        return Err("完成条件必须是实际页面断言".into());
    }
    Ok(())
}

pub fn validate_step(step: &Step) -> Result<(), String> {
    let kinds = [
        "click",
        "fill",
        "select",
        "check",
        "press",
        "scroll",
        "wait",
        "assert_text",
        "assert_url",
        "assert_value",
        "assert_visible",
    ];
    if !kinds.contains(&step.kind.as_str()) {
        return Err(format!("不支持的操作：{}", step.kind));
    }
    if [
        "click",
        "fill",
        "select",
        "check",
        "assert_value",
        "assert_visible",
    ]
    .contains(&step.kind.as_str())
        && step.target.is_none()
    {
        return Err("该操作需要 target 定位信息".into());
    }
    if let Some(t) = &step.target {
        let count = [&t.selector, &t.label, &t.text]
            .iter()
            .filter(|s| s.as_ref().is_some_and(|s| !s.is_empty()))
            .count();
        if count != 1 {
            return Err("target 必须且只能指定 selector、label、text 中的一项".into());
        }
    }
    if [
        "fill",
        "select",
        "check",
        "press",
        "scroll",
        "wait",
        "assert_text",
        "assert_url",
        "assert_value",
    ]
    .contains(&step.kind.as_str())
        && step.value.is_none()
    {
        return Err("该操作需要 value".into());
    }
    Ok(())
}

fn validate_refs(v: &Value, names: &std::collections::HashSet<String>) -> Result<(), String> {
    if let Some(s) = v.as_str() {
        let mut tail = s;
        while let Some(i) = tail.find("${") {
            let rest = &tail[i + 2..];
            let end = rest.find('}').ok_or("参数引用未闭合")?;
            if !names.contains(&rest[..end]) {
                return Err(format!("未声明参数：{}", &rest[..end]));
            }
            tail = &rest[end + 1..];
        }
    }
    Ok(())
}

pub fn resolve_step(step: &Step, w: &Workflow, inputs: &Value) -> Result<Step, String> {
    let mut out = step.clone();
    let mut values = std::collections::HashMap::new();
    for p in &w.parameters {
        let v = inputs.get(&p.name).cloned().or_else(|| p.default.clone());
        if p.required
            && v.as_ref()
                .is_none_or(|v| v.is_null() || v.as_str() == Some(""))
        {
            return Err(format!("缺少必填参数：{}", p.label));
        }
        if let Some(v) = v {
            let valid = match p.kind.as_str() {
                "number" => v.is_number(),
                "boolean" => v.is_boolean(),
                _ => v.is_string(),
            };
            if !valid {
                return Err(format!("参数类型错误：{}（{}）", p.name, p.kind));
            }
            values.insert(p.name.clone(), v);
        }
    }
    if let Some(Value::String(s)) = &step.value {
        let mut result = s.clone();
        for (name, v) in &values {
            let marker = format!("${{{name}}}");
            if s == &marker {
                out.value = Some(v.clone());
                return Ok(out);
            }
            let text = v
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string());
            result = result.replace(&marker, &text);
        }
        if result.contains("${") {
            return Err("步骤使用了没有输入值的参数".into());
        }
        out.value = Some(Value::String(result));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn flow() -> Workflow {
        serde_json::from_str(include_str!("../../examples/demo-workflow.json")).unwrap()
    }
    #[test]
    fn parameterization_preserves_types_and_requires_inputs() {
        let w = flow();
        validate_workflow(&w).unwrap();
        assert!(resolve_step(&w.steps[0], &w, &serde_json::json!({})).is_err());
        let step = resolve_step(
            &w.steps[0],
            &w,
            &serde_json::json!({"name":"张三","email":"a@b.cn"}),
        )
        .unwrap();
        assert_eq!(step.value, Some(serde_json::json!("张三")));
    }
    #[test]
    fn rejects_missing_completion_and_undeclared_parameters() {
        let mut w = flow();
        w.completion.kind = "click".into();
        assert!(validate_workflow(&w).is_err());
        let mut w = flow();
        w.steps[0].value = Some(serde_json::json!("${unknown}"));
        assert!(validate_workflow(&w).is_err());
    }
    #[test]
    fn requires_unambiguous_targets() {
        let mut w = flow();
        w.steps[0].target.as_mut().unwrap().text = Some("x".into());
        assert!(validate_workflow(&w).is_err());
    }
    #[test]
    fn guide_accepts_semantic_instructions_and_checks_site_and_inputs() {
        let mut g: Guide =
            serde_json::from_str(include_str!("../../examples/customer-guide.json")).unwrap();
        validate_guide(&g).unwrap();
        // Human-readable prose needs no DOM selectors, executable steps, or ${} substitution.
        g.content = "观察当前页面，找到客户表单，填写本次姓名并验证保存结果。".into();
        validate_guide(&g).unwrap();
        g.start_url = "https://unrelated.example/form".into();
        assert!(validate_guide(&g).is_err());
        g.start_url = "auto-browser://demo".into();
        g.parameters[0].default = Some(serde_json::json!(123));
        assert!(validate_guide(&g).is_err());
    }
}

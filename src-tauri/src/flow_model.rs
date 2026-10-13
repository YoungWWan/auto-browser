use crate::model::{id, now, Parameter};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Website {
    pub id: String,
    pub name: String,
    pub entry_url: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    pub id: String,
    pub name: String,
    pub description: String,
    pub websites: Vec<Website>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: String,
    pub domain_id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub archive_state: String,
    pub origin: String,
    pub recording_ids: Vec<String>,
    pub current_archived_revision_id: Option<String>,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub flow_id: String,
    pub domain_id: String,
    pub session_id: String,
    pub capture_state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub entry_url: String,
    pub events: Vec<Value>,
    pub limitations: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Knowledge {
    pub purpose: String,
    #[serde(default)]
    pub inputs: Vec<Parameter>,
    pub procedure_markdown: String,
    pub judgement_markdown: String,
    #[serde(default)]
    pub prerequisites_markdown: String,
    #[serde(default)]
    pub exceptions_markdown: String,
    #[serde(default)]
    pub outputs: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowScript {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub inputs: Vec<Parameter>,
    #[serde(default)]
    pub usage_markdown: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedRevision {
    pub id: String,
    pub flow_id: String,
    pub version: u32,
    pub knowledge: Knowledge,
    pub scripts: Vec<FlowScript>,
    pub source_recording_ids: Vec<String>,
    pub source_notes: String,
    pub submitted_by: String,
    pub verification: String,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    pub id: String,
    pub flow_id: String,
    pub version: u32,
    pub script_id: String,
    pub session_id: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

pub fn name_ok(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 120 {
        return Err("名称需要 1–120 个字符".into());
    }
    Ok(())
}
pub fn validate_websites(websites: &[Website]) -> Result<(), String> {
    if websites.len() > 30 {
        return Err("一个 业务空间 最多保存 30 个网站入口".into());
    }
    let mut ids = std::collections::HashSet::new();
    for w in websites {
        name_ok(&w.name)?;
        if w.id.is_empty() || !ids.insert(&w.id) {
            return Err("网站入口 ID 必须唯一且不能为空".into());
        }
        if w.entry_url == "auto-browser://demo" {
            continue;
        }
        let url = tauri::Url::parse(&w.entry_url).map_err(|_| "网站入口网址无效")?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("网站入口只支持不含嵌入凭据的 HTTP/HTTPS 网址".into());
        }
    }
    Ok(())
}
pub fn inputs_for(
    parameters: &[Parameter],
    inputs: &Value,
    require_values: bool,
) -> Result<Value, String> {
    if !inputs.is_object() {
        return Err("inputs 必须是对象".into());
    }
    let mut names = std::collections::HashSet::new();
    let mut out = serde_json::Map::new();
    for p in parameters {
        if p.name.is_empty()
            || !p
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || !names.insert(&p.name)
        {
            return Err("输入名称只能包含字母、数字、下划线且不可重复".into());
        }
        if !["string", "number", "boolean"].contains(&p.kind.as_str()) {
            return Err("输入类型只支持 string / number / boolean".into());
        }
        let value = inputs.get(&p.name).cloned().or_else(|| p.default.clone());
        if require_values
            && p.required
            && value
                .as_ref()
                .is_none_or(|v| v.is_null() || v.as_str() == Some(""))
        {
            return Err(format!("缺少必填输入：{}", p.label));
        }
        if let Some(v) = value {
            let valid = match p.kind.as_str() {
                "number" => v.is_number(),
                "boolean" => v.is_boolean(),
                _ => v.is_string(),
            };
            if !valid {
                return Err(format!("输入类型错误：{}", p.name));
            }
            out.insert(p.name.clone(), v);
        }
    }
    // Preserve additional context without interpolating it into JavaScript source.
    for (k, v) in inputs.as_object().unwrap() {
        out.entry(k.clone()).or_insert(v.clone());
    }
    Ok(Value::Object(out))
}
pub fn validate_package(k: &Knowledge, scripts: &[FlowScript]) -> Result<(), String> {
    for text in [&k.purpose, &k.procedure_markdown, &k.judgement_markdown] {
        if text.trim().is_empty() || text.len() > 100_000 {
            return Err("归档需要操作目的、通用步骤和判断条件，每项不超过 100 KB".into());
        }
    }
    inputs_for(&k.inputs, &serde_json::json!({}), false)?;
    if scripts.len() > 50 {
        return Err("一个归档包最多包含 50 个脚本".into());
    }
    let mut ids = std::collections::HashSet::new();
    for s in scripts {
        name_ok(&s.name)?;
        if s.id.is_empty()
            || !ids.insert(&s.id)
            || s.content.trim().is_empty()
            || s.content.len() > 100_000
        {
            return Err("脚本 ID 必须唯一，正文需要 1–100 KB".into());
        }
        inputs_for(&s.inputs, &serde_json::json!({}), false)?;
    }
    Ok(())
}
pub fn new_flow(domain_id: &str, name: &str, origin: &str) -> Flow {
    Flow {
        id: id(),
        domain_id: domain_id.into(),
        name: name.into(),
        description: String::new(),
        tags: vec![],
        archive_state: "unarchived".into(),
        origin: origin.into(),
        recording_ids: vec![],
        current_archived_revision_id: None,
        revision: 1,
        created_at: now(),
        updated_at: now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn script_input_types_defaults_and_missing_values() {
        let p = Parameter {
            name: "enabled".into(),
            label: "开关".into(),
            kind: "boolean".into(),
            required: true,
            default: Some(Value::Bool(false)),
        };
        assert_eq!(
            inputs_for(&[p.clone()], &serde_json::json!({}), true).unwrap()["enabled"],
            false
        );
        assert!(inputs_for(&[p.clone()], &serde_json::json!({"enabled":"false"}), true).is_err());
        let mut p = p;
        p.default = None;
        assert!(inputs_for(&[p], &serde_json::json!({}), true).is_err());
    }
}

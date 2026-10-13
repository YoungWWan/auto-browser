use crate::model::*;
use std::{fs, io::Write, path::Path};

pub fn load(path: &Path) -> Result<Database, String> {
    if !path.exists() {
        return Ok(Database {
            schema_version: 1,
            ..Default::default()
        });
    }
    let db: Database = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("无法读取本地数据，原文件已保留：{e}"))?;
    if db.schema_version != 1 {
        return Err("不支持的数据版本，原文件已保留".into());
    }
    let original = fs::read(path).map_err(|e| e.to_string())?;
    let fields: serde_json::Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
    let backup = path.with_file_name("store.before-domain-model.json");
    if fields.get("domains").is_none() && !backup.exists() {
        atomic_write(&backup, &original)?;
    }
    Ok(db)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无效数据路径")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn save(path: &Path, db: &Database) -> Result<(), String> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(db).map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn store_roundtrip_and_corruption_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        let db = Database {
            schema_version: 1,
            workflows: vec![serde_json::from_str(include_str!(
                "../../examples/demo-workflow.json"
            ))
            .unwrap()],
            ..Default::default()
        };
        save(&path, &db).unwrap();
        assert_eq!(load(&path).unwrap().workflows.len(), 1);
        save(&path, &db).unwrap();
        assert_eq!(load(&path).unwrap().schema_version, 1);
        std::fs::write(&path, b"broken").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
    }
    #[test]
    fn adding_guides_preserves_legacy_workflows_and_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        let workflow: Workflow =
            serde_json::from_str(include_str!("../../examples/demo-workflow.json")).unwrap();
        let mut legacy =
            serde_json::json!({"schemaVersion":1,"workflows":[workflow],"runs":[],"traces":[]});
        // The original application database has no guides field.
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut db = load(&path).unwrap();
        assert!(db.guides.is_empty());
        assert!(db.domains.is_empty());
        assert!(db.flows.is_empty());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(path.with_file_name("store.before-domain-model.json")).unwrap()
            )
            .unwrap(),
            legacy
        );
        db.guides.push(
            serde_json::from_str(include_str!("../../examples/customer-guide.json")).unwrap(),
        );
        save(&path, &db).unwrap();
        let restored = load(&path).unwrap();
        assert_eq!(restored.guides.len(), 1);
        assert_eq!(
            serde_json::to_value(&restored.workflows).unwrap(),
            legacy["workflows"]
        );
        assert_eq!(restored.schema_version, 1);
        // Unknown future formats must still be rejected without overwriting them.
        legacy["schemaVersion"] = serde_json::json!(99);
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(load(&path).is_err());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            legacy
        );
    }
}

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "tool_call",
            "workspace_layout",
            "page_message",
            "export_flow_file",
            "jev_settings",
            "jev_save_settings",
            "jev_remove_credential",
        ]),
    ))
    .expect("Tauri build failed");
}

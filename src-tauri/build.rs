fn main() {
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("Tauri build configuration");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Dialogs also load Common Controls in the library and integration test executables.
        println!("cargo:rerun-if-changed=windows-manifest.rc");
        println!("cargo:rerun-if-changed=windows.manifest");
        embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("embed Windows application manifest");
    }
}

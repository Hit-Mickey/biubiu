fn main() {
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("Tauri build configuration");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // Oboe is a static C++ archive. Resolve its runtime before packaging the JNI library.
        println!("cargo:rustc-link-arg-cdylib=-Wl,--start-group,-lc++_static,-lc++abi,-lunwind,--end-group");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,defs,-z,max-page-size=16384");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
            // The desktop EXE links the rlib. MinGW otherwise exports every Rust symbol from the companion DLL.
            println!("cargo:rustc-link-arg-cdylib=-Wl,--exclude-all-symbols");
        }
        // Dialogs also load Common Controls in the library and integration test executables.
        println!("cargo:rerun-if-changed=windows-manifest.rc");
        println!("cargo:rerun-if-changed=windows.manifest");
        embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("embed Windows application manifest");
    }
}

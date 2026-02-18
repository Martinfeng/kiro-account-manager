use std::path::Path;
use std::process::Command;

fn main() {
    let kiro2api_dir = Path::new("resources/offline/kiro2api-node");
    if kiro2api_dir.exists() && !kiro2api_dir.join("node_modules").exists() {
        let status = Command::new("npm")
            .args(["install", "--production", "--ignore-scripts"])
            .current_dir(kiro2api_dir)
            .status()
            .expect("failed to run npm install for kiro2api-node");
        if !status.success() {
            panic!("npm install failed for kiro2api-node");
        }
    }
    println!("cargo:rerun-if-changed=resources/offline/kiro2api-node/package.json");
    tauri_build::build()
}

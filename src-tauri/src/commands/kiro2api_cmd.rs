use crate::state::{AppState, Kiro2ApiRuntime};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kiro2ApiStartParams {
    pub project_path: Option<String>,
    pub port: Option<u16>,
    pub api_key: Option<String>,
    pub admin_key: Option<String>,
    pub data_dir: Option<String>,
    pub region: Option<String>,
    pub kiro_version: Option<String>,
    pub proxy_url: Option<String>,
    pub anthropic_compat_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kiro2ApiStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub project_path: Option<String>,
    pub log_path: Option<String>,
    pub shared_accounts_file: Option<String>,
    pub healthy: bool,
    pub message: Option<String>,
}

const BUNDLED_PROJECT_RELATIVE: &str = "offline/kiro2api-node";
const BUNDLED_NODE_RELATIVE_MAC_ARM64: &str = "offline/node/darwin-aarch64/bin/node";

fn default_project_candidates() -> Vec<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let home_dir = PathBuf::from(home);

    vec![
        home_dir.join("project").join("Kiro2api-Node"),
        home_dir.join("project").join("kiro2api-node"),
        home_dir.join("Kiro2api-Node"),
        home_dir.join("kiro2api-node"),
    ]
}

fn is_valid_project_dir(project_dir: &Path) -> bool {
    project_dir.exists() && project_dir.join("src").join("index.js").exists()
}

fn resolve_external_project_path(project_path: Option<String>) -> Result<Option<String>, String> {
    if let Some(path) = project_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let project_dir = PathBuf::from(trimmed);
            if is_valid_project_dir(&project_dir) {
                return Ok(Some(trimmed.to_string()));
            }
            return Err(format!("project path not found: {}", trimmed));
        }
    }

    for candidate in default_project_candidates() {
        if is_valid_project_dir(&candidate) {
            return Ok(Some(candidate.to_string_lossy().to_string()));
        }
    }

    Ok(None)
}

fn account_store_path() -> PathBuf {
    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });
    data_dir.join(".kiro-account-manager").join("accounts.json")
}

fn default_node_data_dir() -> PathBuf {
    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });
    data_dir.join(".kiro-account-manager").join("kiro2api-node")
}

fn command_in_path_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(name));
        }
    }
    candidates
}

fn resource_dir_candidates(app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.to_path_buf());
            candidates.push(exe_dir.join("../Resources"));
            candidates.push(exe_dir.join("resources"));
        }
    }

    candidates
}

fn bundled_project_candidates(app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for base in resource_dir_candidates(app_handle) {
        candidates.push(base.join(BUNDLED_PROJECT_RELATIVE));
        candidates.push(base.join("kiro2api-node"));
        candidates.push(base.join("resources").join(BUNDLED_PROJECT_RELATIVE));
        candidates.push(base.join("resources").join("kiro2api-node"));
    }
    candidates
}

fn resolve_bundled_project_path(app_handle: &AppHandle) -> Result<String, String> {
    let mut checked = Vec::new();
    for candidate in bundled_project_candidates(app_handle) {
        checked.push(candidate.to_string_lossy().to_string());
        if is_valid_project_dir(&candidate) {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err(format!(
        "Bundled Kiro2API project not found in app resources. Reinstall with offline DMG. Checked: {}",
        checked.join(", ")
    ))
}

fn bundled_node_candidates(app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for base in resource_dir_candidates(app_handle) {
        candidates.push(base.join(BUNDLED_NODE_RELATIVE_MAC_ARM64));
        candidates.push(base.join("node").join("darwin-aarch64").join("bin").join("node"));
        candidates.push(base.join("offline").join("node").join("darwin-aarch64").join("node"));
        candidates.push(
            base.join("resources")
                .join("node")
                .join("darwin-aarch64")
                .join("bin")
                .join("node"),
        );
        candidates.push(
            base.join("resources")
                .join("offline")
                .join("node")
                .join("darwin-aarch64")
                .join("node"),
        );
        candidates.push(base.join("resources").join(BUNDLED_NODE_RELATIVE_MAC_ARM64));
    }
    candidates
}

fn system_node_candidates() -> Vec<PathBuf> {
    let mut candidates = command_in_path_candidates("node");

    for p in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/opt/homebrew/opt/node@22/bin/node",
        "/opt/homebrew/opt/node@20/bin/node",
        "/usr/bin/node",
    ] {
        candidates.push(PathBuf::from(p));
    }

    candidates
}

fn resolve_node_binary(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let mut checked = Vec::new();

    if let Ok(custom) = std::env::var("NODE_BINARY") {
        let custom = custom.trim().to_string();
        if !custom.is_empty() {
            let candidate = PathBuf::from(&custom);
            checked.push(custom);
            if candidate.exists() && candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    for candidate in bundled_node_candidates(app_handle) {
        checked.push(candidate.to_string_lossy().to_string());
        if candidate.exists() && candidate.is_file() {
            return Ok(candidate);
        }
    }

    for candidate in system_node_candidates() {
        checked.push(candidate.to_string_lossy().to_string());
        if candidate.exists() && candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Node.js executable not found. Offline package should include a bundled node binary. Checked: {}",
        checked.join(", ")
    ))
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("read metadata failed: {}", e))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    if mode & 0o111 == 0 {
        permissions.set_mode(mode | 0o755);
        fs::set_permissions(path, permissions)
            .map_err(|e| format!("set execute permission failed: {}", e))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn ensure_project_runtime_files(project_dir: &Path, is_bundled: bool) -> Result<(), String> {
    if !is_valid_project_dir(project_dir) {
        return Err(format!(
            "invalid Kiro2api-Node project path: {}",
            project_dir.to_string_lossy()
        ));
    }

    if !project_dir.join("node_modules").exists() {
        if is_bundled {
            return Err(format!(
                "bundled Kiro2API runtime is incomplete (node_modules missing): {}",
                project_dir.to_string_lossy()
            ));
        }
        return Err(format!(
            "node_modules not found in '{}'. Leave project path empty to use bundled offline runtime.",
            project_dir.to_string_lossy()
        ));
    }

    Ok(())
}

fn resolve_project_for_start(
    app_handle: &AppHandle,
    project_path: Option<String>,
) -> Result<(String, bool), String> {
    if let Some(path) = project_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let explicit_dir = PathBuf::from(trimmed);
            if is_valid_project_dir(&explicit_dir) {
                return Ok((trimmed.to_string(), false));
            }

            let explicit_error = format!("project path not found: {}", trimmed);
            return match resolve_bundled_project_path(app_handle) {
                Ok(path) => Ok((path, true)),
                Err(bundle_error) => Err(format!("{}; {}", explicit_error, bundle_error)),
            };
        }
    }

    let bundled_error = match resolve_bundled_project_path(app_handle) {
        Ok(path) => return Ok((path, true)),
        Err(e) => e,
    };

    if let Some(path) = resolve_external_project_path(None)? {
        return Ok((path, false));
    }

    Err(format!(
        "{} No local Kiro2api-Node project found either.",
        bundled_error
    ))
}

fn merged_path_for_child() -> String {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }

    for p in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/homebrew/opt/node/bin",
        "/opt/homebrew/opt/node@22/bin",
        "/opt/homebrew/opt/node@20/bin",
    ] {
        let pb = PathBuf::from(p);
        if !paths.iter().any(|x| x == &pb) {
            paths.push(pb);
        }
    }

    std::env::join_paths(paths)
        .ok()
        .and_then(|v| v.into_string().ok())
        .unwrap_or_else(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".to_string())
}

fn cleanup_if_exited(state: &mut Option<Kiro2ApiRuntime>) {
    let exited = match state.as_mut() {
        Some(runtime) => runtime.child.try_wait().map(|v| v.is_some()).unwrap_or(false),
        None => false,
    };
    if exited {
        *state = None;
    }
}

#[cfg(unix)]
fn list_listening_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{}", port),
            "-sTCP:LISTEN",
            "-t",
        ])
        .output()
        .map_err(|e| format!("failed to query listeners on port {}: {}", port, e))?;

    if !output.status.success() {
        // lsof exits with code 1 when no match
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "failed to query listeners on port {}: {}",
            port, stderr
        ));
    }

    let pids = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect::<Vec<_>>();
    Ok(pids)
}

#[cfg(unix)]
fn process_cmdline(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(unix)]
fn is_kiro2api_pid(pid: u32, project_dir: Option<&Path>) -> bool {
    let cmd = match process_cmdline(pid) {
        Some(v) => v.to_lowercase(),
        None => return false,
    };

    let project_match = project_dir
        .map(|p| cmd.contains(&p.to_string_lossy().to_lowercase()))
        .unwrap_or(false);

    let looks_like_kiro2api = cmd.contains("kiro2api")
        || (cmd.contains("node") && cmd.contains("src/index.js"));

    project_match || looks_like_kiro2api
}

#[cfg(unix)]
fn kill_pid(pid: u32, signal: &str) {
    let _ = Command::new("kill")
        .args([signal, &pid.to_string()])
        .status();
}

#[cfg(unix)]
fn cleanup_stale_kiro2api_on_port(port: u16, project_dir: Option<&Path>) -> Result<(), String> {
    let pids = list_listening_pids(port)?;
    if pids.is_empty() {
        return Ok(());
    }

    let mut kiro_pids = Vec::new();
    let mut foreign_pids = Vec::new();
    for pid in pids {
        if is_kiro2api_pid(pid, project_dir) {
            kiro_pids.push(pid);
        } else {
            foreign_pids.push(pid);
        }
    }

    if !foreign_pids.is_empty() {
        return Err(format!(
            "port {} is already in use by non-Kiro2API process(es): {:?}",
            port, foreign_pids
        ));
    }

    for pid in &kiro_pids {
        kill_pid(*pid, "-TERM");
    }
    thread::sleep(Duration::from_millis(400));

    let still_listening = list_listening_pids(port)?;
    for pid in still_listening {
        if is_kiro2api_pid(pid, project_dir) {
            kill_pid(pid, "-KILL");
        }
    }
    thread::sleep(Duration::from_millis(200));

    let final_pids = list_listening_pids(port)?;
    if final_pids.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "failed to release port {} after terminating stale Kiro2API process(es): {:?}",
            port, final_pids
        ))
    }
}

#[cfg(not(unix))]
fn cleanup_stale_kiro2api_on_port(_port: u16, _project_dir: Option<&Path>) -> Result<(), String> {
    Ok(())
}

async fn check_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/health", port);
    match reqwest::get(url).await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn get_kiro2api_status(state: State<'_, AppState>) -> Result<Kiro2ApiStatus, String> {
    let snapshot = {
        let mut runtime = state.kiro2api.lock().map_err(|e| format!("lock failed: {}", e))?;
        cleanup_if_exited(&mut runtime);
        runtime.as_ref().map(|r| {
            (
                r.pid,
                r.port,
                r.project_path.clone(),
                r.log_path.clone(),
                r.shared_accounts_file.clone(),
            )
        })
    };

    if let Some((pid, port, project_path, log_path, shared_accounts_file)) = snapshot {
        let healthy = check_health(port).await;
        Ok(Kiro2ApiStatus {
            running: true,
            pid: Some(pid),
            port: Some(port),
            url: Some(format!("http://127.0.0.1:{}", port)),
            project_path: Some(project_path),
            log_path: Some(log_path),
            shared_accounts_file: Some(shared_accounts_file),
            healthy,
            message: None,
        })
    } else {
        Ok(Kiro2ApiStatus {
            running: false,
            pid: None,
            port: None,
            url: None,
            project_path: None,
            log_path: None,
            shared_accounts_file: None,
            healthy: false,
            message: None,
        })
    }
}

#[tauri::command]
pub async fn start_kiro2api_service(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    params: Option<Kiro2ApiStartParams>,
) -> Result<Kiro2ApiStatus, String> {
    let params = params.unwrap_or(Kiro2ApiStartParams {
        project_path: None,
        port: None,
        api_key: None,
        admin_key: None,
        data_dir: None,
        region: None,
        kiro_version: None,
        proxy_url: None,
        anthropic_compat_mode: None,
    });

    {
        let mut runtime = state.kiro2api.lock().map_err(|e| format!("lock failed: {}", e))?;
        cleanup_if_exited(&mut runtime);
        if runtime.is_some() {
            return Err("Kiro2API service is already running".to_string());
        }
    }

    let data_dir = params
        .data_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(default_node_data_dir);

    let (project_path, is_bundled_project) = resolve_project_for_start(&app_handle, params.project_path.clone())
        .map_err(|e| format!("{} You can also set a custom local project path in Kiro2API tab.", e))?;

    let project_dir = PathBuf::from(&project_path);
    ensure_project_runtime_files(&project_dir, is_bundled_project)?;

    let port = params.port.unwrap_or(8080);
    cleanup_stale_kiro2api_on_port(port, Some(&project_dir))?;

    let api_key = params.api_key.unwrap_or_else(|| "sk-default-key".to_string());
    let admin_key = params.admin_key.unwrap_or_else(|| "admin-default-key".to_string());
    let region = params.region.unwrap_or_else(|| "us-east-1".to_string());
    let kiro_version = params.kiro_version.unwrap_or_else(|| "0.8.0".to_string());
    let anthropic_compat_mode = params
        .anthropic_compat_mode
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s == "strict" || s == "balanced" || s == "relaxed")
        .unwrap_or_else(|| "strict".to_string());
    let shared_accounts_file = account_store_path();

    fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir failed: {}", e))?;
    let log_path = data_dir.join("kiro2api.log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open log file failed: {}", e))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("clone log file failed: {}", e))?;

    let node_binary = resolve_node_binary(&app_handle)?;
    ensure_executable(&node_binary)?;

    let mut cmd = Command::new(&node_binary);
    cmd.arg("src/index.js")
        .current_dir(&project_dir)
        .env("PATH", merged_path_for_child())
        .env("PORT", port.to_string())
        .env("API_KEY", api_key)
        .env("ADMIN_KEY", admin_key)
        .env("DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("REGION", region)
        .env("KIRO_VERSION", kiro_version)
        .env("ANTHROPIC_COMPAT_MODE", anthropic_compat_mode)
        .env(
            "SHARED_ACCOUNTS_FILE",
            shared_accounts_file.to_string_lossy().to_string(),
        )
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    if let Some(proxy_url) = params.proxy_url {
        if !proxy_url.trim().is_empty() {
            cmd.env("PROXY_URL", proxy_url.trim());
        }
    }

    let child = cmd.spawn().map_err(|e| {
        format!(
            "failed to start Kiro2API service with node binary '{}': {}",
            node_binary.to_string_lossy(),
            e
        )
    })?;
    let pid = child.id();

    {
        let mut runtime = state.kiro2api.lock().map_err(|e| format!("lock failed: {}", e))?;
        *runtime = Some(Kiro2ApiRuntime {
            child,
            pid,
            port,
            project_path: project_path.clone(),
            log_path: log_path.to_string_lossy().to_string(),
            shared_accounts_file: shared_accounts_file.to_string_lossy().to_string(),
        });
    }

    get_kiro2api_status(state).await
}

#[tauri::command]
pub async fn stop_kiro2api_service(
    state: State<'_, AppState>,
    port: Option<u16>,
) -> Result<Kiro2ApiStatus, String> {
    let port = port.unwrap_or(8080);
    {
        let mut runtime = state.kiro2api.lock().map_err(|e| format!("lock failed: {}", e))?;
        // Dropping runtime triggers process termination in Kiro2ApiRuntime::drop.
        let _ = runtime.take();
    }
    // If app was restarted, runtime state may be empty while stale listener still exists.
    cleanup_stale_kiro2api_on_port(port, None)?;
    get_kiro2api_status(state).await
}

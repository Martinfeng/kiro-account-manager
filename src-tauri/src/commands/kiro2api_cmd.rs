use crate::account::Account;
use crate::state::{AppState, Kiro2ApiRuntime};
use chrono::{Local, NaiveDateTime, TimeZone};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KiroRsConfig {
    host: String,
    port: u16,
    region: String,
    kiro_version: String,
    api_key: String,
    admin_api_key: String,
    proxy_url: Option<String>,
    load_balancing_mode: String,
    tls_backend: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KiroRsCredential {
    id: u64,
    refresh_token: String,
    auth_method: String,
    priority: u32,
    disabled: bool,
    access_token: Option<String>,
    profile_arn: Option<String>,
    expires_at: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    region: Option<String>,
    email: Option<String>,
    subscription_title: Option<String>,
}

const BUNDLED_RUNTIME_RELATIVE_MAC_ARM64: &str = "offline/kiro-rs/darwin-aarch64/kiro-rs";

fn account_store_path() -> PathBuf {
    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });
    data_dir.join(".kiro-account-manager").join("accounts.json")
}

fn default_runtime_data_dir() -> PathBuf {
    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });
    data_dir.join(".kiro-account-manager").join("kiro-rs")
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

fn bundled_runtime_candidates(app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for base in resource_dir_candidates(app_handle) {
        candidates.push(base.join(BUNDLED_RUNTIME_RELATIVE_MAC_ARM64));
        candidates.push(base.join("offline").join("kiro-rs").join("kiro-rs"));
        candidates.push(base.join("kiro-rs"));
        candidates.push(base.join("resources").join(BUNDLED_RUNTIME_RELATIVE_MAC_ARM64));
    }
    candidates
}

fn system_runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = command_in_path_candidates("kiro-rs");
    for p in [
        "/opt/homebrew/bin/kiro-rs",
        "/usr/local/bin/kiro-rs",
        "/usr/bin/kiro-rs",
    ] {
        candidates.push(PathBuf::from(p));
    }
    candidates
}

fn looks_like_legacy_node_project(path: &Path) -> bool {
    path.join("package.json").exists() && path.join("src").join("index.js").exists()
}

fn resolve_custom_runtime_path(path: &Path) -> Option<PathBuf> {
    if path.exists() && path.is_file() {
        return Some(path.to_path_buf());
    }

    if path.is_dir() {
        let candidates = [
            path.join("kiro-rs"),
            path.join("target").join("release").join("kiro-rs"),
            path.join("target").join("debug").join("kiro-rs"),
            path.join("bin").join("kiro-rs"),
        ];
        for candidate in candidates {
            if candidate.exists() && candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn resolve_runtime_binary(
    app_handle: &AppHandle,
    project_path: Option<String>,
) -> Result<PathBuf, String> {
    let mut checked = Vec::new();
    let mut custom_error: Option<String> = None;

    if let Some(path) = project_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if looks_like_legacy_node_project(&candidate) {
                custom_error = Some(format!(
                    "legacy Node project path is no longer used by default runtime: {}",
                    trimmed
                ));
            } else if let Some(binary) = resolve_custom_runtime_path(&candidate) {
                checked.push(binary.to_string_lossy().to_string());
                return Ok(binary);
            } else {
                custom_error = Some(format!(
                    "runtime path not found or invalid: {}",
                    trimmed
                ));
                checked.push(trimmed.to_string());
            }
        }
    }

    for candidate in bundled_runtime_candidates(app_handle) {
        checked.push(candidate.to_string_lossy().to_string());
        if candidate.exists() && candidate.is_file() {
            return Ok(candidate);
        }
    }

    for candidate in system_runtime_candidates() {
        checked.push(candidate.to_string_lossy().to_string());
        if candidate.exists() && candidate.is_file() {
            return Ok(candidate);
        }
    }

    let prefix = custom_error
        .map(|e| format!("{}; ", e))
        .unwrap_or_default();
    Err(format!(
        "{}Kiro.rs executable not found. Reinstall offline DMG or set a custom runtime path. Checked: {}",
        prefix,
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

fn normalize_expires_at(expires_at: Option<&str>) -> Option<String> {
    let raw = expires_at?.trim();
    if raw.is_empty() {
        return None;
    }

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(dt.to_rfc3339());
    }

    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%Y/%m/%d %H:%M:%S") {
        if let Some(local_dt) = Local.from_local_datetime(&naive).single() {
            return Some(local_dt.to_rfc3339());
        }
    }

    None
}

fn account_to_credential(account: &Account, priority: usize, default_region: &str) -> Option<KiroRsCredential> {
    let refresh_token = account
        .refresh_token
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;

    let provider = account.provider.as_deref().unwrap_or("social").to_lowercase();
    let has_idc_fields = account.client_id.is_some() && account.client_secret.is_some();
    let auth_method = if provider.contains("builder") || provider.contains("enterprise") || has_idc_fields {
        "idc".to_string()
    } else {
        "social".to_string()
    };

    let status_lc = account.status.to_lowercase();
    let disabled = status_lc.contains("封禁") || status_lc.contains("banned") || status_lc.contains("suspend");

    let subscription_title = account
        .usage_data
        .as_ref()
        .and_then(|usage| usage.get("subscriptionInfo"))
        .and_then(|s| {
            s.get("subscriptionTitle")
                .or_else(|| s.get("subscriptionName"))
                .or_else(|| s.get("subscriptionType"))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let region = account
        .region
        .as_ref()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .or_else(|| Some(default_region.to_string()));

    Some(KiroRsCredential {
        id: (priority + 1) as u64,
        refresh_token,
        auth_method,
        priority: priority as u32,
        disabled,
        access_token: account
            .access_token
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        profile_arn: account
            .profile_arn
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        expires_at: normalize_expires_at(account.expires_at.as_deref()),
        client_id: account
            .client_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        client_secret: account
            .client_secret
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        region,
        email: Some(account.email.clone()).filter(|s| !s.trim().is_empty()),
        subscription_title,
    })
}

fn build_runtime_credentials(default_region: &str) -> Result<Vec<KiroRsCredential>, String> {
    let path = account_store_path();
    if !path.exists() {
        return Err(format!(
            "shared accounts file not found: {}",
            path.to_string_lossy()
        ));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("read shared accounts failed ({}): {}", path.to_string_lossy(), e))?;
    let accounts: Vec<Account> = serde_json::from_str(&content)
        .map_err(|e| format!("parse shared accounts failed: {}", e))?;

    let mut credentials = Vec::new();
    for (idx, account) in accounts.iter().enumerate() {
        if let Some(cred) = account_to_credential(account, idx, default_region) {
            credentials.push(cred);
        }
    }

    if credentials.is_empty() {
        return Err("no valid account with refresh token found in shared accounts.json".to_string());
    }

    Ok(credentials)
}

fn write_runtime_files(
    data_dir: &Path,
    config: &KiroRsConfig,
    credentials: &[KiroRsCredential],
) -> Result<(PathBuf, PathBuf), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("create data dir failed: {}", e))?;

    let config_path = data_dir.join("config.json");
    let credentials_path = data_dir.join("credentials.json");

    let config_json =
        serde_json::to_string_pretty(config).map_err(|e| format!("serialize config failed: {}", e))?;
    fs::write(&config_path, config_json).map_err(|e| format!("write config failed: {}", e))?;

    let credentials_json = serde_json::to_string_pretty(credentials)
        .map_err(|e| format!("serialize credentials failed: {}", e))?;
    fs::write(&credentials_path, credentials_json)
        .map_err(|e| format!("write credentials failed: {}", e))?;

    Ok((config_path, credentials_path))
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
fn is_kiro2api_pid(pid: u32, marker_path: Option<&Path>) -> bool {
    let cmd = match process_cmdline(pid) {
        Some(v) => v.to_lowercase(),
        None => return false,
    };

    let marker_match = marker_path
        .map(|p| cmd.contains(&p.to_string_lossy().to_lowercase()))
        .unwrap_or(false);

    let looks_like_kiro_runtime = cmd.contains("kiro-rs")
        || cmd.contains("kiro2api")
        || (cmd.contains("node") && cmd.contains("src/index.js"));

    marker_match || looks_like_kiro_runtime
}

#[cfg(unix)]
fn kill_pid(pid: u32, signal: &str) {
    let _ = Command::new("kill").args([signal, &pid.to_string()]).status();
}

#[cfg(unix)]
fn cleanup_stale_kiro2api_on_port(port: u16, marker_path: Option<&Path>) -> Result<(), String> {
    let pids = list_listening_pids(port)?;
    if pids.is_empty() {
        return Ok(());
    }

    let mut kiro_pids = Vec::new();
    let mut foreign_pids = Vec::new();
    for pid in pids {
        if is_kiro2api_pid(pid, marker_path) {
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
        if is_kiro2api_pid(pid, marker_path) {
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
fn cleanup_stale_kiro2api_on_port(_port: u16, _marker_path: Option<&Path>) -> Result<(), String> {
    Ok(())
}

async fn check_health(port: u16, api_key: &str) -> bool {
    let url = format!("http://127.0.0.1:{}/v1/models", port);
    let client = reqwest::Client::new();
    match client.get(url).header("x-api-key", api_key).send().await {
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
                r.api_key.clone(),
            )
        })
    };

    if let Some((pid, port, project_path, log_path, shared_accounts_file, api_key)) = snapshot {
        let healthy = check_health(port, &api_key).await;
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
    });

    {
        let mut runtime = state.kiro2api.lock().map_err(|e| format!("lock failed: {}", e))?;
        cleanup_if_exited(&mut runtime);
        if runtime.is_some() {
            return Err("Kiro2API service is already running".to_string());
        }
    }

    let runtime_binary = resolve_runtime_binary(&app_handle, params.project_path.clone())?;
    ensure_executable(&runtime_binary)?;

    let data_dir = params
        .data_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(default_runtime_data_dir);

    let port = params.port.unwrap_or(8080);
    cleanup_stale_kiro2api_on_port(port, Some(&data_dir))?;

    let api_key = params.api_key.unwrap_or_else(|| "sk-default-key".to_string());
    let admin_key = params
        .admin_key
        .unwrap_or_else(|| "admin-default-key".to_string());
    let region = params.region.unwrap_or_else(|| "us-east-1".to_string());
    let kiro_version = params.kiro_version.unwrap_or_else(|| "0.9.2".to_string());

    let config = KiroRsConfig {
        host: "127.0.0.1".to_string(),
        port,
        region: region.clone(),
        kiro_version,
        api_key,
        admin_api_key: admin_key,
        proxy_url: params
            .proxy_url
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        load_balancing_mode: "priority".to_string(),
        tls_backend: "rustls".to_string(),
    };

    let credentials = build_runtime_credentials(&region)?;
    let (config_path, credentials_path) = write_runtime_files(&data_dir, &config, &credentials)?;

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

    let mut cmd = Command::new(&runtime_binary);
    cmd.arg("--config")
        .arg(&config_path)
        .arg("--credentials")
        .arg(&credentials_path)
        .env("RUST_LOG", "info")
        .current_dir(&data_dir)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let child = cmd.spawn().map_err(|e| {
        format!(
            "failed to start Kiro2API service with runtime '{}': {}",
            runtime_binary.to_string_lossy(),
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
            project_path: runtime_binary.to_string_lossy().to_string(),
            log_path: log_path.to_string_lossy().to_string(),
            shared_accounts_file: account_store_path().to_string_lossy().to_string(),
            api_key: config.api_key.clone(),
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
        let _ = runtime.take();
    }
    cleanup_stale_kiro2api_on_port(port, None)?;
    get_kiro2api_status(state).await
}

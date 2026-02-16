use crate::state::{AppState, Kiro2ApiRuntime};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::State;

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

const KIRO2API_REPO_URL: &str = "https://github.com/lulistart/Kiro2api-Node.git";

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

fn is_valid_project_dir(project_dir: &PathBuf) -> bool {
    project_dir.exists() && project_dir.join("src").join("index.js").exists()
}

fn has_explicit_project_path(project_path: &Option<String>) -> bool {
    project_path
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn resolve_project_path(project_path: Option<String>) -> Result<String, String> {
    let mut provided_error: Option<String> = None;

    if let Some(path) = project_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let project_dir = PathBuf::from(trimmed);
            if is_valid_project_dir(&project_dir) {
                return Ok(trimmed.to_string());
            }
            provided_error = Some(format!("project path not found: {}", trimmed));
        }
    }

    for candidate in default_project_candidates() {
        if is_valid_project_dir(&candidate) {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    let checked = default_project_candidates()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let prefix = provided_error.unwrap_or_else(|| "Kiro2api-Node project not found.".to_string());
    Err(format!(
        "{} Please set project path in Kiro2API tab. Checked: {}",
        prefix, checked
    ))
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

fn node_candidates() -> Vec<PathBuf> {
    let mut candidates = command_in_path_candidates("node");

    if let Ok(custom) = std::env::var("NODE_BINARY") {
        if !custom.trim().is_empty() {
            candidates.insert(0, PathBuf::from(custom.trim()));
        }
    }

    // macOS 常见安装路径（GUI 启动时 PATH 经常不包含 Homebrew）
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

fn npm_candidates() -> Vec<PathBuf> {
    let mut candidates = command_in_path_candidates("npm");

    if let Ok(custom) = std::env::var("NPM_BINARY") {
        if !custom.trim().is_empty() {
            candidates.insert(0, PathBuf::from(custom.trim()));
        }
    }

    for p in [
        "/opt/homebrew/bin/npm",
        "/usr/local/bin/npm",
        "/opt/homebrew/opt/node/bin/npm",
        "/opt/homebrew/opt/node@22/bin/npm",
        "/opt/homebrew/opt/node@20/bin/npm",
        "/usr/bin/npm",
    ] {
        candidates.push(PathBuf::from(p));
    }

    candidates
}

fn git_candidates() -> Vec<PathBuf> {
    let mut candidates = command_in_path_candidates("git");

    if let Ok(custom) = std::env::var("GIT_BINARY") {
        if !custom.trim().is_empty() {
            candidates.insert(0, PathBuf::from(custom.trim()));
        }
    }

    for p in ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"] {
        candidates.push(PathBuf::from(p));
    }

    candidates
}

fn resolve_node_binary() -> Result<PathBuf, String> {
    let mut checked = Vec::new();
    for candidate in node_candidates() {
        let p = candidate.as_path();
        checked.push(p.to_string_lossy().to_string());
        if p.exists() && p.is_file() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Node.js executable not found. Install Node.js or set NODE_BINARY. Checked: {}",
        checked.join(", ")
    ))
}

fn resolve_npm_binary() -> Result<PathBuf, String> {
    let mut checked = Vec::new();
    for candidate in npm_candidates() {
        let p = candidate.as_path();
        checked.push(p.to_string_lossy().to_string());
        if p.exists() && p.is_file() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "npm executable not found. Install Node.js or set NPM_BINARY. Checked: {}",
        checked.join(", ")
    ))
}

fn resolve_git_binary() -> Result<PathBuf, String> {
    let mut checked = Vec::new();
    for candidate in git_candidates() {
        let p = candidate.as_path();
        checked.push(p.to_string_lossy().to_string());
        if p.exists() && p.is_file() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "git executable not found. Install git or set GIT_BINARY. Checked: {}",
        checked.join(", ")
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

fn run_command_capture(cmd: &mut Command, display_name: &str) -> Result<(), String> {
    let output = cmd
        .output()
        .map_err(|e| format!("{} failed to execute: {}", display_name, e))?;

    if output.status.success() {
        return Ok(());
    }

    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    Err(format!(
        "{} failed (code {}): stderr='{}' stdout='{}'",
        display_name, code, stderr, stdout
    ))
}

fn ensure_project_dependencies(project_dir: &PathBuf) -> Result<(), String> {
    if project_dir.join("node_modules").exists() {
        return Ok(());
    }

    let npm_binary = resolve_npm_binary()?;
    let mut install_cmd = Command::new(&npm_binary);
    install_cmd
        .arg("ci")
        .arg("--omit=dev")
        .current_dir(project_dir)
        .env("PATH", merged_path_for_child())
        .stdin(Stdio::null());

    run_command_capture(&mut install_cmd, "npm ci")
}

fn bootstrap_project(data_dir: &PathBuf) -> Result<String, String> {
    let project_dir = data_dir.join("Kiro2api-Node");

    if is_valid_project_dir(&project_dir) {
        ensure_project_dependencies(&project_dir)?;
        return Ok(project_dir.to_string_lossy().to_string());
    }

    if project_dir.exists() {
        fs::remove_dir_all(&project_dir)
            .map_err(|e| format!("remove old bootstrap project failed: {}", e))?;
    }

    fs::create_dir_all(data_dir)
        .map_err(|e| format!("create bootstrap data dir failed: {}", e))?;

    let git_binary = resolve_git_binary()?;
    let mut clone_cmd = Command::new(&git_binary);
    clone_cmd
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg(KIRO2API_REPO_URL)
        .arg(&project_dir)
        .env("PATH", merged_path_for_child())
        .stdin(Stdio::null());

    run_command_capture(&mut clone_cmd, "git clone Kiro2api-Node")?;
    ensure_project_dependencies(&project_dir)?;

    Ok(project_dir.to_string_lossy().to_string())
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

    let data_dir = params
        .data_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(default_node_data_dir);

    let project_path = match resolve_project_path(params.project_path.clone()) {
        Ok(path) => path,
        Err(original_error) => {
            if has_explicit_project_path(&params.project_path) {
                return Err(original_error);
            }
            bootstrap_project(&data_dir)?
        }
    };
    let project_dir = PathBuf::from(&project_path);
    if !is_valid_project_dir(&project_dir) {
        return Err(format!("invalid Kiro2api-Node project path: {}", project_path));
    }
    ensure_project_dependencies(&project_dir)?;

    let port = params.port.unwrap_or(8080);
    let api_key = params.api_key.unwrap_or_else(|| "sk-default-key".to_string());
    let admin_key = params.admin_key.unwrap_or_else(|| "admin-default-key".to_string());
    let region = params.region.unwrap_or_else(|| "us-east-1".to_string());
    let kiro_version = params.kiro_version.unwrap_or_else(|| "0.8.0".to_string());
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

    let node_binary = resolve_node_binary()?;
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

    // 返回启动后的实时状态
    get_kiro2api_status(state).await
}

#[tauri::command]
pub async fn stop_kiro2api_service(state: State<'_, AppState>) -> Result<Kiro2ApiStatus, String> {
    {
        let mut runtime = state.kiro2api.lock().map_err(|e| format!("lock failed: {}", e))?;
        if let Some(mut current) = runtime.take() {
            let _ = current.child.kill();
            let _ = current.child.wait();
        }
    }
    get_kiro2api_status(state).await
}

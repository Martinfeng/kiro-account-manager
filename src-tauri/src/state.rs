// 应用全局状态

use std::process::Child;
use std::sync::Mutex;
use crate::auth::AuthState;
use crate::account::AccountStore;

#[derive(Clone)]
pub struct PendingLogin {
    pub provider: String,
    pub code_verifier: String,
    pub state: String,
    pub machineid: String,
}

pub struct Kiro2ApiRuntime {
    pub child: Child,
    pub pid: u32,
    pub port: u16,
    pub project_path: String,
    pub log_path: String,
    pub shared_accounts_file: String,
}

pub struct AppState {
    pub store: Mutex<AccountStore>,
    pub auth: AuthState,
    pub pending_login: Mutex<Option<PendingLogin>>,
    pub kiro2api: Mutex<Option<Kiro2ApiRuntime>>,
}

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { TokenManager } from './token.js';
import { checkUsageLimits } from './usage.js';

const SHARED_SYNC_INTERVAL_MS = 5000;

function mapStatus(rawStatus) {
  const value = String(rawStatus || '').trim().toLowerCase();

  if (!value) return 'active';

  if (
    value.includes('invalid') ||
    value.includes('ban') ||
    value.includes('banned') ||
    value.includes('封禁') ||
    value.includes('失效')
  ) {
    return 'invalid';
  }

  if (value.includes('disabled') || value.includes('禁用')) {
    return 'disabled';
  }

  if (value.includes('cooldown') || value.includes('冷却')) {
    return 'cooldown';
  }

  return 'active';
}

function normalizeSharedCredentials(raw, defaultRegion) {
  const refreshToken = raw.refreshToken || raw.refresh_token || null;
  const accessToken = raw.accessToken || raw.access_token || null;
  const expiresAt = raw.expiresAt || raw.expires_at || null;
  const machineId = raw.machineId || raw.machine_id || null;
  const clientId = raw.clientId || raw.client_id || null;
  const clientSecret = raw.clientSecret || raw.client_secret || null;
  const provider = String(raw.provider || '').toLowerCase();

  const isIdc =
    (clientId && clientSecret) ||
    provider.includes('idc') ||
    provider.includes('identity center') ||
    provider.includes('builder');

  return {
    refreshToken,
    accessToken,
    expiresAt,
    machineId,
    clientId,
    clientSecret,
    region: raw.region || defaultRegion,
    authMethod: isIdc ? 'idc' : 'social'
  };
}

export class AccountPool {
  constructor(config, db = null) {
    this.config = config;
    this.accounts = new Map();
    this.tokenManagers = new Map();
    this.strategy = 'round-robin';
    this.roundRobinIndex = 0;
    this.db = db; // 数据库管理器（可选）

    this.sharedAccountsFile = config.sharedAccountsFile
      ? path.resolve(config.sharedAccountsFile)
      : null;
    this.sharedMode = Boolean(this.sharedAccountsFile);
    this.sharedSyncTimer = null;
    this.sharedSyncPromise = null;
    this.sharedAccountsMtimeMs = 0;
  }

  isSharedMode() {
    return this.sharedMode;
  }

  getSharedAccountsFile() {
    return this.sharedAccountsFile;
  }

  ensureWritable() {
    if (this.sharedMode) {
      throw new Error('共享账号池模式下账号列表为只读，请在 Kiro Account Manager 中管理账号');
    }
  }

  normalizeSharedAccount(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const credentials = normalizeSharedCredentials(raw, this.config.region);
    if (!credentials.refreshToken) {
      return null;
    }

    const id = String(raw.id || raw.email || raw.label || uuidv4());
    const status = mapStatus(raw.status);
    const nowIso = new Date().toISOString();

    return {
      id,
      name: raw.label || raw.email || `共享账号 ${id.slice(0, 6)}`,
      credentials,
      status,
      requestCount: 0,
      errorCount: 0,
      createdAt: raw.addedAt || raw.added_at || raw.createdAt || raw.created_at || nowIso,
      lastUsedAt: raw.lastUsedAt || raw.last_used_at || null,
      usage: raw.usage || raw.usageData || raw.usage_data || null
    };
  }

  mergeTokenManager(existing, credentials) {
    existing.credentials = {
      ...existing.credentials,
      ...credentials
    };

    const accessToken = credentials.accessToken || credentials.access_token;
    if (accessToken) {
      existing.accessToken = accessToken;
    }

    const expiresAt = credentials.expiresAt || credentials.expires_at;
    if (expiresAt) {
      const date = new Date(expiresAt);
      if (!Number.isNaN(date.getTime())) {
        existing.expiresAt = date;
      }
    }

    return existing;
  }

  async syncSharedAccounts(force = false) {
    if (!this.sharedMode || !this.sharedAccountsFile) {
      return;
    }

    if (this.sharedSyncPromise) {
      return this.sharedSyncPromise;
    }

    this.sharedSyncPromise = this._syncSharedAccountsInner(force)
      .catch((error) => {
        console.error('同步共享账号池失败:', error.message);
      })
      .finally(() => {
        this.sharedSyncPromise = null;
      });

    return this.sharedSyncPromise;
  }

  async _syncSharedAccountsInner(force = false) {
    let stat;

    try {
      stat = await fs.stat(this.sharedAccountsFile);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (this.accounts.size > 0) {
          this.accounts.clear();
          this.tokenManagers.clear();
          this.sharedAccountsMtimeMs = 0;
          console.warn('⚠ 共享账号文件不存在，已清空内存账号池');
        }
        return;
      }
      throw error;
    }

    if (!force && this.sharedAccountsMtimeMs >= stat.mtimeMs) {
      return;
    }

    const content = await fs.readFile(this.sharedAccountsFile, 'utf-8');
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      throw new Error('共享账号文件格式错误：期望数组');
    }

    const nextAccounts = new Map();
    const nextTokenManagers = new Map();

    for (const raw of parsed) {
      const account = this.normalizeSharedAccount(raw);
      if (!account) continue;

      const existingAccount = this.accounts.get(account.id);
      if (existingAccount) {
        account.requestCount = existingAccount.requestCount;
        account.errorCount = existingAccount.errorCount;
        account.lastUsedAt = existingAccount.lastUsedAt || account.lastUsedAt;

        if (existingAccount.status === 'cooldown') {
          account.status = 'cooldown';
        }
      }

      const existingManager = this.tokenManagers.get(account.id);
      if (existingManager) {
        nextTokenManagers.set(account.id, this.mergeTokenManager(existingManager, account.credentials));
      } else {
        nextTokenManagers.set(account.id, new TokenManager(this.config, account.credentials));
      }

      nextAccounts.set(account.id, account);
    }

    this.accounts = nextAccounts;
    this.tokenManagers = nextTokenManagers;
    this.sharedAccountsMtimeMs = stat.mtimeMs;

    console.log(`✓ 从共享账号文件加载了 ${nextAccounts.size} 个账号`);
  }

  startSharedSyncLoop() {
    if (!this.sharedMode || this.sharedSyncTimer) {
      return;
    }

    this.sharedSyncTimer = setInterval(() => {
      this.syncSharedAccounts().catch(() => {});
    }, SHARED_SYNC_INTERVAL_MS);
  }

  async load() {
    try {
      await fs.mkdir(this.config.dataDir, { recursive: true });

      if (this.sharedMode) {
        await this.syncSharedAccounts(true);
        this.startSharedSyncLoop();
        return;
      }

      // 从数据库加载账号
      if (this.db) {
        const accounts = this.db.getAllAccounts();
        for (const acc of accounts) {
          // 解析 JSON 字段
          const credentials = typeof acc.credentials === 'string'
            ? JSON.parse(acc.credentials)
            : acc.credentials;
          const usage = acc.usage && typeof acc.usage === 'string'
            ? JSON.parse(acc.usage)
            : acc.usage;

          const account = {
            id: acc.id,
            name: acc.name,
            credentials,
            status: acc.status,
            requestCount: acc.requestCount,
            errorCount: acc.errorCount,
            createdAt: acc.createdAt,
            lastUsedAt: acc.lastUsedAt,
            usage
          };

          this.accounts.set(acc.id, account);
          this.tokenManagers.set(acc.id, new TokenManager(this.config, credentials));
        }
        console.log(`✓ 从数据库加载了 ${accounts.length} 个账号`);
      }
    } catch (e) {
      console.error('加载账号池失败:', e);
    }
  }

  async save() {
    // 保留空实现以向后兼容，实际数据操作直接写入数据库
  }

  async addAccount(account, skipValidation = false) {
    this.ensureWritable();

    const id = account.id || uuidv4();
    const newAccount = {
      id,
      name: account.name || '未命名账号',
      credentials: account.credentials,
      status: 'active',
      requestCount: 0,
      errorCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };

    // 验证凭证（可跳过）
    if (!skipValidation) {
      const tm = new TokenManager(this.config, newAccount.credentials);
      await tm.ensureValidToken(); // 会抛出错误如果无效
    }

    // 写入数据库
    if (this.db) {
      this.db.insertAccount(newAccount);
    }

    this.accounts.set(id, newAccount);
    this.tokenManagers.set(id, new TokenManager(this.config, newAccount.credentials));
    return id;
  }

  async removeAccount(id) {
    if (this.sharedMode) {
      return false;
    }

    const removed = this.accounts.delete(id);
    this.tokenManagers.delete(id);
    if (removed && this.db) {
      this.db.deleteAccount(id);
    }
    return removed;
  }

  listAccounts() {
    if (this.sharedMode) {
      this.syncSharedAccounts().catch(() => {});
    }

    return Array.from(this.accounts.values()).map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      requestCount: a.requestCount,
      errorCount: a.errorCount,
      createdAt: a.createdAt,
      lastUsedAt: a.lastUsedAt,
      usage: a.usage || null
    }));
  }

  async refreshAccountUsage(id) {
    if (this.sharedMode) {
      await this.syncSharedAccounts();
    }

    const account = this.accounts.get(id);
    if (!account) return null;

    try {
      const tm = this.tokenManagers.get(id);
      const token = await tm.ensureValidToken();
      const usage = await checkUsageLimits(token, this.config);

      account.usage = {
        usageLimit: usage.usageLimit,
        currentUsage: usage.currentUsage,
        available: usage.available,
        userEmail: usage.userEmail,
        subscriptionType: usage.subscriptionType,
        nextReset: usage.nextReset,
        updatedAt: new Date().toISOString()
      };

      // 写入数据库
      if (this.db && !this.sharedMode) {
        this.db.updateAccount(id, { usage: account.usage });
      }

      return account.usage;
    } catch (e) {
      console.error(`刷新账号 ${id} 额度失败:`, e.message);
      return { error: e.message };
    }
  }

  async refreshAllUsage() {
    if (this.sharedMode) {
      await this.syncSharedAccounts();
    }

    const results = [];
    for (const [id, account] of this.accounts) {
      if (account.status !== 'invalid') {
        const usage = await this.refreshAccountUsage(id);
        results.push({ id, name: account.name, usage });
      }
    }
    return results;
  }

  async selectAccount() {
    if (this.sharedMode) {
      await this.syncSharedAccounts();
    }

    const available = Array.from(this.accounts.values())
      .filter(a => a.status === 'active');

    if (available.length === 0) return null;

    let selected;
    switch (this.strategy) {
      case 'random':
        selected = available[Math.floor(Math.random() * available.length)];
        break;
      case 'least-used':
        selected = available.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
        break;
      default: // round-robin
        selected = available[this.roundRobinIndex % available.length];
        this.roundRobinIndex++;
    }

    selected.requestCount++;
    selected.lastUsedAt = new Date().toISOString();

    // 异步写入数据库，不阻塞请求
    if (this.db && !this.sharedMode) {
      setImmediate(() => {
        this.db.updateAccount(selected.id, {
          requestCount: selected.requestCount,
          lastUsedAt: selected.lastUsedAt
        });
      });
    }

    return {
      id: selected.id,
      name: selected.name,
      tokenManager: this.tokenManagers.get(selected.id)
    };
  }

  async recordError(id, isRateLimit) {
    const account = this.accounts.get(id);
    if (!account) return;

    account.errorCount++;
    if (isRateLimit) {
      account.status = 'cooldown';
      setTimeout(() => {
        if (account.status === 'cooldown') {
          account.status = 'active';
          if (this.db && !this.sharedMode) {
            this.db.updateAccount(id, { status: 'active' });
          }
        }
      }, 5 * 60 * 1000); // 5分钟冷却
    }

    // 写入数据库
    if (this.db && !this.sharedMode) {
      this.db.updateAccount(id, {
        errorCount: account.errorCount,
        status: account.status
      });
    }
  }

  async markInvalid(id) {
    const account = this.accounts.get(id);
    if (account) {
      account.status = 'invalid';
      if (this.db && !this.sharedMode) {
        this.db.updateAccount(id, { status: 'invalid' });
      }
    }
  }

  async enableAccount(id) {
    if (this.sharedMode) {
      return false;
    }

    const account = this.accounts.get(id);
    if (account) {
      account.status = 'active';
      if (this.db) {
        this.db.updateAccount(id, { status: 'active' });
      }
      return true;
    }
    return false;
  }

  async disableAccount(id) {
    if (this.sharedMode) {
      return false;
    }

    const account = this.accounts.get(id);
    if (account) {
      account.status = 'disabled';
      if (this.db) {
        this.db.updateAccount(id, { status: 'disabled' });
      }
      return true;
    }
    return false;
  }

  async recoverCooldown(id) {
    if (this.sharedMode) {
      await this.syncSharedAccounts();
    }

    const account = this.accounts.get(id);
    if (!account) return false;

    if (account.status === 'cooldown') {
      account.status = 'active';
      if (this.db && !this.sharedMode) {
        this.db.updateAccount(id, { status: 'active' });
      }
    }

    return true;
  }

  async recoverAllCooldowns() {
    if (this.sharedMode) {
      await this.syncSharedAccounts();
    }

    let recovered = 0;
    for (const [id, account] of this.accounts.entries()) {
      if (account.status !== 'cooldown') continue;
      account.status = 'active';
      recovered++;
      if (this.db && !this.sharedMode) {
        this.db.updateAccount(id, { status: 'active' });
      }
    }

    return {
      total: this.accounts.size,
      recovered
    };
  }

  setStrategy(strategy) {
    this.strategy = strategy;
  }

  getStrategy() {
    return this.strategy;
  }

  getStats() {
    if (this.sharedMode) {
      this.syncSharedAccounts().catch(() => {});
    }

    const accounts = Array.from(this.accounts.values());
    return {
      total: accounts.length,
      active: accounts.filter(a => a.status === 'active').length,
      cooldown: accounts.filter(a => a.status === 'cooldown').length,
      invalid: accounts.filter(a => a.status === 'invalid').length,
      disabled: accounts.filter(a => a.status === 'disabled').length,
      totalRequests: accounts.reduce((sum, a) => sum + a.requestCount, 0),
      totalErrors: accounts.reduce((sum, a) => sum + a.errorCount, 0)
    };
  }

  addLog(log) {
    if (this.db) {
      this.db.insertLog({
        timestamp: log.timestamp || new Date().toISOString(),
        accountId: log.accountId,
        accountName: log.accountName,
        model: log.model,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        durationMs: log.durationMs,
        success: log.success,
        errorMessage: log.errorMessage,
        apiKey: log.apiKey,
        stream: log.stream,
        upstreamModel: log.upstreamModel
      });
    }
  }

  getRecentLogs(limit = 100, offset = 0) {
    if (this.db) {
      return this.db.getRecentLogs(limit, offset);
    }
    return [];
  }

  async removeAccounts(ids) {
    if (this.sharedMode) {
      return { total: ids.length, removed: 0 };
    }

    let removed = 0;
    for (const id of ids) {
      if (this.accounts.delete(id)) {
        this.tokenManagers.delete(id);
        removed++;
      }
    }
    if (removed > 0 && this.db) {
      this.db.deleteAccounts(ids);
    }
    return { total: ids.length, removed };
  }

  getLogStats() {
    if (this.db) {
      return this.db.getLogStats();
    }
    return {
      totalLogs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      successCount: 0,
      failureCount: 0
    };
  }
}

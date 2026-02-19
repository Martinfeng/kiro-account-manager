import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Square, RefreshCw, Server, Activity, RotateCcw } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'

const DEFAULTS = {
  projectPath: '',
  host: '0.0.0.0',
  port: 8080,
  apiKey: 'sk-default-key',
  adminKey: 'admin-default-key',
  proxyUrl: '',
  region: 'us-east-1',
  kiroVersion: '0.9.2',
}

const LEGACY_NODE_PATH_RE = /kiro2api-node/i

const isLegacyNodeProjectPath = (value) => {
  if (!value) return false
  return LEGACY_NODE_PATH_RE.test(String(value).replace(/\\/g, '/'))
}

function Kiro2ApiManager() {
  const { theme, colors } = useTheme()
  const isDark = theme === 'dark'

  const [form, setForm] = useState(DEFAULTS)
  const [status, setStatus] = useState({
    running: false,
    healthy: false,
    pid: null,
    port: null,
    url: null,
    projectPath: null,
    logPath: null,
    sharedAccountsFile: null,
  })
  const [credentials, setCredentials] = useState([])
  const [summary, setSummary] = useState({ total: 0, available: 0, currentId: null })
  const [requestLogs, setRequestLogs] = useState([])
  const [loadBalancingMode, setLoadBalancingMode] = useState('priority')
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [actioningIds, setActioningIds] = useState([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const getAdminBaseUrls = (port) => {
    const set = new Set()
    const hostRaw = (form.host || '').trim()
    const normalized = !hostRaw || hostRaw === '0.0.0.0' || hostRaw === '::' || hostRaw === '[::]'
      ? '127.0.0.1'
      : hostRaw
    set.add(`http://${normalized}:${port}`)
    set.add(`http://127.0.0.1:${port}`)
    set.add(`http://localhost:${port}`)
    return [...set]
  }

  const fetchAdmin = async (path, init, port) => {
    const targets = getAdminBaseUrls(port)
    let lastResponse = null
    let lastError = null

    for (const base of targets) {
      try {
        const res = await fetch(`${base}${path}`, init)
        if (res.ok) return res
        if (res.status === 401 || res.status === 403) return res
        lastResponse = res
      } catch (e) {
        lastError = e
      }
    }

    if (lastResponse) return lastResponse
    throw lastError || new Error('Admin API not reachable')
  }

  const setField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const formatLogTime = (value) => {
    if (!value || value === '-') return '-'
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    return d.toLocaleString()
  }

  const statusClass = (code) => {
    if (code >= 500) return 'bg-red-500/15 text-red-500'
    if (code >= 400) return 'bg-amber-500/15 text-amber-500'
    if (code >= 300) return 'bg-sky-500/15 text-sky-500'
    return 'bg-emerald-500/15 text-emerald-500'
  }

  const parseError = async (res, fallback = '请求失败') => {
    try {
      const data = await res.json()
      return data?.error?.message || data?.message || fallback
    } catch (_) {
      return fallback
    }
  }

  const loadSettings = async () => {
    try {
      const settings = await invoke('get_app_settings').catch(() => ({}))
      const rawProjectPath = (settings.kiro2apiProjectPath || '').trim()
      const projectPath = isLegacyNodeProjectPath(rawProjectPath) ? '' : rawProjectPath
      const rawKiroVersion = (settings.kiro2apiKiroVersion || DEFAULTS.kiroVersion).trim()
      const kiroVersion = /^0\.8\./.test(rawKiroVersion) ? DEFAULTS.kiroVersion : rawKiroVersion

      setForm({
        projectPath,
        host: (settings.kiro2apiHost || DEFAULTS.host).trim() || DEFAULTS.host,
        port: settings.kiro2apiPort || DEFAULTS.port,
        apiKey: settings.kiro2apiApiKey || DEFAULTS.apiKey,
        adminKey: settings.kiro2apiAdminKey || DEFAULTS.adminKey,
        proxyUrl: settings.kiro2apiProxyUrl || DEFAULTS.proxyUrl,
        region: settings.kiro2apiRegion || DEFAULTS.region,
        kiroVersion,
      })

      if (projectPath !== rawProjectPath || kiroVersion !== rawKiroVersion) {
        await invoke('save_app_settings', {
          settings: {
            kiro2apiProjectPath: projectPath || null,
            kiro2apiKiroVersion: kiroVersion,
          },
        }).catch(() => {})
      }
    } catch (_) {
      // ignore
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      const normalizedPath = isLegacyNodeProjectPath(form.projectPath.trim())
        ? ''
        : form.projectPath.trim()
      await invoke('save_app_settings', {
        settings: {
          kiro2apiProjectPath: normalizedPath || null,
          kiro2apiHost: form.host.trim() || DEFAULTS.host,
          kiro2apiPort: Number(form.port) || DEFAULTS.port,
          kiro2apiApiKey: form.apiKey.trim() || DEFAULTS.apiKey,
          kiro2apiAdminKey: form.adminKey.trim() || DEFAULTS.adminKey,
          kiro2apiProxyUrl: form.proxyUrl.trim(),
          kiro2apiRegion: form.region.trim() || DEFAULTS.region,
          kiro2apiKiroVersion: form.kiroVersion.trim() || DEFAULTS.kiroVersion,
        },
      })
      setSuccess('配置已保存')
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const loadAdminData = async (adminKey, port) => {
    try {
      const headers = { Authorization: `Bearer ${adminKey}` }
      const [credRes, modeRes] = await Promise.all([
        fetchAdmin('/api/admin/credentials', { headers }, port),
        fetchAdmin('/api/admin/config/load-balancing', { headers }, port),
      ])

      if (credRes.ok) {
        const credData = await credRes.json()
        setCredentials(Array.isArray(credData?.credentials) ? credData.credentials : [])
        setSummary({
          total: Number(credData?.total || 0),
          available: Number(credData?.available || 0),
          currentId: credData?.currentId || null,
        })
      } else {
        setCredentials([])
        setSummary({ total: 0, available: 0, currentId: null })
      }

      if (modeRes.ok) {
        const modeData = await modeRes.json()
        if (modeData?.mode) {
          setLoadBalancingMode(modeData.mode)
        }
      }
    } catch (_) {
      // ignore transient failures
    }
  }

  const loadRequestLogs = async (limit = 120) => {
    try {
      const logs = await invoke('get_kiro2api_request_logs', { limit })
      setRequestLogs(Array.isArray(logs) ? logs : [])
    } catch (_) {
      setRequestLogs([])
    }
  }

  const loadStatus = async (silent = true) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await invoke('get_kiro2api_status')
      setStatus(res)
      if (res.running && form.adminKey.trim()) {
        const port = res.port || form.port
        await Promise.all([
          loadAdminData(form.adminKey.trim(), port),
          loadRequestLogs(120),
        ])
      } else {
        setCredentials([])
        setSummary({ total: 0, available: 0, currentId: null })
        setRequestLogs([])
      }
    } catch (e) {
      setError(String(e))
    } finally {
      if (!silent) setRefreshing(false)
    }
  }

  const handleStart = async () => {
    setStarting(true)
    setError('')
    setSuccess('')
    try {
      const normalizedPath = isLegacyNodeProjectPath(form.projectPath.trim())
        ? ''
        : form.projectPath.trim()
      if (normalizedPath !== form.projectPath.trim()) {
        setField('projectPath', '')
      }
      await saveSettings()
      const res = await invoke('start_kiro2api_service', {
        params: {
          projectPath: normalizedPath || null,
          host: form.host.trim() || DEFAULTS.host,
          port: Number(form.port) || DEFAULTS.port,
          apiKey: form.apiKey.trim() || DEFAULTS.apiKey,
          adminKey: form.adminKey.trim() || DEFAULTS.adminKey,
          proxyUrl: form.proxyUrl.trim() || null,
          region: form.region.trim() || DEFAULTS.region,
          kiroVersion: form.kiroVersion.trim() || DEFAULTS.kiroVersion,
        },
      })
      setStatus(res)
      setSuccess('Kiro2API（Rust）已启动')
      await loadStatus()
    } catch (e) {
      setError(String(e))
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    setError('')
    setSuccess('')
    try {
      const res = await invoke('stop_kiro2api_service', {
        port: Number(form.port) || DEFAULTS.port,
      })
      setStatus(res)
      setCredentials([])
      setSummary({ total: 0, available: 0, currentId: null })
      setRequestLogs([])
      setSuccess('Kiro2API 已停止')
    } catch (e) {
      setError(String(e))
    } finally {
      setStopping(false)
    }
  }

  const handleApplyMode = async () => {
    setError('')
    setSuccess('')
    try {
      const port = status.port || form.port || DEFAULTS.port
      const res = await fetchAdmin('/api/admin/config/load-balancing', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${form.adminKey.trim()}`,
        },
        body: JSON.stringify({ mode: loadBalancingMode }),
      }, port)
      if (!res.ok) {
        throw new Error(await parseError(res, `设置失败 (${res.status})`))
      }
      setSuccess('负载模式已更新')
      await loadStatus()
    } catch (e) {
      setError(String(e))
    }
  }

  const withAction = async (id, action) => {
    setActioningIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    try {
      await action()
    } finally {
      setActioningIds(prev => prev.filter(x => x !== id))
    }
  }

  const handleResetCredential = async (id) => {
    setError('')
    setSuccess('')
    await withAction(id, async () => {
      const port = status.port || form.port || DEFAULTS.port
      const res = await fetchAdmin(`/api/admin/credentials/${id}/reset`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${form.adminKey.trim()}`,
        },
      }, port)
      if (!res.ok) {
        throw new Error(await parseError(res, `重置失败 (${res.status})`))
      }
      setSuccess(`凭据 #${id} 已重置`) 
      await loadStatus()
    }).catch(e => setError(String(e)))
  }

  const handleToggleCredential = async (item) => {
    setError('')
    setSuccess('')
    await withAction(item.id, async () => {
      const port = status.port || form.port || DEFAULTS.port
      const res = await fetchAdmin(`/api/admin/credentials/${item.id}/disabled`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${form.adminKey.trim()}`,
        },
        body: JSON.stringify({ disabled: !item.disabled }),
      }, port)
      if (!res.ok) {
        throw new Error(await parseError(res, `更新失败 (${res.status})`))
      }
      setSuccess(`凭据 #${item.id} 状态已更新`) 
      await loadStatus()
    }).catch(e => setError(String(e)))
  }

  useEffect(() => {
    loadSettings()
    loadStatus()
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      loadStatus()
    }, 8000)
    return () => clearInterval(timer)
  }, [form.adminKey, form.port])

  return (
    <div className={`h-full overflow-auto ${colors.main}`}>
      <div className="max-w-6xl mx-auto p-8 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-cyan-500/25">
            <Server size={24} className="text-white" />
          </div>
          <div>
            <h1 className={`text-2xl font-bold ${colors.text}`}>Kiro2API</h1>
            <p className={`text-sm ${colors.textMuted}`}>Rust 引擎（kiro.rs）- 共用当前账号池（accounts.json）</p>
          </div>
        </div>

        {(error || success) && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${error ? 'border-red-400/40 bg-red-500/10 text-red-500' : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-500'}`}>
            {error || success}
          </div>
        )}

        <div className={`${colors.card} border ${colors.cardBorder} rounded-2xl p-5`}>
          <div className="flex items-center justify-between mb-4">
            <div className={`font-semibold ${colors.text}`}>服务状态</div>
            <button
              onClick={() => loadStatus(false)}
              className={`p-2 rounded-lg ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}
            >
              <RefreshCw size={16} className={`${colors.textMuted} ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className={`rounded-xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className={colors.textMuted}>运行状态</div>
              <div className={`${colors.text} font-semibold`}>{status.running ? '运行中' : '未运行'}</div>
            </div>
            <div className={`rounded-xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className={colors.textMuted}>健康检查</div>
              <div className={`${colors.text} font-semibold`}>{status.healthy ? '正常' : '不可达'}</div>
            </div>
            <div className={`rounded-xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className={colors.textMuted}>PID</div>
              <div className={`${colors.text} font-semibold`}>{status.pid || '-'}</div>
            </div>
            <div className={`rounded-xl p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <div className={colors.textMuted}>端口</div>
              <div className={`${colors.text} font-semibold`}>{status.port || form.port}</div>
            </div>
          </div>
          {status.sharedAccountsFile && (
            <div className={`mt-3 text-xs ${colors.textMuted}`}>
              共享账号文件: <span className={colors.text}>{status.sharedAccountsFile}</span>
            </div>
          )}
          {status.projectPath && (
            <div className={`mt-1 text-xs ${colors.textMuted}`}>
              运行时路径: <span className={colors.text}>{status.projectPath}</span>
            </div>
          )}
          {status.logPath && (
            <div className={`mt-1 text-xs ${colors.textMuted}`}>
              日志文件: <span className={colors.text}>{status.logPath}</span>
            </div>
          )}
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleStart}
              disabled={starting || status.running}
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              <Play size={14} />
              {starting ? '启动中...' : '启动服务'}
            </button>
            <button
              onClick={handleStop}
              disabled={stopping || !status.running}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              <Square size={14} />
              {stopping ? '停止中...' : '停止服务'}
            </button>
          </div>
        </div>

        <div className={`${colors.card} border ${colors.cardBorder} rounded-2xl p-5`}>
          <div className={`font-semibold ${colors.text} mb-4`}>启动配置</div>
          <div className={`mb-4 text-xs ${colors.textMuted}`}>
            提示：kiro.rs 没有 Web 管理页，管理功能在当前 TAB。局域网访问请把监听地址设为 `0.0.0.0`，并用 `/v1/models`（需 `x-api-key`）测试。
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <label className="space-y-1 md:col-span-2">
              <div className={colors.textMuted}>运行时路径（可选）</div>
              <input
                value={form.projectPath}
                onChange={e => setField('projectPath', e.target.value)}
                placeholder="留空使用内置离线 kiro-rs，或填写本地 kiro-rs 可执行文件/项目路径"
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>监听地址</div>
              <input
                value={form.host}
                onChange={e => setField('host', e.target.value)}
                placeholder="0.0.0.0（允许局域网访问）"
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>端口</div>
              <input
                type="number"
                value={form.port}
                onChange={e => setField('port', Number(e.target.value))}
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>Region</div>
              <input
                value={form.region}
                onChange={e => setField('region', e.target.value)}
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>API Key</div>
              <input
                value={form.apiKey}
                onChange={e => setField('apiKey', e.target.value)}
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>Admin Key</div>
              <input
                value={form.adminKey}
                onChange={e => setField('adminKey', e.target.value)}
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>Kiro Version</div>
              <input
                value={form.kiroVersion}
                onChange={e => setField('kiroVersion', e.target.value)}
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
            <label className="space-y-1">
              <div className={colors.textMuted}>代理 (可选)</div>
              <input
                value={form.proxyUrl}
                onChange={e => setField('proxyUrl', e.target.value)}
                placeholder="http://127.0.0.1:7890"
                className={`w-full px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              />
            </label>
          </div>
          <button
            onClick={saveSettings}
            disabled={saving}
            className={`mt-4 px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-900'} disabled:opacity-50`}
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>

        <div className={`${colors.card} border ${colors.cardBorder} rounded-2xl p-5`}>
          <div className="flex items-center gap-2 mb-3">
            <Activity size={16} className={colors.textMuted} />
            <div className={`font-semibold ${colors.text}`}>运行信息</div>
          </div>
          <div className={`text-sm ${colors.textMuted} space-y-2`}>
            <div className={`pt-1 ${colors.text}`}>
              <div>凭据池: total={summary.total}, available={summary.available}, current={summary.currentId || '-'}</div>
            </div>
            <div className="flex gap-2 items-center">
              <select
                value={loadBalancingMode}
                onChange={e => setLoadBalancingMode(e.target.value)}
                className={`px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              >
                <option value="priority">priority</option>
                <option value="balanced">balanced</option>
              </select>
              <button
                onClick={handleApplyMode}
                disabled={!status.running}
                className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
              >
                应用负载模式
              </button>
            </div>
          </div>
        </div>

        <div className={`${colors.card} border ${colors.cardBorder} rounded-2xl p-5`}>
          <div className={`font-semibold ${colors.text} mb-3`}>凭据状态（Admin API）</div>

          {!status.running && (
            <div className={`text-sm ${colors.textMuted}`}>服务未启动，无法读取凭据状态。</div>
          )}

          {status.running && credentials.length === 0 && (
            <div className={`text-sm ${colors.textMuted}`}>暂无凭据数据或 Admin Key 不匹配。</div>
          )}

          {status.running && credentials.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`text-left ${colors.textMuted}`}>
                    <th className="py-2 pr-4">ID</th>
                    <th className="py-2 pr-4">邮箱</th>
                    <th className="py-2 pr-4">认证</th>
                    <th className="py-2 pr-4">状态</th>
                    <th className="py-2 pr-4">失败计数</th>
                    <th className="py-2 pr-4">优先级</th>
                    <th className="py-2 pr-4">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {credentials.map(item => {
                    const busy = actioningIds.includes(item.id)
                    return (
                      <tr key={item.id} className={`border-t ${colors.cardBorder}`}>
                        <td className={`py-2 pr-4 ${colors.text}`}>{item.id}{item.isCurrent ? ' *' : ''}</td>
                        <td className={`py-2 pr-4 ${colors.text}`}>{item.email || '-'}</td>
                        <td className={`py-2 pr-4 ${colors.text}`}>{item.authMethod || '-'}</td>
                        <td className={`py-2 pr-4 ${colors.text}`}>{item.disabled ? '已禁用' : '可用'}</td>
                        <td className={`py-2 pr-4 ${colors.text}`}>{item.failureCount ?? 0}</td>
                        <td className={`py-2 pr-4 ${colors.text}`}>{item.priority}</td>
                        <td className="py-2 pr-4">
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleResetCredential(item.id)}
                              disabled={busy}
                              className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs disabled:opacity-50 flex items-center gap-1"
                            >
                              <RotateCcw size={12} className={busy ? 'animate-spin' : ''} />
                              重置
                            </button>
                            <button
                              onClick={() => handleToggleCredential(item)}
                              disabled={busy}
                              className="px-2 py-1 rounded bg-slate-600 hover:bg-slate-700 text-white text-xs disabled:opacity-50"
                            >
                              {item.disabled ? '启用' : '禁用'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={`${colors.card} border ${colors.cardBorder} rounded-2xl p-5`}>
          <div className={`font-semibold ${colors.text} mb-3`}>请求日志（最近 120 条）</div>
          {!status.running && (
            <div className={`text-sm ${colors.textMuted}`}>服务未启动，暂无请求日志。</div>
          )}
          {status.running && requestLogs.length === 0 && (
            <div className={`text-sm ${colors.textMuted}`}>暂无可解析日志记录。</div>
          )}
          {status.running && requestLogs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`text-left ${colors.textMuted}`}>
                    <th className="py-2 pr-4">请求时间</th>
                    <th className="py-2 pr-4">Session ID</th>
                    <th className="py-2 pr-4">模型</th>
                    <th className="py-2 pr-4">返回码</th>
                  </tr>
                </thead>
                <tbody>
                  {requestLogs.map((log, idx) => (
                    <tr key={`${log.timestamp}-${log.model}-${idx}`} className={`border-t ${colors.cardBorder}`}>
                      <td className={`py-2 pr-4 ${colors.text}`}>{formatLogTime(log.timestamp)}</td>
                      <td className={`py-2 pr-4 ${colors.text}`} title={log.sessionId || ''}>
                        <span className="font-mono">{log.sessionId || '-'}</span>
                      </td>
                      <td className={`py-2 pr-4 ${colors.text}`} title={log.model}>
                        <span className="font-mono">{log.model}</span>
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          title={log.statusText || ''}
                          className={`inline-flex px-2 py-0.5 rounded text-xs font-medium cursor-help ${statusClass(Number(log.statusCode || 0))}`}
                        >
                          {log.statusCode}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className={`mt-2 text-xs ${colors.textMuted}`}>
            提示：将鼠标移到返回码上可查看状态详情。
          </div>
        </div>
      </div>
    </div>
  )
}

export default Kiro2ApiManager

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Play, Square, RefreshCw, ExternalLink, Server, Activity } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'

const DEFAULTS = {
  projectPath: '/Users/feng/project/Kiro2api-Node',
  port: 8080,
  apiKey: 'sk-default-key',
  adminKey: 'admin-default-key',
  proxyUrl: '',
  region: 'us-east-1',
  kiroVersion: '0.8.0',
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
  const [serviceInfo, setServiceInfo] = useState(null)
  const [strategy, setStrategy] = useState('round-robin')
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const baseUrl = useMemo(() => {
    const port = form.port || status.port || 8080
    return `http://127.0.0.1:${port}`
  }, [form.port, status.port])

  const setField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const loadSettings = async () => {
    try {
      const settings = await invoke('get_app_settings').catch(() => ({}))
      setForm({
        projectPath: settings.kiro2apiProjectPath || DEFAULTS.projectPath,
        port: settings.kiro2apiPort || DEFAULTS.port,
        apiKey: settings.kiro2apiApiKey || DEFAULTS.apiKey,
        adminKey: settings.kiro2apiAdminKey || DEFAULTS.adminKey,
        proxyUrl: settings.kiro2apiProxyUrl || DEFAULTS.proxyUrl,
        region: settings.kiro2apiRegion || DEFAULTS.region,
        kiroVersion: settings.kiro2apiKiroVersion || DEFAULTS.kiroVersion,
      })
    } catch (_) {
      // ignore
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      await invoke('save_app_settings', {
        settings: {
          kiro2apiProjectPath: form.projectPath.trim(),
          kiro2apiPort: Number(form.port) || DEFAULTS.port,
          kiro2apiApiKey: form.apiKey.trim(),
          kiro2apiAdminKey: form.adminKey.trim(),
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

  const loadStatus = async (silent = true) => {
    if (!silent) setRefreshing(true)
    try {
      const res = await invoke('get_kiro2api_status')
      setStatus(res)
      if (res.running && form.adminKey) {
        await loadServiceInfo(form.adminKey, res.port || form.port)
      } else {
        setServiceInfo(null)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      if (!silent) setRefreshing(false)
    }
  }

  const loadServiceInfo = async (adminKey, port) => {
    try {
      const headers = { Authorization: `Bearer ${adminKey}` }
      const [statusRes, strategyRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/status`, { headers }),
        fetch(`http://127.0.0.1:${port}/api/strategy`, { headers }),
      ])

      if (statusRes.ok) {
        const statusData = await statusRes.json()
        setServiceInfo(statusData)
      }
      if (strategyRes.ok) {
        const strategyData = await strategyRes.json()
        if (strategyData?.strategy) {
          setStrategy(strategyData.strategy)
        }
      }
    } catch (_) {
      // ignore transient failures
    }
  }

  const handleStart = async () => {
    setStarting(true)
    setError('')
    setSuccess('')
    try {
      await saveSettings()
      const res = await invoke('start_kiro2api_service', {
        params: {
          projectPath: form.projectPath.trim(),
          port: Number(form.port) || DEFAULTS.port,
          apiKey: form.apiKey.trim() || DEFAULTS.apiKey,
          adminKey: form.adminKey.trim() || DEFAULTS.adminKey,
          proxyUrl: form.proxyUrl.trim() || null,
          region: form.region.trim() || DEFAULTS.region,
          kiroVersion: form.kiroVersion.trim() || DEFAULTS.kiroVersion,
        },
      })
      setStatus(res)
      setSuccess('Kiro2API 已启动')
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
      const res = await invoke('stop_kiro2api_service')
      setStatus(res)
      setServiceInfo(null)
      setSuccess('Kiro2API 已停止')
    } catch (e) {
      setError(String(e))
    } finally {
      setStopping(false)
    }
  }

  const handleApplyStrategy = async () => {
    setError('')
    setSuccess('')
    try {
      const res = await fetch(`${baseUrl}/api/strategy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${form.adminKey.trim()}`,
        },
        body: JSON.stringify({ strategy }),
      })
      if (!res.ok) {
        throw new Error(`设置策略失败 (${res.status})`)
      }
      setSuccess('调度策略已更新')
    } catch (e) {
      setError(String(e))
    }
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
            <p className={`text-sm ${colors.textMuted}`}>共用当前账号池（accounts.json）的 API 代理控制面板</p>
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
            <button
              onClick={() => openUrl(`${baseUrl}/login`)}
              disabled={!status.running}
              className={`px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2 ${isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-900'}`}
            >
              <ExternalLink size={14} />
              打开管理页
            </button>
          </div>
        </div>

        <div className={`${colors.card} border ${colors.cardBorder} rounded-2xl p-5`}>
          <div className={`font-semibold ${colors.text} mb-4`}>启动配置</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <label className="space-y-1">
              <div className={colors.textMuted}>项目路径</div>
              <input
                value={form.projectPath}
                onChange={e => setField('projectPath', e.target.value)}
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
              <div className={colors.textMuted}>Region</div>
              <input
                value={form.region}
                onChange={e => setField('region', e.target.value)}
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
            <label className="space-y-1 md:col-span-2">
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
            <div>请求调度策略（代理服务侧）：</div>
            <div className="flex gap-2 items-center">
              <select
                value={strategy}
                onChange={e => setStrategy(e.target.value)}
                className={`px-3 py-2 rounded-lg border ${colors.cardBorder} ${colors.input} ${colors.text}`}
              >
                <option value="round-robin">round-robin</option>
                <option value="random">random</option>
                <option value="least-used">least-used</option>
              </select>
              <button
                onClick={handleApplyStrategy}
                disabled={!status.running}
                className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
              >
                应用策略
              </button>
            </div>
            {serviceInfo && (
              <div className={`pt-2 ${colors.text}`}>
                <div>服务状态: {serviceInfo.status || '-'}</div>
                <div>运行时长: {serviceInfo.uptimeSecs || 0}s</div>
                <div>账号池: total={serviceInfo.pool?.total || 0}, active={serviceInfo.pool?.active || 0}</div>
              </div>
            )}
            {!serviceInfo && <div>服务未返回状态信息，请确认服务已启动且 Admin Key 正确。</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Kiro2ApiManager

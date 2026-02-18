import fetch from 'node-fetch';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class KiroApiError extends Error {
  constructor(status, responseText, requestDebug) {
    super(`Kiro API 错误: ${status} - ${responseText}`);
    this.name = 'KiroApiError';
    this.status = status;
    this.responseText = responseText;
    this.requestDebug = requestDebug;
  }
}

/**
 * Kiro API 客户端
 * 负责与 Kiro API 通信，支持流式和非流式请求
 */
export class KiroClient {
  constructor(config, tokenManager, dbManager) {
    this.config = config;
    this.tokenManager = tokenManager;
    this.dbManager = dbManager;
  }

  getCompatMode() {
    const mode = this.coerceString(this.config?.anthropicCompatMode, '').trim().toLowerCase();
    if (mode === 'strict' || mode === 'balanced' || mode === 'relaxed') {
      return mode;
    }
    return 'strict';
  }

  getFallbackModes() {
    const mode = this.getCompatMode();
    if (mode === 'strict') {
      // strict: keep capability/semantics first, only apply the lightest schema compaction retry
      return ['primary', 'compact-tools'];
    }
    if (mode === 'balanced') {
      return ['primary', 'compact-tools', 'no-tools', 'trim-history'];
    }
    return ['primary', 'compact-tools', 'no-tools', 'trim-history', 'minimal-history', 'single-turn'];
  }

  sanitizeToolName(name) {
    const raw = String(name ?? '');
    const replaced = raw.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
    const trimmed = replaced.replace(/^_+|_+$/g, '');
    const safe = trimmed.length > 0 ? trimmed : 'tool';
    return /^[0-9]/.test(safe) ? `t_${safe}` : safe;
  }

  getOrCreateKiroToolName(originalName, toolNameMap, usedNames) {
    if (toolNameMap.has(originalName)) return toolNameMap.get(originalName);
    const base = this.sanitizeToolName(originalName);
    let candidate = base;
    let i = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}_${i++}`;
    }
    usedNames.add(candidate);
    toolNameMap.set(originalName, candidate);
    return candidate;
  }

  safeJsonStringify(value, fallback = '{}') {
    if (value == null) return fallback;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  normalizeJsonObject(value, fallback = {}) {
    if (value == null) return fallback;
    let normalized = value;

    if (typeof normalized === 'string') {
      try {
        normalized = JSON.parse(normalized);
      } catch {
        return fallback;
      }
    }

    if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
      return fallback;
    }

    return normalized;
  }

  coerceString(value, fallback = '') {
    if (typeof value === 'string') return value;
    if (value == null) return fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  truncateString(value, maxLen = 12000) {
    const str = this.coerceString(value, '');
    if (str.length <= maxLen) return str;
    return `${str.slice(0, maxLen)}\n...[truncated]`;
  }

  normalizeMessageList(rawMessages) {
    if (!Array.isArray(rawMessages)) return [];

    const normalized = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== 'object') continue;
      const role = String(raw.role || '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      normalized.push({
        role,
        content: raw.content
      });
      if (normalized.length >= 200) break;
    }
    return normalized;
  }

  normalizeContentBlocks(content) {
    if (content == null) return [];
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    if (Array.isArray(content)) {
      return content
        .filter(item => item != null)
        .map(item => {
          if (typeof item === 'string') return { type: 'text', text: item };
          if (typeof item === 'object') return item;
          return { type: 'text', text: String(item) };
        });
    }
    if (typeof content === 'object') {
      return [content];
    }
    return [{ type: 'text', text: String(content) }];
  }

  extractTextFromAny(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value.map(v => this.extractTextFromAny(v)).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      if (Array.isArray(value.content)) {
        return value.content.map(v => this.extractTextFromAny(v)).filter(Boolean).join('\n');
      }
      return this.coerceString(value, '');
    }
    return '';
  }

  normalizeToolUseId(value, fallback = 'tool_use') {
    const raw = this.coerceString(value, '').trim();
    if (!raw) return fallback;
    return raw.replace(/[^\w\-:.]/g, '_').slice(0, 128) || fallback;
  }

  extractSystemContent(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
      return system.map(s => this.extractTextFromAny(s)).filter(Boolean).join('\n');
    }
    if (typeof system === 'object') {
      return this.extractTextFromAny(system);
    }
    return '';
  }

  sanitizeSchemaValue(value, depth = 0) {
    if (depth > 6) return undefined;
    if (value == null) return undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return this.truncateString(value, 1024);
    if (Array.isArray(value)) {
      return value
        .slice(0, 32)
        .map(v => this.sanitizeSchemaValue(v, depth + 1))
        .filter(v => v !== undefined);
    }
    if (typeof value !== 'object') return undefined;

    const skipKeys = new Set([
      '$schema',
      '$id',
      '$defs',
      'definitions',
      'examples',
      'example',
      'deprecated',
      'readOnly',
      'writeOnly'
    ]);

    const out = {};
    const entries = Object.entries(value).slice(0, 96);
    for (const [key, rawVal] of entries) {
      if (skipKeys.has(key)) continue;
      const sanitized = this.sanitizeSchemaValue(rawVal, depth + 1);
      if (sanitized === undefined) continue;
      if (key === 'description' || key === 'title') {
        out[key] = this.truncateString(sanitized, 512);
      } else {
        out[key] = sanitized;
      }
    }
    return out;
  }

  buildToolSchema(inputSchema) {
    const normalized = this.normalizeJsonObject(inputSchema || {});
    const sanitized = this.sanitizeSchemaValue(normalized);
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      return { type: 'object', properties: {} };
    }
    if (Object.keys(sanitized).length === 0) {
      return { type: 'object', properties: {} };
    }
    return sanitized;
  }

  shouldRetryImproperlyFormed(status, responseText) {
    if (status !== 400) return false;
    const text = this.coerceString(responseText, '').toLowerCase();
    return (
      text.includes('improperly formed request') ||
      text.includes('malformed') ||
      text.includes('invalid_request_error')
    );
  }

  sanitizeHistoryEntryForRetry(entry, mode) {
    if (!entry || typeof entry !== 'object') return entry;

    if (entry.userInputMessage && typeof entry.userInputMessage === 'object') {
      entry.userInputMessage.content = this.truncateString(entry.userInputMessage.content, 10000);
      const ctx = entry.userInputMessage.userInputMessageContext;
      if (ctx && typeof ctx === 'object') {
        if (mode !== 'compact-tools') delete ctx.toolResults;
        if (
          mode === 'no-tools' ||
          mode === 'trim-history' ||
          mode === 'minimal-history' ||
          mode === 'single-turn'
        ) {
          delete ctx.tools;
        }
        if (Object.keys(ctx).length === 0) {
          delete entry.userInputMessage.userInputMessageContext;
        }
      }
    }

    if (entry.assistantResponseMessage && typeof entry.assistantResponseMessage === 'object') {
      entry.assistantResponseMessage.content = this.truncateString(
        entry.assistantResponseMessage.content,
        10000
      );
      if (mode === 'trim-history' || mode === 'minimal-history' || mode === 'single-turn') {
        delete entry.assistantResponseMessage.toolUses;
      }
    }

    return entry;
  }

  extractLatestUserContentFromHistory(history) {
    if (!Array.isArray(history)) return '';

    for (let i = history.length - 1; i >= 0; i--) {
      const text = this.coerceString(history[i]?.userInputMessage?.content, '').trim();
      if (text && text.toLowerCase() !== 'continue') {
        return text;
      }
    }
    return '';
  }

  buildSingleTurnRequest(baseRequest) {
    const state = baseRequest?.conversationState;
    const current = state?.currentMessage?.userInputMessage || {};

    let content = this.coerceString(current.content, '').trim();
    if (!content || content.toLowerCase() === 'continue') {
      const latestUserContent = this.extractLatestUserContentFromHistory(state?.history);
      if (latestUserContent) {
        content = latestUserContent;
      }
    }
    if (!content) content = 'continue';

    const minimalRequest = {
      conversationState: {
        agentContinuationId: state?.agentContinuationId || uuidv4(),
        agentTaskType: state?.agentTaskType || 'vibe',
        chatTriggerType: 'MANUAL',
        currentMessage: {
          userInputMessage: {
            content: this.truncateString(content, 12000),
            modelId: current.modelId,
            origin: current.origin || 'AI_EDITOR'
          }
        },
        conversationId: state?.conversationId || uuidv4(),
        history: []
      }
    };

    if (baseRequest?.profileArn) {
      minimalRequest.profileArn = baseRequest.profileArn;
    }

    return minimalRequest;
  }

  buildFallbackRequest(baseRequest, mode) {
    let req = baseRequest;
    try {
      req = JSON.parse(JSON.stringify(baseRequest));
    } catch {
      return baseRequest;
    }

    const state = req?.conversationState;
    const current = state?.currentMessage?.userInputMessage;
    if (!state || !current) return req;

    if (mode === 'single-turn') {
      return this.buildSingleTurnRequest(req);
    }

    current.content = this.truncateString(current.content, mode === 'minimal-history' ? 10000 : 20000);

    const ctx = current.userInputMessageContext;
    if (ctx && typeof ctx === 'object') {
      if (mode !== 'compact-tools') delete ctx.toolResults;
      if (mode === 'no-tools' || mode === 'trim-history' || mode === 'minimal-history') {
        delete ctx.tools;
      }

      if (mode === 'compact-tools' && Array.isArray(ctx.tools)) {
        ctx.tools = ctx.tools.slice(0, 24).map(tool => {
          const name = this.coerceString(tool?.toolSpecification?.name, 'tool');
          const description = this.truncateString(tool?.toolSpecification?.description || '', 256);
          return {
            toolSpecification: {
              name,
              description,
              inputSchema: { json: { type: 'object', properties: {} } }
            }
          };
        });
      }

      if (Object.keys(ctx).length === 0) {
        delete current.userInputMessageContext;
      }
    }

    const hasTools = Array.isArray(current.userInputMessageContext?.tools) &&
      current.userInputMessageContext.tools.length > 0;
    if (!hasTools && state.chatTriggerType === 'AUTO') {
      state.chatTriggerType = 'MANUAL';
    }

    if (Array.isArray(state.history)) {
      let history = state.history.map(entry => this.sanitizeHistoryEntryForRetry(entry, mode));
      if (mode === 'trim-history') {
        history = history.slice(-24);
      } else if (mode === 'minimal-history') {
        history = history.slice(-8);
      }
      state.history = history;
    }

    return req;
  }

  summarizeForDebug(value, depth = 0) {
    if (depth > 6) return '[MaxDepth]';
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string') return `<string len=${value.length}>`;
    if (t === 'number' || t === 'boolean') return value;
    if (t !== 'object') return `<${t}>`;
    if (Array.isArray(value)) {
      return {
        _type: 'array',
        length: value.length,
        sample: value.slice(0, 3).map(v => this.summarizeForDebug(v, depth + 1))
      };
    }
    const keys = Object.keys(value).slice(0, 60);
    const out = { _type: 'object', keys };
    for (const k of keys) {
      out[k] = this.summarizeForDebug(value[k], depth + 1);
    }
    return out;
  }

  /**
   * 模型映射：Anthropic 模型名 -> Kiro 模型 ID
   * 从数据库读取映射规则
   */
  mapModel(model) {
    if (!this.dbManager) {
      // 如果没有数据库管理器，使用默认映射
      const lower = model.toLowerCase();
      if (lower.includes('sonnet')) return 'claude-sonnet-4-6-20260217-thinking';
      if (lower.includes('opus')) return 'claude-opus-4.6';
      if (lower.includes('haiku')) return 'claude-haiku-4-5-20251001';
      return null;
    }

    const mapping = this.dbManager.findModelMapping(model);
    return mapping ? mapping.internalId : null;
  }

  /**
   * 构建请求头
   */
  buildHeaders(token) {
    const region = this.config.region || 'us-east-1';
    const kiroVersion = this.config.kiroVersion || '0.8.0';
    const machineId = this.tokenManager.credentials.machineId || crypto.randomBytes(32).toString('hex');
    
    const osName = 'windows';
    const nodeVersion = '20.0.0';
    
    const xAmzUserAgent = `aws-sdk-js/1.0.27 KiroIDE-${kiroVersion}-${machineId}`;
    const userAgent = `aws-sdk-js/1.0.27 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.27 m/E KiroIDE-${kiroVersion}-${machineId}`;

    return {
      'Content-Type': 'application/json',
      'x-amzn-codewhisperer-optout': 'true',
      'x-amzn-kiro-agent-mode': 'vibe',
      'x-amz-user-agent': xAmzUserAgent,
      'User-Agent': userAgent,
      'Host': `q.${region}.amazonaws.com`,
      'amz-sdk-invocation-id': uuidv4(),
      'amz-sdk-request': 'attempt=1; max=3',
      'Authorization': `Bearer ${token}`,
      'Connection': 'close'
    };
  }

  /**
   * 将 Anthropic 请求转换为 Kiro 请求
   */
  convertRequest(anthropicReq) {
    const modelId = this.mapModel(anthropicReq.model);
    if (!modelId) {
      throw new Error(`不支持的模型: ${anthropicReq.model}`);
    }

    const toolNameMap = new Map();
    const usedToolNames = new Set();

    const messages = this.normalizeMessageList(anthropicReq.messages);
    if (messages.length === 0) {
      throw new Error('消息数组不能为空');
    }

    const conversationId = uuidv4();
    const agentContinuationId = uuidv4();

    // 合并末尾连续的 user 消息
    let currentStart = messages.length;
    while (currentStart > 0 && messages[currentStart - 1].role === 'user') {
      currentStart--;
    }
    const currentUserMessages = messages.slice(currentStart);

    // 检查是否末尾是 assistant 消息
    const endsWithAssistant = currentUserMessages.length === 0 && 
                              messages.length > 0 && 
                              messages[messages.length - 1].role === 'assistant';

    // 生成 thinking 前缀
    let thinkingPrefix = null;
    if (anthropicReq.thinking && anthropicReq.thinking.type === 'enabled') {
      const budgetTokens = anthropicReq.thinking.budget_tokens || 10000;
      thinkingPrefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budgetTokens}</max_thinking_length>`;
    }

    // 构建历史消息
    const history = [];
    
    // 处理 system prompt
    if (anthropicReq.system) {
      const systemContent = this.extractSystemContent(anthropicReq.system);
      
      if (systemContent) {
        let finalContent = systemContent;
        if (thinkingPrefix && !systemContent.includes('<thinking_mode>') && !systemContent.includes('<max_thinking_length>')) {
          finalContent = `${thinkingPrefix}\n${systemContent}`;
        }
        
        history.push({
          userInputMessage: {
            content: finalContent,
            modelId,
            origin: 'AI_EDITOR'
          }
        });
        history.push({
          assistantResponseMessage: {
            content: 'I will follow these instructions.'
          }
        });
      }
    } else if (thinkingPrefix) {
      history.push({
        userInputMessage: {
          content: thinkingPrefix,
          modelId,
          origin: 'AI_EDITOR'
        }
      });
      history.push({
        assistantResponseMessage: {
          content: 'I will follow these instructions.'
        }
      });
    }

    // 处理历史消息
    const historyEnd = endsWithAssistant ? messages.length : currentStart;
    let userBuffer = [];
    
    for (let i = 0; i < historyEnd; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        userBuffer.push(msg);
      } else if (msg.role === 'assistant') {
        if (userBuffer.length > 0) {
          const mergedUser = this.mergeUserMessages(userBuffer, modelId);
          history.push({ userInputMessage: mergedUser });
          userBuffer = [];
        }
        
        const { text, toolUses } = this.extractAssistantContent(msg.content, toolNameMap, usedToolNames);
        const assistantMsg = { content: text };
        if (toolUses.length > 0) {
          assistantMsg.toolUses = toolUses;
        }
        history.push({ assistantResponseMessage: assistantMsg });
      }
    }
    
    // 处理结尾的孤立 user 消息
    if (userBuffer.length > 0) {
      const mergedUser = this.mergeUserMessages(userBuffer, modelId);
      history.push({ userInputMessage: mergedUser });
      history.push({ assistantResponseMessage: { content: 'OK' } });
    }

    // 处理末尾的 user 消息组作为 current_message
    let currentText = '';
    let allToolResults = [];
    
    if (endsWithAssistant) {
      currentText = 'continue';
    } else {
      const textParts = [];
      for (const msg of currentUserMessages) {
        const { text, toolResults } = this.extractUserContent(msg.content);
        if (text) {
          textParts.push(text);
        }
        allToolResults.push(...toolResults);
      }
      currentText = textParts.join('\n') || 'continue';
    }

    // 构建工具定义
    const tools = (Array.isArray(anthropicReq.tools) ? anthropicReq.tools : [])
      .filter(t => t && typeof t === 'object')
      .filter(t => !this.isUnsupportedTool(t.name || ''))
      .map(t => ({
        toolSpecification: {
          name: this.getOrCreateKiroToolName(t.name || 'tool', toolNameMap, usedToolNames),
          description: this.truncateString(t.description || '', 2000),
          inputSchema: { json: this.buildToolSchema(t.input_schema || {}) }
        }
      }));

    // 构建 userInputMessageContext
    const userInputMessageContext = {};
    if (tools.length > 0) {
      userInputMessageContext.tools = tools;
    }
    if (allToolResults.length > 0) {
      userInputMessageContext.toolResults = allToolResults;
    }

    // 确定触发类型
    let chatTriggerType = 'MANUAL';
    if (Array.isArray(anthropicReq.tools) && anthropicReq.tools.length > 0) {
      if (anthropicReq.tool_choice) {
        const tcType = anthropicReq.tool_choice.type;
        if (tcType === 'any' || tcType === 'tool') {
          chatTriggerType = 'AUTO';
        }
      }
    }

    // 构建 Kiro 请求 - 注意字段顺序要与 Rust 版本一致
    const kiroRequest = {
      conversationState: {
        agentContinuationId,
        agentTaskType: 'vibe',
        chatTriggerType,
        currentMessage: {
          userInputMessage: {
            content: currentText,
            modelId,
            origin: 'AI_EDITOR'
          }
        },
        conversationId,
        history
      }
    };

    if (Object.keys(userInputMessageContext).length > 0) {
      kiroRequest.conversationState.currentMessage.userInputMessage.userInputMessageContext = userInputMessageContext;
    }

    // 添加 profileArn
    if (this.tokenManager.credentials.profileArn) {
      kiroRequest.profileArn = this.tokenManager.credentials.profileArn;
    }

    return { kiroRequest, toolNameMap };
  }

  /**
   * 检查是否为不支持的工具
   */
  isUnsupportedTool(name) {
    const lower = this.coerceString(name, '').toLowerCase();
    return lower === 'web_search' || lower === 'websearch';
  }

  /**
   * 提取文本内容
   */
  extractTextContent(content) {
    return this.extractTextFromAny(content);
  }

  /**
   * 提取用户消息内容
   */
  extractUserContent(content) {
    if (!content) return { text: '', toolResults: [] };
    if (typeof content === 'string') return { text: content, toolResults: [] };
    
    const blocks = this.normalizeContentBlocks(content);
    const textParts = [];
    const toolResults = [];
    
    for (const block of blocks) {
      const blockType = this.coerceString(block?.type, '').toLowerCase();
      if (blockType === 'text') {
        const text = this.extractTextFromAny(block?.text ?? block?.content);
        if (text) textParts.push(text);
      } else if (blockType === 'tool_result') {
        const resultContent = this.extractTextFromAny(block?.content);
        const toolUseId = this.normalizeToolUseId(block?.tool_use_id || block?.toolUseId, 'tool_use');
        toolResults.push({
          toolUseId,
          status: block?.is_error ? 'error' : 'success',
          content: [
            { text: resultContent || 'OK' }
          ]
        });
      } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        // 兼容 OpenClaw 历史转录里的 thinking 块，按普通文本拼接
        const thinkingText = this.extractTextFromAny(block?.thinking ?? block?.text);
        if (thinkingText) textParts.push(thinkingText);
      } else {
        const fallbackText = this.extractTextFromAny(block);
        if (fallbackText) textParts.push(fallbackText);
      }
    }
    
    return { text: textParts.filter(Boolean).join('\n'), toolResults };
  }

  /**
   * 提取助手消息内容
   */
  extractAssistantContent(content, toolNameMap = new Map(), usedToolNames = new Set()) {
    if (typeof content === 'string') return { text: content, toolUses: [] };
    
    const blocks = this.normalizeContentBlocks(content);
    let thinkingContent = '';
    const textParts = [];
    const toolUses = [];
    
    for (const block of blocks) {
      const blockType = this.coerceString(block?.type, '').toLowerCase();
      if (blockType === 'thinking') {
        thinkingContent += this.extractTextFromAny(block?.thinking ?? block?.text);
      } else if (blockType === 'text') {
        const text = this.extractTextFromAny(block?.text ?? block?.content);
        if (text) textParts.push(text);
      } else if (blockType === 'tool_use') {
        if (this.isUnsupportedTool(block?.name)) continue;
        const toolUseId = this.normalizeToolUseId(block?.id, 'tool_use');
        const toolName = this.getOrCreateKiroToolName(block?.name || 'tool', toolNameMap, usedToolNames);
        toolUses.push({
          toolUseId,
          name: toolName,
          input: this.normalizeJsonObject(block?.input || block?.arguments || block?.params || {})
        });
      } else if (blockType === 'redacted_thinking') {
        // redacted_thinking 不可见，忽略
      } else {
        const fallbackText = this.extractTextFromAny(block);
        if (fallbackText) textParts.push(fallbackText);
      }
    }
    
    let finalText = '';
    if (thinkingContent) {
      if (textParts.length > 0) {
        finalText = `<thinking>${thinkingContent}</thinking>\n\n${textParts.join('\n')}`;
      } else {
        finalText = `<thinking>${thinkingContent}</thinking>`;
      }
    } else {
      finalText = textParts.join('\n');
    }

    if (!finalText && toolUses.length > 0) {
      finalText = 'OK';
    }
    
    return { text: finalText, toolUses };
  }

  /**
   * 合并多个 user 消息
   */
  mergeUserMessages(messages, modelId) {
    const contentParts = [];
    const allToolResults = [];
    
    for (const msg of messages) {
      const { text, toolResults } = this.extractUserContent(msg.content);
      if (text) {
        contentParts.push(text);
      }
      allToolResults.push(...toolResults);
    }
    
    const content = contentParts.join('\n') || (allToolResults.length > 0 ? 'continue' : '');
    const userMsg = {
      content,
      modelId,
      origin: 'AI_EDITOR'
    };
    
    if (allToolResults.length > 0) {
      userMsg.userInputMessageContext = {
        toolResults: allToolResults
      };
    }
    
    return userMsg;
  }

  /**
   * 发送 API 请求（流式）
   */
  async callApiStream(anthropicReq) {
    const token = await this.tokenManager.ensureValidToken();
    const region = this.config.region || 'us-east-1';
    const url = `https://q.${region}.amazonaws.com/generateAssistantResponse`;
    
    const { kiroRequest: kiroReq, toolNameMap } = this.convertRequest(anthropicReq);
    const headers = this.buildHeaders(token);
    const fallbackModes = this.getFallbackModes();
    const requests = fallbackModes.map(mode => ({
      mode,
      body:
        mode === 'primary'
          ? kiroReq
          : this.buildFallbackRequest(kiroReq, mode)
    }));

    for (let i = 0; i < requests.length; i++) {
      const reqItem = requests[i];
      const fetchOptions = {
        method: 'POST',
        headers,
        body: JSON.stringify(reqItem.body)
      };

      // 代理支持
      if (this.config.proxyUrl) {
        try {
          const { HttpsProxyAgent } = await import('https-proxy-agent');
          fetchOptions.agent = new HttpsProxyAgent(this.config.proxyUrl);
        } catch (e) {
          // 代理模块未安装，忽略
        }
      }

      const response = await fetch(url, fetchOptions);
      if (response.ok) {
        return { response, toolNameMap };
      }

      const errorText = await response.text();
      const requestDebug = {
        mode: reqItem.mode,
        body: this.summarizeForDebug(reqItem.body)
      };
      const canRetry =
        i < requests.length - 1 && this.shouldRetryImproperlyFormed(response.status, errorText);

      if (canRetry) {
        continue;
      }

      throw new KiroApiError(response.status, errorText, requestDebug);
    }

    throw new KiroApiError(500, 'Kiro API 请求失败（未知错误）', this.summarizeForDebug(kiroReq));
  }
}

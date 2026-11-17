/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// This source is embedded in the standalone managed CLI launcher. Keep it plain
// JavaScript: the generated launcher runs under the managed Node executable.
// Codex wire: codex-cli 0.151.0 `app-server generate-json-schema`, thread/turn params.
// ACP wire: @agentclientprotocol/sdk/schema/schema.json (0.18.2).
export const CRON_RUNTIME_PROXY_SOURCE = String.raw`
function startCronRuntimeProxy(child, runtime, reportRuntimeConfirmation) {
  const { randomUUID } = require('node:crypto');
  const namespace = randomUUID();
  const internalPrefix = 'aionui-cron-' + namespace + '-';
  const hostPrefix = 'aionui-host-' + namespace + '-';
  const internal = new Map();
  const forwarded = new Map();
  const codexConfirmations = new Set();
  const sessions = new Map();
  const cancellations = new Map();
  let sequence = 0;
  let outgoing = Promise.resolve();
  let closed = false;
  let skillSuggestionSuppressed = false;
  let codexStartup = Promise.resolve(true);
  let codexThreadId;
  let auxiliaryCodex = false;
  let runtimeReports = Promise.resolve();
  const failureMessage = runtime.observeOnly
    ? 'Unable to confirm agent runtime settings.'
    : 'Unable to apply scheduled task model settings.';

  function writeChild(message) {
    if (closed || !child.stdin.writable) throw new Error(failureMessage);
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function writeHost(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  function reportConfirmedRuntime(confirmation) {
    if (!reportRuntimeConfirmation) return Promise.resolve();
    // Native messages arrive in order, but separate pipe writes can finish out
    // of order. Never let an older bootstrap snapshot overwrite a later update.
    runtimeReports = runtimeReports.catch(() => {}).then(() => {
      if (closed) throw new Error(failureMessage);
      return reportRuntimeConfirmation(confirmation);
    }).catch((error) => {
      if (!runtime.observeOnly) throw error;
      process.stderr.write(failureMessage + '\n');
    });
    return runtimeReports;
  }

  function rememberSession(sessionId, result) {
    if (typeof sessionId !== 'string' || !result || typeof result !== 'object') return;
    const state = sessions.get(sessionId) || {};
    if (Array.isArray(result.configOptions)) state.options = result.configOptions;
    if (result.models && Array.isArray(result.models.availableModels)) state.models = result.models.availableModels;
    sessions.set(sessionId, state);
  }

  function requestInternal(method, params) {
    return new Promise((resolve, reject) => {
      const id = internalPrefix + (++sequence);
      const timer = setTimeout(() => {
        internal.delete(id);
        reject(new Error(failureMessage));
      }, 15000);
      internal.set(id, { resolve, reject, timer, params });
      try {
        writeChild({ jsonrpc: '2.0', id, method, params });
      } catch {
        clearTimeout(timer);
        internal.delete(id);
        reject(new Error(failureMessage));
      }
    });
  }

  function values(option) {
    if (!option || !Array.isArray(option.options)) return [];
    return option.options.flatMap((entry) => entry && Array.isArray(entry.options) ? entry.options : [entry]);
  }

  function selectModel(requested, ids) {
    if (ids.includes(requested)) return requested;
    // HTH's HTTP model catalog uses bare ids; ACP advertises provider/model ids.
    const qualified = 'hth/' + requested;
    if (!requested.includes('/') && ids.includes(qualified)) return qualified;
    throw new Error(failureMessage);
  }

  async function setOption(sessionId, option, value) {
    if (!option || !values(option).some((entry) => entry && entry.value === value)) {
      throw new Error(failureMessage);
    }
    const result = await requestInternal('session/set_config_option', { sessionId, configId: option.id, value });
    if (!result || !Array.isArray(result.configOptions) ||
        !result.configOptions.some((entry) => entry.id === option.id && entry.currentValue === value)) {
      throw new Error(failureMessage);
    }
    rememberSession(sessionId, result);
    // Core cannot see the response to this proxy-owned RPC. Publish the
    // confirmed agent state even when the CLI does not send its own update.
    writeHost({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId, update: { sessionUpdate: 'config_option_update', configOptions: result.configOptions },
    } });
  }

  async function applyAcpSettings(params) {
    const sessionId = params && params.sessionId;
    if (typeof sessionId !== 'string') throw new Error(failureMessage);
    let state = sessions.get(sessionId);
    if (!state) throw new Error(failureMessage);
    if (runtime.model) {
      const option = (state.options || []).find((entry) => entry.category === 'model' || entry.id === 'model');
      if (option) {
        const model = selectModel(runtime.model, values(option).map((entry) => entry && entry.value));
        await setOption(sessionId, option, model);
      } else {
        const model = selectModel(runtime.model, (state.models || []).map((entry) => entry.modelId));
        await requestInternal('session/set_model', { sessionId, modelId: model });
      }
    }
    if (runtime.thoughtLevel) {
      // A model switch may change the available effort choices.
      state = sessions.get(sessionId);
      const aliases = ['thought_level', 'reasoning_effort', 'effort', 'thinking_budget', 'thinking'];
      const option = (state.options || []).find((entry) => aliases.includes(entry.category) || aliases.includes(entry.id));
      await setOption(sessionId, option, runtime.thoughtLevel);
    }
  }

  function removeSkillSuggestion(parts) {
    if (!Array.isArray(parts)) return { parts, consumed: false };
    // Match Core's new-conversation wrapper as a pair. User-written skill
    // requests, saved skill instructions, and surrounding context stay intact.
    const rules = '\n\nRules:\n1. Execute the task directly — do NOT ask clarifying questions.\n2. Focus on producing useful, actionable output.\n3. If the task requires external data (news, weather, etc.), search for the latest information.';
    const rule = '\n4. After completing the task above, create a file named "SKILL_SUGGEST.md" in the current working directory (see instructions at the end).';
    const contextEnd = '\n[/Scheduled Task Context]\n\n';
    const fence = String.fromCharCode(96).repeat(3);
    const suggestion = '\n\n---\n\n[Post-Task] After you have fully completed the task above, create a file named "SKILL_SUGGEST.md" in the current working directory to help future runs stay consistent. The file should follow this format:\n\n' + fence + 'markdown\n---\nname: <short kebab-case name, e.g. daily-greeting>\ndescription: <one-line description of what this task does>\n---\n\n<Instructions capturing the pattern you used: output format, tone, sources checked, steps taken, quality criteria. Use concrete details from this execution, not placeholders.>\n' + fence + '\n\nIf you think the task is too simple or one-off to benefit from a skill file, you can skip this step.';
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
      const text = part.text;
      const assistantRulesEnd = text.startsWith('[Assistant Rules]\n') ? text.indexOf('\n[/Assistant Rules]\n\n') : -1;
      const contextStart = text.indexOf('[Scheduled Task Context]\nTask: ',
        assistantRulesEnd < 0 ? 0 : assistantRulesEnd + '\n[/Assistant Rules]\n\n'.length);
      if (contextStart < 0) continue;
      const closingContext = text.indexOf(contextEnd, contextStart);
      if (closingContext < 0) continue;
      const context = text.slice(contextStart, closingContext);
      const savedSkillContext = '\n\nThis is a scheduled task execution. A skill file with detailed instructions has been loaded\ninto your workspace. You MUST read and follow the skill instructions precisely.';
      if (context.includes(savedSkillContext)) return { parts, consumed: true };
      if (!context.includes('\nSchedule: ') || !context.includes(rules)) continue;
      const rulesStart = text.indexOf(rules + rule + contextEnd, contextStart);
      if (rulesStart < 0 || rulesStart + rules.length + rule.length !== closingContext) return { parts, consumed: true };
      const suggestionStart = text.lastIndexOf(suggestion);
      if (suggestionStart < rulesStart + rules.length + rule.length + contextEnd.length) return { parts, consumed: true };
      const ruleStart = rulesStart + rules.length;
      const cleaned = text.slice(0, ruleStart) + text.slice(ruleStart + rule.length, suggestionStart) + text.slice(suggestionStart + suggestion.length);
      return { parts: parts.with(index, { ...part, text: cleaned }), consumed: true };
    }
    return { parts, consumed: false };
  }

  async function forwardRequest(message, cancellationVersion) {
    if (runtime.backend === 'codex' && message.method === 'initialize' &&
        message.params && message.params.clientInfo && message.params.clientInfo.name === 'aionui-title') {
      // Core starts a separate helper with the same conversation environment.
      // Its title-only thread must not change the conversation's runtime state.
      auxiliaryCodex = true;
    }
    if (auxiliaryCodex) {
      writeChild(message);
      return;
    }
    let consumesSkillSuggestion = false;
    let confirmCodexStartup;
    if (runtime.browserMcp && runtime.backend === 'codex' &&
        ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params) ||
          (message.params.config != null && (typeof message.params.config !== 'object' || Array.isArray(message.params.config))) ||
          (message.params.config && message.params.config.mcp_servers != null &&
            (typeof message.params.config.mcp_servers !== 'object' || Array.isArray(message.params.config.mcp_servers)))) {
        throw new Error(failureMessage);
      }
      const config = message.params.config || {};
      message.params = { ...message.params, config: { ...config,
        mcp_servers: { ...config.mcp_servers, 'hq-browser': {
          command: runtime.browserMcp.command, args: runtime.browserMcp.args,
          // Codex filters MCP child environments. Forward names only; the
          // current browser credentials stay in the inherited process env.
          env_vars: ['AIONUI_BROWSER_CONTROL_PIPE', 'AIONUI_BROWSER_CONTROL_TOKEN',
            'AIONUI_CDP_ACTIVE_PORT', 'AIONUI_CDP_BRIDGE_TOKEN', 'AIONUI_CONVERSATION_ID'],
        } },
      } };
    } else if (runtime.browserMcp && runtime.backend === 'opencode' &&
        ['session/new', 'session/load'].includes(message.method)) {
      if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params) ||
          (message.params.mcpServers != null && !Array.isArray(message.params.mcpServers))) {
        throw new Error(failureMessage);
      }
      const servers = (message.params.mcpServers || []).filter((server) => !server || server.name !== 'hq-browser');
      message.params = { ...message.params, mcpServers: [...servers, {
        name: 'hq-browser', command: runtime.browserMcp.command, args: runtime.browserMcp.args, env: [],
      }] };
    }
    if (runtime.backend === 'codex' && (runtime.model || runtime.thoughtLevel || runtime.observeOnly) &&
        ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      if (!runtime.observeOnly) {
        if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params) ||
            (message.params.config != null && (typeof message.params.config !== 'object' || Array.isArray(message.params.config))) ||
            !Object.prototype.hasOwnProperty.call(message, 'id')) {
          throw new Error(failureMessage);
        }
        message.params = { ...message.params,
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.thoughtLevel ? { config: { ...message.params.config, model_reasoning_effort: runtime.thoughtLevel } } : {}),
        };
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        codexStartup = new Promise((resolve) => {
          confirmCodexStartup = (confirmed) => {
            codexConfirmations.delete(confirmCodexStartup);
            resolve(confirmed);
          };
          codexConfirmations.add(confirmCodexStartup);
        });
      }
    }
    if (runtime.backend === 'codex' && message.method === 'turn/start') {
      if (!(await codexStartup)) throw new Error(failureMessage);
      if (!runtime.observeOnly) {
        if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) {
          throw new Error(failureMessage);
        }
        message.params = { ...message.params,
          ...(runtime.model ? { model: runtime.model } : {}),
          ...(runtime.thoughtLevel ? { effort: runtime.thoughtLevel } : {}),
        };
      }
    } else if (runtime.backend === 'opencode' && message.method === 'session/prompt') {
      if (runtime.model || runtime.thoughtLevel) await applyAcpSettings(message.params);
      if ((cancellations.get(message.params.sessionId) || 0) !== cancellationVersion) {
        throw new Error(failureMessage);
      }
    }
    if (runtime.suppressSkillSuggestion && !skillSuggestionSuppressed &&
        ((runtime.backend === 'codex' && message.method === 'turn/start') ||
         (runtime.backend === 'opencode' && message.method === 'session/prompt'))) {
      const key = runtime.backend === 'codex' ? 'input' : 'prompt';
      const cleaned = removeSkillSuggestion(message.params && message.params[key]);
      if (cleaned.parts !== (message.params && message.params[key])) {
        message.params = { ...message.params, [key]: cleaned.parts };
      }
      consumesSkillSuggestion = cleaned.consumed;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const id = hostPrefix + (++sequence);
      forwarded.set(id, { id: message.id, method: message.method, params: message.params, confirmCodexStartup });
      try {
        writeChild({ ...message, id });
      } catch (error) {
        forwarded.delete(id);
        if (confirmCodexStartup) confirmCodexStartup(false);
        throw error;
      }
    } else {
      writeChild(message);
    }
    if (consumesSkillSuggestion) skillSuggestionSuppressed = true;
  }

  async function confirmCodexThread(message, pending) {
    let confirmed = false;
    try {
      if (message.error) {
        writeHost({ ...message, id: pending.id });
        return;
      }
      const result = message.result;
      if (!result || typeof result !== 'object' || typeof result.model !== 'string' || !result.model ||
          (!runtime.observeOnly && runtime.model && result.model !== runtime.model) ||
          (!runtime.observeOnly && runtime.thoughtLevel && result.reasoningEffort !== runtime.thoughtLevel) ||
          (runtime.observeOnly && (!result.thread || typeof result.thread.id !== 'string' || !result.thread.id))) {
        throw new Error(failureMessage);
      }
      if (runtime.observeOnly) codexThreadId = result.thread.id;
      await reportConfirmedRuntime({ backend: 'codex', model: result.model,
        ...(typeof result.reasoningEffort === 'string' && result.reasoningEffort ? { thoughtLevel: result.reasoningEffort } : {}),
      });
      if (closed) return;
      writeHost({ ...message, id: pending.id });
      confirmed = true;
    } catch {
      if (!closed) writeHost({ jsonrpc: '2.0', id: pending.id, error: { code: -32000, message: failureMessage } });
    } finally {
      pending.confirmCodexStartup(confirmed);
    }
  }

  function onHostLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { stop(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { stop(); return; }
    // Agent-initiated permission/file requests must keep flowing while an
    // internal config RPC is awaited. Their responses use the agent's ids.
    if (typeof message.method !== 'string') {
      try { writeChild(message); } catch { stop(); }
      return;
    }
    if (message.method === 'session/cancel' || message.method === 'turn/interrupt') {
      if (message.params && typeof message.params.sessionId === 'string') {
        const sessionId = message.params.sessionId;
        cancellations.set(sessionId, (cancellations.get(sessionId) || 0) + 1);
      }
      void forwardRequest(message).catch(stop);
      return;
    }
    const cancellationVersion = message.params ? (cancellations.get(message.params.sessionId) || 0) : 0;
    outgoing = outgoing.then(() => forwardRequest(message, cancellationVersion)).catch(() => {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        writeHost({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: failureMessage } });
      } else {
        stop();
      }
    });
  }

  function onChildLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
    if (!message || typeof message !== 'object') { process.stdout.write(line + '\n'); return; }
    if (typeof message.id === 'string' && message.id.startsWith(internalPrefix) && !message.method) {
      const pending = internal.get(message.id);
      if (!pending) return; // A late internal response must never reach Core.
      internal.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error || !Object.prototype.hasOwnProperty.call(message, 'result')) {
        pending.reject(new Error(failureMessage));
      } else {
        rememberSession(pending.params.sessionId, message.result);
        pending.resolve(message.result);
      }
      return;
    }
    const pending = !message.method && forwarded.get(message.id);
    if (pending) {
      forwarded.delete(message.id);
      if (pending.confirmCodexStartup) {
        void confirmCodexThread(message, pending).catch(stop);
        return;
      }
      if (runtime.backend === 'opencode' && message.result) {
        const sessionId = message.result.sessionId || (pending.params && pending.params.sessionId);
        rememberSession(sessionId, message.result);
      }
      writeHost({ ...message, id: pending.id });
      return;
    }
    if (message.method === 'session/update' && message.params) {
      rememberSession(message.params.sessionId, message.params.update);
    }
    if (!auxiliaryCodex && runtime.backend === 'codex' && runtime.observeOnly && message.method === 'thread/settings/updated' &&
        message.params && message.params.threadId === codexThreadId) {
      const settings = message.params && (message.params.threadSettings || message.params.thread_settings);
      if (settings && typeof settings.model === 'string' && settings.model) {
        void reportConfirmedRuntime({ backend: 'codex', model: settings.model,
          ...(typeof settings.effort === 'string' && settings.effort ? { thoughtLevel: settings.effort } : {}),
        }).catch(() => process.stderr.write(failureMessage + '\n'));
      }
    }
    writeHost(message);
  }

  function readLines(stream, receive) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        receive(line);
      }
    });
    stream.on('end', () => { if (buffer) receive(buffer); });
  }

  function stop() {
    if (closed) return;
    closed = true;
    for (const pending of internal.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(failureMessage));
    }
    internal.clear();
    for (const confirm of codexConfirmations) confirm(false);
    forwarded.clear();
    process.stdin.pause();
    child.kill();
  }

  readLines(process.stdin, onHostLine);
  readLines(child.stdout, onChildLine);
  child.stdin.on('error', stop);
  child.stdout.on('error', stop);
  child.once('error', stop);
  child.once('exit', stop);
  process.stdin.once('end', () => {
    void outgoing.finally(() => { if (!closed) child.stdin.end(); });
  });
}
`;

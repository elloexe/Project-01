'use strict';

const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { Store } = require('./store');
const { Router } = require('../core/router');
const { getProvider, publicCatalog } = require('../core/providers');
const { DEPARTMENTS } = require('../core/departments');
const { askCompany, askDepartment, askPlain } = require('../core/crew');
const { createApiServer } = require('../core/server');

// Lets tests (or a portable setup) keep data somewhere other than %APPDATA%.
if (process.env.ELLO_CREW_DATA) app.setPath('userData', path.resolve(process.env.ELLO_CREW_DATA));

let win = null;
let store = null;
let router = null;
let api = null;
const runs = new Map(); // runId -> AbortController

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0d0f14',
    title: 'ello Crew',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Links in answers open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

async function startApiIfEnabled() {
  const cfg = store.settings.api;
  if (!cfg.enabled) return;
  try {
    await api.start();
  } catch (e) {
    send('api:status', apiStatus(`Could not start on port ${cfg.port}: ${e.code === 'EADDRINUSE' ? 'port already in use' : e.message}`));
  }
}

function apiStatus(error = null) {
  const cfg = store.settings.api;
  return {
    enabled: cfg.enabled,
    running: api.running,
    port: api.port || cfg.port,
    requireKey: cfg.requireKey,
    localKey: cfg.localKey,
    baseUrl: `http://127.0.0.1:${api.port || cfg.port}/v1`,
    error,
  };
}

function initState() {
  return {
    version: app.getVersion(),
    providers: publicCatalog(),
    departments: DEPARTMENTS.map(({ prompt, ...d }) => d),
    settings: store.settings,
    connections: store.publicConnections(),
    conversations: store.listConversations(),
    api: apiStatus(),
    encryption: store.encryptionAvailable,
    router: router.status(),
  };
}

async function discoverOrDefault(conn) {
  const provider = getProvider(conn.providerId) || {};
  try {
    const models = await router.discoverModels(conn);
    if (models.length) return { models, warning: null };
    return { models: provider.defaultModels || [], warning: 'The provider listed no usable chat models; using defaults.' };
  } catch (e) {
    if (/rejected/i.test(e.message)) throw e;
    if (provider.defaultModels && provider.defaultModels.length) {
      return { models: provider.defaultModels, warning: `Could not list models (${e.message}); using the known defaults.` };
    }
    throw e;
  }
}

function registerIpc() {
  ipcMain.handle('app:init', () => initState());

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // ---- connections ----

  ipcMain.handle('conn:add', async (_e, { providerId, apiKey, baseUrl, name }) => {
    const provider = getProvider(providerId);
    if (!provider) throw new Error('Unknown provider');
    const key = (apiKey || '').trim();
    if (!key && !provider.keyOptional) throw new Error(`${provider.name} needs an API key.`);
    const url = (provider.custom || provider.local ? baseUrl || provider.baseUrl : provider.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Base URL must start with http:// or https://');
    const draft = { providerId, apiKey: key, baseUrl: url, local: !!provider.local || /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url), name: (name || '').trim() || provider.name };
    const { models, warning } = await discoverOrDefault(draft);
    if (!models.length) throw new Error('No models found. For local servers, load a model first.');
    const conn = store.addConnection({ ...draft, models });
    store.updateConnection(conn.id, { lastCheck: { ok: true, time: Date.now(), message: warning || `${models.length} models available` } });
    return { connections: store.publicConnections(), warning, id: conn.id };
  });

  // One click, zero sign-ups: connect every hosted provider that works without a key.
  ipcMain.handle('conn:quickstart', async () => {
    const results = [];
    const have = new Set(store.publicConnections().map((c) => c.providerId));
    for (const providerId of ['llm7', 'kilo']) {
      const provider = getProvider(providerId);
      if (have.has(providerId)) {
        results.push({ name: provider.name, ok: true, message: 'already connected' });
        continue;
      }
      const draft = { providerId, apiKey: '', baseUrl: provider.baseUrl, local: false, name: provider.name };
      try {
        const { models } = await discoverOrDefault(draft);
        if (!models.length) throw new Error('no free models listed right now');
        const conn = store.addConnection({ ...draft, models });
        store.updateConnection(conn.id, { lastCheck: { ok: true, time: Date.now(), message: `${models.length} keyless models` } });
        results.push({ name: provider.name, ok: true, message: `${models.length} models` });
      } catch (e) {
        results.push({ name: provider.name, ok: false, message: e.message });
      }
    }
    return { connections: store.publicConnections(), results };
  });

  ipcMain.handle('conn:update', (_e, { id, patch }) => {
    const allowed = {};
    for (const k of ['enabled', 'name', 'apiKey', 'rpm', 'rpd', 'baseUrl']) if (k in patch) allowed[k] = patch[k];
    for (const k of ['rpm', 'rpd']) {
      if (k in allowed) allowed[k] = allowed[k] === '' || allowed[k] === null ? undefined : Math.max(0, parseInt(allowed[k], 10) || 0);
    }
    store.updateConnection(id, allowed);
    return store.publicConnections();
  });

  ipcMain.handle('conn:remove', (_e, id) => {
    store.removeConnection(id);
    return { connections: store.publicConnections(), settings: store.settings };
  });

  ipcMain.handle('conn:toggleModel', (_e, { id, modelId, enabled }) => {
    const c = store.getConnection(id);
    if (!c) throw new Error('Connection not found');
    const ids = modelId === '*' ? c.models.map((m) => m.id) : [modelId];
    for (const m of c.models) if (ids.includes(m.id)) m.enabled = enabled;
    store.changed();
    return store.publicConnections();
  });

  ipcMain.handle('conn:refresh', async (_e, id) => {
    const raw = store.connectionsWithKeys().find((c) => c.id === id);
    if (!raw) throw new Error('Connection not found');
    try {
      const models = await router.discoverModels(raw);
      const prev = new Map(raw.models.map((m) => [m.id, m.enabled]));
      store.updateConnection(id, {
        models: models.map((m) => ({ id: m, enabled: prev.has(m) ? prev.get(m) : true })),
        lastCheck: { ok: true, time: Date.now(), message: `${models.length} models available` },
      });
    } catch (e) {
      store.updateConnection(id, { lastCheck: { ok: false, time: Date.now(), message: e.message } });
    }
    return store.publicConnections();
  });

  ipcMain.handle('conn:test', async (_e, { id, modelId }) => {
    const raw = store.connectionsWithKeys().find((c) => c.id === id);
    if (!raw) throw new Error('Connection not found');
    const model = modelId || (raw.models.find((m) => m.enabled) || raw.models[0] || {}).id;
    if (!model) throw new Error('No model to test');
    const started = Date.now();
    try {
      const r = await router.complete(
        { model: `${id}/${model}`, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with just the word: ready' }] },
        { source: 'test' }
      );
      if (r.ref !== `${id}/${model}`) throw new Error(`failed over to ${r.ref}; this model did not answer`);
      const message = `${model} answered in ${Date.now() - started} ms: "${(r.content || '').trim().slice(0, 40)}"`;
      store.updateConnection(id, { lastCheck: { ok: true, time: Date.now(), message } });
      return { ok: true, message, connections: store.publicConnections() };
    } catch (e) {
      const message = e.attempts && e.attempts[0] && e.attempts[0].error ? e.attempts[0].error : e.message;
      store.updateConnection(id, { lastCheck: { ok: false, time: Date.now(), message } });
      return { ok: false, message, connections: store.publicConnections() };
    }
  });

  // ---- settings & router ----

  ipcMain.handle('settings:update', async (_e, patch) => {
    const before = store.settings.api;
    const next = store.updateSettings(patch);
    if (patch.api) {
      const restart = next.api.enabled && (!api.running || next.api.port !== before.port);
      try {
        if (!next.api.enabled && api.running) await api.stop();
        else if (restart) await api.start();
      } catch (e) {
        return { settings: next, api: apiStatus(e.code === 'EADDRINUSE' ? `Port ${next.api.port} is already in use.` : e.message) };
      }
    }
    return { settings: next, api: apiStatus() };
  });

  ipcMain.handle('api:regenerateKey', () => {
    store.updateSettings({ api: { localKey: `sk-ello-${crypto.randomBytes(18).toString('base64url')}` } });
    return apiStatus();
  });

  ipcMain.handle('router:status', () => router.status());
  ipcMain.handle('router:clearCooldowns', () => {
    router.clearCooldowns();
    return router.status();
  });

  // ---- conversations ----

  ipcMain.handle('conv:list', () => store.listConversations());
  ipcMain.handle('conv:get', (_e, id) => store.getConversation(id));
  ipcMain.handle('conv:delete', (_e, id) => {
    store.deleteConversation(id);
    return store.listConversations();
  });
  ipcMain.handle('conv:rename', (_e, { id, title }) => {
    store.renameConversation(id, title);
    return store.listConversations();
  });
  ipcMain.handle('conv:export', async (_e, id) => {
    const conv = store.getConversation(id);
    if (!conv) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export conversation',
      defaultPath: `${conv.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 50) || 'conversation'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, conversationMarkdown(conv), 'utf8');
    return true;
  });

  // ---- chat ----

  ipcMain.handle('chat:send', async (_e, req) => {
    const question = String(req.question || '').trim();
    if (!question) throw new Error('Type a question first.');
    let conv = req.conversationId ? store.getConversation(req.conversationId) : null;
    if (!conv) conv = store.createConversation({ mode: req.mode, deptId: req.deptId, specialty: req.specialty, model: req.model });

    const runId = crypto.randomUUID();
    const ctrl = new AbortController();
    runs.set(runId, ctrl);
    const emit = (evt) => send('chat:event', { runId, conversationId: conv.id, ...evt });
    const history = conv.turns.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer }));
    const model = req.model || store.settings.defaultModel || 'auto';
    const started = Date.now();

    (async () => {
      let result;
      let error = null;
      try {
        if (conv.mode === 'company') {
          result = await askCompany({
            router,
            question,
            history,
            model,
            options: { maxDepartments: req.maxDepartments || store.settings.maxDepartments, reviewer: req.reviewer ?? store.settings.reviewer, departments: req.departments },
            emit,
            signal: ctrl.signal,
          });
        } else if (conv.mode === 'department') {
          result = await askDepartment({ router, deptId: conv.deptId, specialty: conv.specialty, question, history, model, emit, signal: ctrl.signal });
        } else {
          result = await askPlain({ router, question, history, model, emit, signal: ctrl.signal });
        }
      } catch (e) {
        error = e.status === 499 ? 'Stopped.' : e.message;
        emit({ type: 'error', error, attempts: e.attempts || [] });
      } finally {
        runs.delete(runId);
      }
      const turn = {
        question,
        answer: result ? result.answer : '',
        routing: result && result.routing ? result.routing : null,
        departments: result && result.departments ? result.departments : null,
        review: result && result.review ? result.review : null,
        models: result ? result.models : [],
        error,
        time: started,
        ms: Date.now() - started,
      };
      store.addTurn(conv.id, turn);
      emit({ type: 'turn-saved', turn, conversations: store.listConversations() });
    })();

    return { runId, conversationId: conv.id };
  });

  ipcMain.handle('chat:cancel', (_e, runId) => {
    const c = runs.get(runId);
    if (c) c.abort();
    return !!c;
  });
}

function conversationMarkdown(conv) {
  const out = [`# ${conv.title}`, '', `_Exported from ello Crew · ${new Date(conv.createdAt).toLocaleString()}_`, ''];
  for (const t of conv.turns) {
    out.push(`## 🙋 ${t.question}`, '');
    if (t.departments && t.departments.length > 1) {
      for (const d of t.departments) {
        if (!d.content) continue;
        out.push(`<details><summary>${d.name}${d.model ? ` · ${d.model}` : ''}</summary>`, '', d.content, '', '</details>', '');
      }
    }
    if (t.review) out.push('<details><summary>Reviewer</summary>', '', t.review.content, '', '</details>', '');
    out.push(t.answer || `_${t.error || 'no answer'}_`, '');
  }
  return out.join('\n');
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  store = new Store(app.getPath('userData'), safeStorage);
  router = new Router({
    getConnections: () => store.connectionsWithKeys(),
    getSettings: () => store.settings,
    onEvent: (evt) => {
      send('router:event', evt);
      store.routerState = router.snapshot();
    },
  });
  router.restore(store.routerState);
  api = createApiServer({ router, getConfig: () => store.settings.api, onEvent: () => {} });

  registerIpc();
  createWindow();
  await startApiIfEnabled();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const c of runs.values()) c.abort();
  if (store) {
    store.routerState = router.snapshot();
    store.flush();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

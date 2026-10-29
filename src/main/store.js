'use strict';

// JSON persistence in the user-data folder. API keys are encrypted with the
// OS keychain (Electron safeStorage → DPAPI on Windows) before they touch disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  pinned: [],
  fallbackToAuto: true,
  defaultModel: 'auto',
  reviewer: false,
  maxDepartments: 3,
  api: { enabled: false, port: 4891, requireKey: true, localKey: '' },
};

class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.data = fallback;
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        try {
          fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
    }
  }

  save(delay = 250) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

class Store {
  /**
   * @param {string} dir  user-data directory
   * @param {{isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string}} [safeStorage]
   */
  constructor(dir, safeStorage = null) {
    this.safeStorage = safeStorage;
    this.config = new JsonFile(path.join(dir, 'ello-crew.json'), {});
    this.convs = new JsonFile(path.join(dir, 'conversations.json'), { conversations: [] });
    const c = this.config.data;
    c.connections = c.connections || [];
    c.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}), api: { ...DEFAULT_SETTINGS.api, ...((c.settings || {}).api || {}) } };
    if (!c.settings.api.localKey) {
      c.settings.api.localKey = `sk-ello-${crypto.randomBytes(18).toString('base64url')}`;
      this.config.save();
    }
    this.convs.data.conversations = this.convs.data.conversations || [];
  }

  // ---- secrets ----

  encrypt(secret) {
    if (!secret) return '';
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return `enc:${this.safeStorage.encryptString(secret).toString('base64')}`;
    }
    return `plain:${Buffer.from(secret, 'utf8').toString('base64')}`;
  }

  decrypt(stored) {
    if (!stored) return '';
    if (stored.startsWith('enc:')) {
      try {
        return this.safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      } catch {
        return ''; // encrypted under another Windows user / machine
      }
    }
    if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    return '';
  }

  get encryptionAvailable() {
    return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
  }

  // ---- connections ----

  get settings() {
    return this.config.data.settings;
  }

  updateSettings(patch) {
    const s = this.config.data.settings;
    const next = { ...s, ...patch, api: { ...s.api, ...(patch.api || {}) } };
    this.config.data.settings = next;
    this.config.save();
    return next;
  }

  /** Connections with decrypted keys — for the router only, never sent to the renderer. */
  connectionsWithKeys() {
    if (!this._cache) {
      this._cache = this.config.data.connections.map((c) => ({ ...c, apiKey: this.decrypt(c.apiKeyEnc) }));
    }
    return this._cache;
  }

  /** Safe view for the UI. */
  publicConnections() {
    return this.config.data.connections.map(({ apiKeyEnc, ...c }) => {
      const key = this.decrypt(apiKeyEnc);
      return { ...c, hasKey: !!key, keyPreview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '' };
    });
  }

  getConnection(id) {
    return this.config.data.connections.find((c) => c.id === id) || null;
  }

  addConnection({ providerId, name, baseUrl, apiKey, models, local }) {
    const conn = {
      id: `${providerId}-${crypto.randomBytes(3).toString('hex')}`,
      providerId,
      name,
      baseUrl,
      local: !!local,
      apiKeyEnc: this.encrypt(apiKey),
      enabled: true,
      models: models.map((id) => ({ id, enabled: true })),
      addedAt: Date.now(),
      lastCheck: null,
    };
    this.config.data.connections.push(conn);
    this.changed();
    return conn;
  }

  updateConnection(id, patch) {
    const c = this.getConnection(id);
    if (!c) throw new Error('Connection not found');
    const { apiKey, ...rest } = patch;
    Object.assign(c, rest);
    if (apiKey !== undefined) c.apiKeyEnc = this.encrypt(apiKey);
    this.changed();
    return c;
  }

  removeConnection(id) {
    this.config.data.connections = this.config.data.connections.filter((c) => c.id !== id);
    const pinned = this.settings.pinned.filter((r) => !r.startsWith(`${id}/`));
    this.config.data.settings.pinned = pinned;
    this.changed();
  }

  changed() {
    this._cache = null;
    this.config.save();
  }

  // ---- router state ----

  get routerState() {
    return this.config.data.routerState || null;
  }

  set routerState(snap) {
    this.config.data.routerState = snap;
    this.config.save(2000);
  }

  // ---- conversations ----

  listConversations() {
    return this.convs.data.conversations
      .map(({ turns, ...c }) => ({ ...c, turnCount: turns.length, preview: turns.length ? turns[turns.length - 1].question.slice(0, 120) : '' }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getConversation(id) {
    return this.convs.data.conversations.find((c) => c.id === id) || null;
  }

  createConversation({ mode, deptId, specialty, model, title }) {
    const conv = {
      id: crypto.randomUUID(),
      title: title || 'New conversation',
      mode,
      deptId: deptId || null,
      specialty: specialty || null,
      model: model || 'auto',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };
    this.convs.data.conversations.push(conv);
    this.convs.save();
    return conv;
  }

  addTurn(convId, turn) {
    const conv = this.getConversation(convId);
    if (!conv) throw new Error('Conversation not found');
    conv.turns.push(turn);
    if (conv.turns.length === 1) conv.title = turn.question.replace(/\s+/g, ' ').slice(0, 60);
    conv.updatedAt = Date.now();
    this.convs.save();
    return conv;
  }

  renameConversation(id, title) {
    const conv = this.getConversation(id);
    if (conv) {
      conv.title = title.slice(0, 120);
      this.convs.save();
    }
    return conv;
  }

  deleteConversation(id) {
    this.convs.data.conversations = this.convs.data.conversations.filter((c) => c.id !== id);
    this.convs.save();
  }

  flush() {
    this.config.flush();
    this.convs.flush();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };

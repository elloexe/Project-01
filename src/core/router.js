'use strict';

// The free-tier router: picks a model for each request, enforces each key's
// RPM/RPD windows locally, and fails over to the next candidate when a
// provider rate-limits, errors, or times out. Cooldown ladder and back-off
// rules follow tashfeenahmed/freellmapi's quota design (MIT).

const { getProvider, modelQuality } = require('./providers');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Consecutive 429s within 24h walk this ladder; a success resets it.
const LADDER = [90_000, 2 * MINUTE, 10 * MINUTE, HOUR, DAY];
const MAX_ATTEMPTS = 8;
const FAST_PROVIDERS = ['groq', 'cerebras', 'google', 'mistral'];

class RouterError extends Error {
  constructor(message, { status = 0, attempts = [] } = {}) {
    super(message);
    this.status = status;
    this.attempts = attempts;
  }
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Retry-After: 17" / HTTP-date, or "retryDelay": "17s" / "try again in 30 seconds" in the body.
function statedRetryMs(headers, bodyText, now) {
  const h = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return clampRetry(secs * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return clampRetry(at - now);
  }
  if (bodyText) {
    let m = bodyText.match(/"retry(?:Delay|_after|AfterSeconds)"\s*:\s*"?(\d+(?:\.\d+)?)s?"?/i);
    if (m) return clampRetry(parseFloat(m[1]) * 1000);
    m = bodyText.match(/(?:try again|retry) (?:in|after) (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const mult = unit.startsWith('ms') || unit.startsWith('milli') ? 1 : unit.startsWith('h') ? HOUR : unit.startsWith('m') ? MINUTE : 1000;
      return clampRetry(n * mult);
    }
  }
  return null;
}

function clampRetry(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, DAY);
}

function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.text) chars += p.text.length;
  }
  return Math.ceil(chars / 4);
}

class Router {
  /**
   * @param {object} opts
   * @param {() => Array} opts.getConnections  enabled + disabled connections with keys
   * @param {() => object} [opts.getSettings]  { pinned: string[], timeoutMs }
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {() => number} [opts.now]
   * @param {(evt: object) => void} [opts.onEvent]
   */
  constructor({ getConnections, getSettings = () => ({}), fetchImpl = globalThis.fetch, now = Date.now, onEvent = () => {} }) {
    this.getConnections = getConnections;
    this.getSettings = getSettings;
    this.fetch = fetchImpl;
    this.now = now;
    this.onEvent = onEvent;
    this.windows = new Map(); // ref -> { minute: number[], day: string, dayCount: number }
    this.cooldowns = new Map(); // ref or "conn:<id>" -> { until, reason }
    this.ladderHits = new Map(); // ref -> number[] (timestamps of 429s)
    this.usage = {}; // day -> connId -> { requests, failures, promptTokens, completionTokens }
    this.log = []; // newest last, capped
  }

  // ---- candidate selection ------------------------------------------------

  allModels() {
    const out = [];
    for (const c of this.getConnections()) {
      if (!c.enabled) continue;
      const provider = getProvider(c.providerId);
      for (const m of c.models || []) {
        if (!m.enabled) continue;
        out.push({ ref: `${c.id}/${m.id}`, connection: c, provider, modelId: m.id, quality: modelQuality(m.id) });
      }
    }
    return out;
  }

  orderAuto(models, { fast = false } = {}) {
    const pinned = this.getSettings().pinned || [];
    const pinIndex = new Map(pinned.map((r, i) => [r, i]));
    return [...models].sort((a, b) => {
      const pa = pinIndex.has(a.ref) ? pinIndex.get(a.ref) : Infinity;
      const pb = pinIndex.has(b.ref) ? pinIndex.get(b.ref) : Infinity;
      if (pa !== pb) return pa - pb;
      if (fast) {
        const fa = FAST_PROVIDERS.indexOf(a.connection.providerId);
        const fb = FAST_PROVIDERS.indexOf(b.connection.providerId);
        const sa = fa < 0 ? 99 : fa;
        const sb = fb < 0 ? 99 : fb;
        if (sa !== sb) return sa - sb;
      }
      // Local models last in auto: unlimited but usually much weaker than hosted.
      const la = a.connection.local ? 1 : 0;
      const lb = b.connection.local ? 1 : 0;
      if (la !== lb) return la - lb;
      return b.quality - a.quality;
    });
  }

  /** Candidates for a requested model name, best first, cooled-down ones last. */
  candidates(requested) {
    const all = this.allModels();
    const want = (requested || 'auto').trim();
    let primary = [];
    let rest = [];
    if (want === 'auto' || want === 'fast') {
      primary = this.orderAuto(all, { fast: want === 'fast' });
    } else {
      primary = all.filter((m) => m.ref === want);
      if (!primary.length) primary = all.filter((m) => m.modelId === want || m.modelId.split('/').pop() === want);
      const fallback = this.getSettings().fallbackToAuto !== false;
      if (fallback) rest = this.orderAuto(all.filter((m) => !primary.includes(m)));
    }
    const list = [...primary, ...rest];
    const ready = [];
    const cooling = [];
    for (const m of list) (this.coolingFor(m) ? cooling : ready).push(m);
    cooling.sort((a, b) => this.coolingFor(a).until - this.coolingFor(b).until);
    return { ready, cooling };
  }

  coolingFor(m) {
    const now = this.now();
    for (const key of [m.ref, `conn:${m.connection.id}`]) {
      const c = this.cooldowns.get(key);
      if (c && c.until > now) return c;
    }
    return null;
  }

  // ---- rate windows -------------------------------------------------------

  limitsFor(m) {
    const p = m.provider ? m.provider.limits : {};
    return { rpm: m.connection.rpm ?? p.rpm ?? 0, rpd: m.connection.rpd ?? p.rpd ?? 0 };
  }

  windowFor(ref) {
    const now = this.now();
    let w = this.windows.get(ref);
    if (!w) {
      w = { minute: [], day: dayKey(now), dayCount: 0 };
      this.windows.set(ref, w);
    }
    w.minute = w.minute.filter((t) => now - t < MINUTE);
    if (w.day !== dayKey(now)) {
      w.day = dayKey(now);
      w.dayCount = 0;
    }
    return w;
  }

  hasBudget(m) {
    const { rpm, rpd } = this.limitsFor(m);
    const w = this.windowFor(m.ref);
    if (rpm && w.minute.length >= rpm) return false;
    if (rpd && w.dayCount >= rpd) return false;
    return true;
  }

  spend(m) {
    const w = this.windowFor(m.ref);
    w.minute.push(this.now());
    w.dayCount++;
  }

  // ---- failure bookkeeping ------------------------------------------------

  bench(key, ms, reason) {
    this.cooldowns.set(key, { until: this.now() + ms, reason });
  }

  onRateLimited(m, statedMs) {
    const now = this.now();
    const hits = (this.ladderHits.get(m.ref) || []).filter((t) => now - t < DAY);
    hits.push(now);
    this.ladderHits.set(m.ref, hits);
    const ladderMs = LADDER[Math.min(hits.length - 1, LADDER.length - 1)];
    const ms = statedMs || (m.connection.local ? 5000 : ladderMs);
    this.bench(m.ref, ms, statedMs ? 'rate limited (provider said when)' : 'rate limited');
  }

  classify(m, status, bodyText, headers) {
    const now = this.now();
    if (status === 429) {
      if (/quota|exhaust|per.?day|daily/i.test(bodyText || '') && !statedRetryMs(headers, bodyText, now)) {
        this.bench(m.ref, Math.max(HOUR, LADDER[2]), 'quota exhausted');
      } else {
        this.onRateLimited(m, statedRetryMs(headers, bodyText, now));
      }
    } else if (status === 401) {
      this.bench(`conn:${m.connection.id}`, 5 * MINUTE, 'key rejected (401)');
    } else if (status === 402) {
      this.bench(`conn:${m.connection.id}`, DAY, 'out of credit (402)');
    } else if (status === 403) {
      this.bench(m.ref, DAY, 'model not allowed for this key (403)');
    } else if (status === 404) {
      this.bench(m.ref, DAY, 'model not found (404)');
    } else if (status === 400 || status === 413 || status === 422) {
      // Usually the request (context too long, unsupported param) — don't punish the model long.
      this.bench(m.ref, 15_000, `request rejected (${status})`);
    } else {
      this.bench(m.ref, m.connection.local ? 5000 : 30_000, status ? `server error (${status})` : 'network error / timeout');
    }
  }

  record(m, outcome) {
    const day = dayKey(this.now());
    const u = (this.usage[day] = this.usage[day] || {});
    const c = (u[m.connection.id] = u[m.connection.id] || { requests: 0, failures: 0, promptTokens: 0, completionTokens: 0 });
    if (outcome.ok) {
      c.requests++;
      c.promptTokens += outcome.promptTokens || 0;
      c.completionTokens += outcome.completionTokens || 0;
    } else {
      c.failures++;
    }
    const entry = {
      time: this.now(),
      ref: m.ref,
      provider: m.connection.name || m.connection.providerId,
      model: m.modelId,
      ok: outcome.ok,
      status: outcome.status || 0,
      ms: outcome.ms,
      error: outcome.error || null,
      tokens: (outcome.promptTokens || 0) + (outcome.completionTokens || 0),
      source: outcome.source || 'app',
    };
    this.log.push(entry);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.onEvent({ type: 'request', entry });
  }

  // ---- the request --------------------------------------------------------

  /**
   * Run an OpenAI-style chat completion with failover.
   * @param {object} body  OpenAI chat body; body.model may be "auto", "fast", a model id, or "connId/modelId".
   * @param {object} [opts]
   * @param {(chunk: object) => void} [opts.onChunk]  stream mode: every upstream SSE JSON chunk
   * @param {AbortSignal} [opts.signal]
   * @param {string} [opts.source]  label for the request log
   * @returns {Promise<{ref, modelId, provider, content, finishReason, usage, raw, attempts}>}
   */
  async complete(body, opts = {}) {
    const { onChunk, signal, source } = opts;
    const stream = typeof onChunk === 'function';
    const { ready, cooling } = this.candidates(body.model);
    const attempts = [];

    if (!ready.length && !cooling.length) {
      throw new RouterError('No models available. Add a provider key on the Keys page and enable at least one model.', { status: 503 });
    }

    const order = [...ready];
    // If everything is cooling, still try the one that recovers soonest rather than failing outright.
    if (!order.length) order.push(cooling[0]);

    for (const m of order) {
      if (attempts.length >= MAX_ATTEMPTS) break;
      if (signal && signal.aborted) throw new RouterError('Cancelled', { status: 499, attempts });
      if (!this.hasBudget(m)) {
        attempts.push({ ref: m.ref, skipped: 'local RPM/RPD budget used up' });
        continue;
      }

      this.spend(m);
      const started = this.now();
      let emitted = false;
      try {
        const result = await this.attempt(m, body, {
          signal,
          stream,
          onChunk: stream
            ? (chunk) => {
                emitted = true;
                onChunk(chunk, m);
              }
            : null,
        });
        const usage = result.usage || {};
        const promptTokens = usage.prompt_tokens ?? estimateTokens(body.messages);
        const completionTokens = usage.completion_tokens ?? Math.ceil((result.content || '').length / 4);
        this.ladderHits.delete(m.ref);
        this.record(m, { ok: true, ms: this.now() - started, promptTokens, completionTokens, source });
        attempts.push({ ref: m.ref, ok: true });
        return {
          ref: m.ref,
          modelId: m.modelId,
          provider: m.connection.name || m.provider?.name || m.connection.providerId,
          providerId: m.connection.providerId,
          content: result.content,
          finishReason: result.finishReason,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
          raw: result.raw,
          attempts,
        };
      } catch (err) {
        if (err.name === 'AbortError' && signal && signal.aborted) throw new RouterError('Cancelled', { status: 499, attempts });
        this.classify(m, err.status || 0, err.bodyText, err.headers);
        this.record(m, { ok: false, status: err.status, ms: this.now() - started, error: err.message, source });
        attempts.push({ ref: m.ref, status: err.status || 0, error: err.message });
        // Once tokens reached the caller we can't silently switch models mid-answer.
        if (emitted) throw new RouterError(`${m.connection.name}: stream broke mid-answer (${err.message})`, { status: 502, attempts });
      }
    }

    const last = attempts.filter((a) => a.error).pop();
    throw new RouterError(
      `All ${attempts.length} attempt(s) failed${last ? ` — last error: ${last.error}` : ''}. Add more keys or wait for cooldowns to clear.`,
      { status: last && last.status === 400 ? 400 : 503, attempts }
    );
  }

  async attempt(m, body, { signal, stream, onChunk }) {
    const c = m.connection;
    const provider = m.provider || {};
    const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;

    const payload = { ...body, model: m.modelId, stream: !!stream };
    if (stream) payload.stream_options = { include_usage: true };

    const timeoutMs = this.getSettings().timeoutMs || (c.local ? 300_000 : 90_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      let res;
      try {
        res = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      } catch (e) {
        if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        throw Object.assign(new Error(ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `network error: ${e.cause?.code || e.message}`), { status: 0 });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status}: ${summarizeError(text)}`), { status: res.status, bodyText: text, headers: res.headers });
      }

      if (!stream) {
        const json = await res.json();
        const choice = (json.choices || [])[0] || {};
        const content = choice.message ? choice.message.content || '' : '';
        if (!choice.message) throw Object.assign(new Error('empty response'), { status: 502 });
        return { content, finishReason: choice.finish_reason, usage: json.usage, raw: json };
      }

      return await readSSE(res, onChunk, signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // ---- model discovery ----------------------------------------------------

  /** GET {baseUrl}/models for one connection. Returns filtered model ids. */
  async discoverModels(connection) {
    const provider = getProvider(connection.providerId) || {};
    const headers = { ...(provider.headers || {}) };
    if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let res;
    try {
      res = await this.fetch(`${connection.baseUrl.replace(/\/+$/, '')}/models`, { headers, signal: ctrl.signal });
    } catch (e) {
      throw new Error(connection.local ? 'Could not reach the local server — is it running?' : `Network error: ${e.cause?.code || e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) throw new Error(`The key was rejected (${res.status}). ${summarizeError(text)}`);
      throw new Error(`HTTP ${res.status}: ${summarizeError(text)}`);
    }
    const json = await res.json();
    let raw = Array.isArray(json) ? json : json.data || json.models || [];
    if (provider.modelObjectFilter) raw = raw.filter((x) => typeof x !== 'object' || provider.modelObjectFilter(x));
    let ids = raw.map((x) => (typeof x === 'string' ? x : x.id || x.name)).filter(Boolean);
    if (provider.normalizeModelId) ids = ids.map(provider.normalizeModelId);
    if (provider.modelFilter) ids = ids.filter(provider.modelFilter);
    ids = ids.filter((id) => !/embed|whisper|tts|dall-e|stable-diffusion|flux|rerank|moderation|guard|safety|lyria|image|video/i.test(id));
    return [...new Set(ids)].sort((a, b) => modelQuality(b) - modelQuality(a) || a.localeCompare(b));
  }

  // ---- persistence & views -----------------------------------------------

  snapshot() {
    return {
      usage: this.usage,
      cooldowns: [...this.cooldowns.entries()].filter(([, v]) => v.until > this.now()),
      windows: [...this.windows.entries()].map(([k, v]) => [k, { day: v.day, dayCount: v.dayCount }]),
      log: this.log.slice(-200),
    };
  }

  restore(snap) {
    if (!snap) return;
    this.usage = snap.usage || {};
    this.cooldowns = new Map(snap.cooldowns || []);
    for (const [k, v] of snap.windows || []) this.windows.set(k, { minute: [], day: v.day, dayCount: v.dayCount });
    this.log = snap.log || [];
  }

  clearCooldowns() {
    this.cooldowns.clear();
    this.ladderHits.clear();
  }

  status() {
    const now = this.now();
    const models = this.allModels().map((m) => {
      const cool = this.coolingFor(m);
      const { rpm, rpd } = this.limitsFor(m);
      const w = this.windowFor(m.ref);
      return {
        ref: m.ref,
        modelId: m.modelId,
        connectionId: m.connection.id,
        provider: m.connection.name,
        quality: m.quality,
        cooldownUntil: cool ? cool.until : null,
        cooldownReason: cool ? cool.reason : null,
        rpm,
        rpd,
        usedMinute: w.minute.length,
        usedToday: w.dayCount,
      };
    });
    return { now, models, usage: this.usage, log: this.log.slice(-200) };
  }
}

async function readSSE(res, onChunk, signal) {
  let content = '';
  let finishReason = null;
  let usage = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let sawChunk = false;
  try {
    for (;;) {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          const msg = chunk.error.message || JSON.stringify(chunk.error);
          throw Object.assign(new Error(msg), { status: chunk.error.code === 429 ? 429 : 502, bodyText: data });
        }
        sawChunk = true;
        const choice = (chunk.choices || [])[0];
        if (choice) {
          if (choice.delta && typeof choice.delta.content === 'string') content += choice.delta.content;
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (chunk.usage) usage = chunk.usage;
        onChunk(chunk);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (!sawChunk) throw Object.assign(new Error('empty stream'), { status: 502 });
  return { content, finishReason, usage, raw: null };
}

function summarizeError(text) {
  if (!text) return 'no details';
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    const msg = (e && (e.message || e.msg)) || j.message || j.detail;
    if (msg) return String(msg).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

module.exports = { Router, RouterError, statedRetryMs, estimateTokens, LADDER };

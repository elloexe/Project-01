'use strict';

// Local OpenAI-compatible endpoint (http://127.0.0.1:<port>/v1) so Cursor,
// Cline, Continue, Aider, Open WebUI, scripts, etc. can use the pooled keys.
// Extra virtual models:
//   auto / fast            -> router picks
//   crew/<department>      -> that department's persona on the auto route
//   crew/company           -> the full multi-department pipeline (text only)

const http = require('http');
const crypto = require('crypto');
const { DEPARTMENTS, getDepartment, systemPromptFor } = require('./departments');
const { askCompany } = require('./crew');

const MAX_BODY = 20 * 1024 * 1024;

function createApiServer({ router, getConfig, onEvent = () => {} }) {
  let server = null;
  let boundPort = null;

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors() });
    res.end(body);
  }

  function cors() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
  }

  function apiError(res, status, message, type = 'invalid_request_error') {
    send(res, status, { error: { message, type, code: status } });
  }

  function authorized(req) {
    const { requireKey, localKey } = getConfig();
    if (!requireKey) return true;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.headers['x-api-key'] || '').trim();
    if (!token || !localKey) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(localKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Request body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function listModels() {
    const created = Math.floor(Date.now() / 1000);
    const ids = ['auto', 'fast', 'crew/company', ...DEPARTMENTS.map((d) => `crew/${d.id}`)];
    const seen = new Set(ids);
    for (const m of router.allModels()) {
      for (const id of [m.modelId, m.ref]) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    return { object: 'list', data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'ello-crew' })) };
  }

  function sseHeaders(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors() });
  }

  function textChunk(id, model, content, finish = null) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
    };
  }

  async function handleCompany(body, res, signal) {
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const question = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content || []).map((p) => p.text || '').join('')) : '';
    if (!question) return apiError(res, 400, 'crew/company needs a user message');
    const history = [];
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role === 'user' && msgs[i + 1] && msgs[i + 1].role === 'assistant') {
        history.push({ question: String(msgs[i].content), answer: String(msgs[i + 1].content) });
      }
    }
    const id = `chatcmpl-crew-${crypto.randomUUID()}`;
    const stream = !!body.stream;
    if (stream) sseHeaders(res);
    const t = await askCompany({
      router,
      question,
      history,
      options: { maxDepartments: 3, reviewer: false },
      signal,
      emit: (e) => {
        if (!stream) return;
        if (e.type === 'final-delta') res.write(`data: ${JSON.stringify(textChunk(id, 'crew/company', e.delta))}\n\n`);
        if (e.type === 'final-done' && e.single) res.write(`data: ${JSON.stringify(textChunk(id, 'crew/company', e.content))}\n\n`);
      },
    });
    if (stream) {
      res.write(`data: ${JSON.stringify(textChunk(id, 'crew/company', null, 'stop'))}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      send(res, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'crew/company',
        choices: [{ index: 0, message: { role: 'assistant', content: t.answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  }

  async function handleChat(req, res) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return apiError(res, e.status || 400, e.status ? e.message : 'Body must be JSON');
    }
    if (!Array.isArray(body.messages)) return apiError(res, 400, '"messages" must be an array');

    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort();
    });

    const requested = String(body.model || 'auto');
    try {
      if (requested === 'crew/company') return await handleCompany(body, res, ctrl.signal);

      if (requested.startsWith('crew/')) {
        const dept = getDepartment(requested.slice(5));
        if (!dept) return apiError(res, 404, `Unknown department model ${requested}`);
        body = { ...body, model: 'auto', messages: [{ role: 'system', content: systemPromptFor(dept) }, ...body.messages] };
      }

      if (body.stream) {
        let started = false;
        const result = await router.complete(body, {
          signal: ctrl.signal,
          source: 'api',
          onChunk: (chunk) => {
            if (!started) {
              sseHeaders(res);
              started = true;
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          },
        });
        if (!started) sseHeaders(res);
        res.write('data: [DONE]\n\n');
        res.end();
        onEvent({ type: 'api-request', model: result.modelId });
      } else {
        const result = await router.complete(body, { signal: ctrl.signal, source: 'api' });
        const raw = result.raw || {};
        send(res, 200, { ...raw, usage: raw.usage || result.usage });
        onEvent({ type: 'api-request', model: result.modelId });
      }
    } catch (e) {
      if (res.headersSent) {
        // Mid-stream failure: surface it in-band, then close.
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'upstream_error' } })}\n\n`);
        res.end();
      } else if (e.status !== 499) {
        apiError(res, e.status || 500, e.message, e.status === 503 ? 'no_capacity' : 'upstream_error');
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      return res.end();
    }
    if (path === '/' || path === '/health') return send(res, 200, { ok: true, name: 'ello Crew', api: '/v1' });
    if (!authorized(req)) return apiError(res, 401, 'Missing or wrong API key. Copy it from ello Crew → Local API.', 'authentication_error');
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return send(res, 200, listModels());
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) return handleChat(req, res);
    return apiError(res, 404, `Not found: ${req.method} ${path}. Supported: GET /v1/models, POST /v1/chat/completions`);
  }

  return {
    async start() {
      const { port, host = '127.0.0.1' } = getConfig();
      if (server) await this.stop();
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          if (!res.headersSent) apiError(res, 500, e.message, 'server_error');
          else res.end();
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      boundPort = server.address().port;
      return boundPort;
    },
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      boundPort = null;
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(() => resolve()));
    },
    get running() {
      return !!server;
    },
    get port() {
      return boundPort;
    },
  };
}

module.exports = { createApiServer };

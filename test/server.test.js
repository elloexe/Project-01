'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/core/router');
const { createApiServer } = require('../src/core/server');
const { textStream, completion, fakeFetch, conn } = require('./helpers');

async function withServer(handler, config, fn) {
  const upstream = fakeFetch(handler);
  const router = new Router({ getConnections: () => [conn('a', 'groq', ['llama-3.3-70b-versatile'])], fetchImpl: upstream });
  const cfg = { port: 0, requireKey: true, localKey: 'sk-ello-test', ...config };
  const server = createApiServer({ router, getConfig: () => cfg });
  const port = await server.start();
  try {
    await fn(`http://127.0.0.1:${port}`, upstream);
  } finally {
    await server.stop();
  }
}

const auth = { Authorization: 'Bearer sk-ello-test', 'Content-Type': 'application/json' };

test('rejects requests without the local key', async () => {
  await withServer(() => completion('x'), {}, async (base) => {
    const r = await fetch(`${base}/v1/models`);
    assert.equal(r.status, 401);
    const ok = await fetch(`${base}/v1/models`, { headers: auth });
    assert.equal(ok.status, 200);
  });
});

test('lists virtual and real models', async () => {
  await withServer(() => completion('x'), {}, async (base) => {
    const j = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
    const ids = j.data.map((m) => m.id);
    for (const id of ['auto', 'fast', 'crew/company', 'crew/security', 'llama-3.3-70b-versatile', 'a/llama-3.3-70b-versatile']) assert.ok(ids.includes(id), id);
  });
});

test('non-streaming chat completion passes through', async () => {
  await withServer(() => completion('pong'), {}, async (base) => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping' }] }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.choices[0].message.content, 'pong');
  });
});

test('streaming chat completion relays SSE chunks', async () => {
  await withServer(() => textStream('streamed reply'), {}, async (base) => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const text = await r.text();
    const content = text
      .split('\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content || '')
      .join('');
    assert.equal(content, 'streamed reply');
    assert.ok(text.trim().endsWith('data: [DONE]'));
  });
});

test('crew/<department> injects the persona', async () => {
  await withServer(
    (c) => {
      assert.match(c.body.messages[0].content, /head of Security/);
      return completion('secure');
    },
    {},
    async (base, upstream) => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'crew/security', messages: [{ role: 'user', content: 'q' }] }) });
      assert.equal((await r.json()).choices[0].message.content, 'secure');
      assert.equal(upstream.calls[0].model, 'llama-3.3-70b-versatile');
    }
  );
});

test('crew/company returns the pipeline answer', async () => {
  await withServer(
    (c) => {
      const sys = c.body.messages[0].content;
      if (sys.includes('Decide which departments')) return completion('{"departments":[{"id":"finance"}]}');
      return textStream('Finance says: save money.');
    },
    {},
    async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'crew/company', messages: [{ role: 'user', content: 'budget?' }] }) });
      assert.equal((await r.json()).choices[0].message.content, 'Finance says: save money.');
    }
  );
});

test('requireKey=false allows anonymous local use; bad JSON is a 400', async () => {
  await withServer(() => completion('x'), { requireKey: false }, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 200);
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{nope' });
    assert.equal(r.status, 400);
  });
});

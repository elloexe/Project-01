'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Router, statedRetryMs, LADDER } = require('../src/core/router');
const { jsonResponse, textStream, completion, fakeFetch, conn } = require('./helpers');

function makeRouter(connections, handler, settings = {}) {
  let now = 1_700_000_000_000;
  const clock = { now: () => now, advance: (ms) => (now += ms) };
  const fetchImpl = fakeFetch(handler);
  const router = new Router({ getConnections: () => connections, getSettings: () => settings, fetchImpl, now: clock.now });
  return { router, fetchImpl, clock };
}

test('auto prefers the more capable model and answers', async () => {
  const conns = [conn('groq-a', 'groq', ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'])];
  const { router, fetchImpl } = makeRouter(conns, (c) => completion(`hi from ${c.model}`));
  const r = await router.complete({ model: 'auto', messages: [{ role: 'user', content: 'hey' }] });
  assert.equal(r.modelId, 'llama-3.3-70b-versatile');
  assert.equal(r.content, 'hi from llama-3.3-70b-versatile');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer key-groq-a');
});

test('fails over to the next provider on 429 and cools the first one down', async () => {
  const conns = [conn('a', 'groq', ['llama-3.3-70b-versatile']), conn('b', 'cerebras', ['llama-3.3-70b'])];
  const { router, clock } = makeRouter(conns, (c) => (c.host === 'a.test' ? jsonResponse(429, { error: { message: 'slow down' } }) : completion('from b')));
  const r = await router.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.content, 'from b');
  assert.equal(r.attempts.length, 2);
  const cooled = router.status().models.find((m) => m.ref === 'a/llama-3.3-70b-versatile');
  assert.equal(cooled.cooldownUntil, clock.now() + LADDER[0]);
  // Next request goes straight to b without retrying a.
  const r2 = await router.complete({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r2.attempts.length, 1);
});

test('honours Retry-After from the provider', async () => {
  const conns = [conn('a', 'groq', ['m1']), conn('b', 'groq', ['m2'])];
  const { router, clock } = makeRouter(conns, (c) => (c.host === 'a.test' ? jsonResponse(429, {}, { 'retry-after': '17' }) : completion('ok')));
  await router.complete({ model: 'a/m1', messages: [] });
  const m = router.status().models.find((x) => x.ref === 'a/m1');
  assert.equal(m.cooldownUntil, clock.now() + 17_000);
});

test('401 benches the whole key, not just the model', async () => {
  const conns = [conn('a', 'groq', ['m1', 'm2']), conn('b', 'mistral', ['m3'])];
  const { router } = makeRouter(conns, (c) => (c.host === 'a.test' ? jsonResponse(401, { error: { message: 'bad key' } }) : completion('ok')));
  await router.complete({ model: 'a/m1', messages: [] });
  const st = router.status().models;
  assert.ok(st.find((x) => x.ref === 'a/m1').cooldownUntil);
  assert.ok(st.find((x) => x.ref === 'a/m2').cooldownUntil, 'sibling model on the same key is benched too');
  assert.equal(st.find((x) => x.ref === 'b/m3').cooldownUntil, null);
});

test('enforces local RPM budget before calling the provider', async () => {
  const conns = [conn('a', 'groq', ['m1'], { rpm: 2 }), conn('b', 'mistral', ['m2'], { rpm: 0 })];
  const { router, fetchImpl } = makeRouter(conns, (c) => completion(c.host), { pinned: ['a/m1'] });
  await router.complete({ model: 'auto', messages: [] });
  await router.complete({ model: 'auto', messages: [] });
  const r3 = await router.complete({ model: 'auto', messages: [] });
  assert.equal(r3.content, 'b.test');
  assert.equal(fetchImpl.calls.filter((c) => c.host === 'a.test').length, 2);
});

test('pinned models are tried first', async () => {
  const conns = [conn('a', 'groq', ['llama-3.3-70b-versatile']), conn('b', 'groq', ['llama-3.1-8b-instant'])];
  const { router } = makeRouter(conns, (c) => completion(c.model), { pinned: ['b/llama-3.1-8b-instant'] });
  const r = await router.complete({ model: 'auto', messages: [] });
  assert.equal(r.modelId, 'llama-3.1-8b-instant');
});

test('streams chunks and aggregates content + usage', async () => {
  const conns = [conn('a', 'groq', ['m1'])];
  const { router } = makeRouter(conns, () => textStream('Hello streaming world'));
  const deltas = [];
  const r = await router.complete({ model: 'auto', messages: [] }, { onChunk: (c) => c.choices[0].delta.content && deltas.push(c.choices[0].delta.content) });
  assert.equal(deltas.join(''), 'Hello streaming world');
  assert.equal(r.content, 'Hello streaming world');
  assert.equal(r.usage.completion_tokens, 5);
});

test('network errors fail over too', async () => {
  const conns = [conn('a', 'groq', ['m1']), conn('b', 'groq', ['m2'])];
  const { router } = makeRouter(conns, (c) => {
    if (c.host === 'a.test') throw new TypeError('fetch failed');
    return completion('fine');
  });
  const r = await router.complete({ model: 'auto', messages: [] });
  assert.equal(r.content, 'fine');
});

test('all candidates failing gives a clear error with attempts', async () => {
  const conns = [conn('a', 'groq', ['m1']), conn('b', 'groq', ['m2'])];
  const { router } = makeRouter(conns, () => jsonResponse(500, { error: { message: 'boom' } }));
  await assert.rejects(router.complete({ model: 'auto', messages: [] }), (e) => {
    assert.match(e.message, /All 2 attempt/);
    assert.equal(e.attempts.length, 2);
    return true;
  });
});

test('no connections -> helpful error', async () => {
  const { router } = makeRouter([], () => completion('x'));
  await assert.rejects(router.complete({ model: 'auto', messages: [] }), /Add a provider key/);
});

test('specific model id routes to every connection serving it', async () => {
  const conns = [conn('a', 'groq', ['shared', 'other']), conn('b', 'cerebras', ['shared'])];
  const { router } = makeRouter(conns, (c) => (c.host === 'a.test' ? jsonResponse(429, {}) : completion('b served it')), { fallbackToAuto: false });
  const r = await router.complete({ model: 'shared', messages: [] });
  assert.equal(r.ref, 'b/shared');
});

test('discoverModels filters per provider rules', async () => {
  const conns = [conn('or', 'openrouter', [])];
  const { router } = makeRouter(conns, () => jsonResponse(200, { data: [{ id: 'a/b:free' }, { id: 'a/paid' }, { id: 'c/d:free' }] }));
  const ids = await router.discoverModels(conns[0]);
  assert.deepEqual(ids.sort(), ['a/b:free', 'c/d:free']);
});

test('discoverModels strips Gemini "models/" prefixes and non-chat models', async () => {
  const conns = [conn('g', 'google', [])];
  const { router } = makeRouter(conns, () => jsonResponse(200, { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-embedding-001' }] }));
  assert.deepEqual(await router.discoverModels(conns[0]), ['gemini-2.5-flash']);
});

test('statedRetryMs parses headers and bodies', () => {
  const H = (v) => ({ get: (k) => (k === 'retry-after' ? v : null) });
  assert.equal(statedRetryMs(H('5'), '', 0), 5000);
  assert.equal(statedRetryMs(null, '{"error":{"details":[{"retryDelay":"17s"}]}}', 0), 17000);
  assert.equal(statedRetryMs(null, 'Rate limit reached. Please try again in 2m.', 0), 120000);
  assert.equal(statedRetryMs(null, 'error code 500 something', 0), null);
  assert.equal(statedRetryMs(H('999999999'), '', 0), 24 * 3600 * 1000, 'clamped to a day');
});

test('snapshot/restore keeps usage and cooldowns', async () => {
  const conns = [conn('a', 'groq', ['m1']), conn('b', 'groq', ['m2'])];
  const { router } = makeRouter(conns, (c) => (c.host === 'a.test' ? jsonResponse(429, {}) : completion('ok')));
  await router.complete({ model: 'a/m1', messages: [] });
  const snap = JSON.parse(JSON.stringify(router.snapshot()));
  const { router: r2 } = makeRouter(conns, () => completion('ok'));
  r2.restore(snap);
  assert.ok(r2.status().models.find((m) => m.ref === 'a/m1').cooldownUntil);
  assert.ok(r2.log.length >= 2);
});

test('discoverModels keeps only free-tier LLM7 chat models', async () => {
  const conns = [conn('l7', 'llm7', [])];
  const { router } = makeRouter(conns, () =>
    jsonResponse(200, { data: [
      { id: 'gpt-oss:20b', model_type: 'chat', usage_based_only: false },
      { id: 'claude-opus-5', model_type: 'chat', usage_based_only: true },
      { id: 'whisper-large-v3', model_type: 'audio_to_text', usage_based_only: false },
    ] })
  );
  assert.deepEqual(await router.discoverModels(conns[0]), ['gpt-oss:20b']);
});

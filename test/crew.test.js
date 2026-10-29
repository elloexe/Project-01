'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/core/router');
const { askCompany, askDepartment, parseRouting } = require('../src/core/crew');
const { keywordRoute, DEPARTMENTS } = require('../src/core/departments');
const { textStream, completion, fakeFetch, conn } = require('./helpers');

function router(handler) {
  return new Router({ getConnections: () => [conn('a', 'groq', ['llama-3.3-70b-versatile'])], fetchImpl: fakeFetch(handler) });
}

const systemOf = (c) => (c.body.messages.find((m) => m.role === 'system') || {}).content || '';

test('parseRouting tolerates fences, chatter and unknown ids', () => {
  const r = parseRouting('Sure!\n```json\n{"departments":[{"id":"Technology","brief":"b1"},{"id":"nope"},{"id":"security"}],"reason":"r"}\n```', 3);
  assert.deepEqual(r.departments.map((d) => d.id), ['technology', 'security']);
  assert.equal(r.departments[0].brief, 'b1');
  assert.equal(parseRouting('no json here', 3), null);
  assert.equal(parseRouting('{"departments":[]}', 3), null);
  assert.equal(parseRouting('{"departments":["finance","legal & risk","marketing","people"]}', 2).departments.length, 2);
});

test('keywordRoute falls back sensibly', () => {
  assert.ok(keywordRoute('my python script throws an error').includes('technology'));
  assert.ok(keywordRoute('how should I price my subscription').includes('revenue'));
  assert.deepEqual(keywordRoute('hmm'), ['executive']);
});

test('every department has the fields the UI needs', () => {
  assert.equal(DEPARTMENTS.length, 16);
  for (const d of DEPARTMENTS) {
    for (const k of ['id', 'name', 'lead', 'icon', 'color', 'summary', 'prompt']) assert.ok(d[k], `${d.id}.${k}`);
    assert.ok(d.specialties.length >= 3);
  }
});

test('askCompany: routes, departments answer, CEO synthesises', async () => {
  const r = router((c) => {
    const sys = systemOf(c);
    if (sys.includes('Decide which departments')) {
      return completion('{"departments":[{"id":"finance","brief":"cost it"},{"id":"marketing","brief":"pitch it"}],"reason":"money and message"}');
    }
    if (sys.includes('Your departments have reported')) {
      assert.match(c.body.messages.at(-1).content, /### Finance/);
      assert.match(c.body.messages.at(-1).content, /### Marketing/);
      return textStream('Bottom line: do it.');
    }
    if (sys.includes('head of Finance')) return textStream('It costs $10.');
    if (sys.includes('head of Marketing')) return textStream('Say it loud.');
    throw new Error(`unexpected call: ${sys.slice(0, 80)}`);
  });
  const events = [];
  const t = await askCompany({ router: r, question: 'Should I sell lemonade?', emit: (e) => events.push(e) });
  assert.equal(t.routing.method, 'ceo');
  assert.deepEqual(t.departments.map((d) => d.id).sort(), ['finance', 'marketing']);
  assert.equal(t.answer, 'Bottom line: do it.');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('routing'));
  assert.ok(types.includes('dept-delta'));
  assert.ok(types.includes('final-delta'));
  assert.equal(types.at(-1), 'final-done');
});

test('askCompany: single department answer is returned directly (no synthesis call)', async () => {
  let calls = 0;
  const r = router((c) => {
    calls++;
    const sys = systemOf(c);
    if (sys.includes('Decide which departments')) return completion('{"departments":[{"id":"technology"}]}');
    return textStream('Use a profiler.');
  });
  const t = await askCompany({ router: r, question: 'Why is my app slow?', emit: () => {} });
  assert.equal(t.answer, 'Use a profiler.');
  assert.equal(calls, 2);
});

test('askCompany: bad routing JSON falls back to keywords; reviewer runs when asked', async () => {
  const r = router((c) => {
    const sys = systemOf(c);
    if (sys.includes('Decide which departments')) return completion('I think technology and security.');
    if (sys.includes('independent reviewer')) return textStream('- Missing: backups.');
    if (sys.includes('Your departments have reported')) {
      assert.match(c.body.messages.at(-1).content, /Reviewer's notes/);
      return textStream('Final.');
    }
    return textStream('answer');
  });
  const events = [];
  const t = await askCompany({ router: r, question: 'Is my password database encryption secure?', options: { reviewer: true }, emit: (e) => events.push(e) });
  assert.equal(t.routing.method, 'keywords');
  assert.ok(t.routing.departments.some((d) => d.id === 'security'));
  assert.equal(t.review.content, '- Missing: backups.');
  assert.equal(t.answer, 'Final.');
});

test('askDepartment uses the specialist persona', async () => {
  const r = router((c) => {
    assert.match(systemOf(c), /Threat modeling specialist in Security/);
    return textStream('STRIDE it.');
  });
  const out = await askDepartment({ router: r, deptId: 'security', specialty: 'Threat modeling', question: 'q', emit: () => {} });
  assert.equal(out.answer, 'STRIDE it.');
});

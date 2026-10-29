'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render } = require('../src/renderer/markdown');
const { Store } = require('../src/main/store');
const { modelQuality } = require('../src/core/providers');

test('markdown escapes HTML from model output', () => {
  const out = render('<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1))');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.includes('<strong>bold</strong>'));
  assert.ok(!out.includes('href="javascript'));
});

test('markdown renders code, lists, tables and links', () => {
  const out = render('# T\n\n- a\n- b\n\n1. one\n\n```js\nconst x = "<b>";\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nsee https://example.com.');
  assert.match(out, /<h2>T<\/h2>/);
  assert.match(out, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(out, /<ol><li>one<\/li><\/ol>/);
  assert.match(out, /const x = &quot;&lt;b&gt;&quot;;/);
  assert.match(out, /<table>/);
  assert.match(out, /<a href="https:\/\/example.com"/);
});

test('store encrypts keys and never exposes them publicly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'));
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (b) => b.toString().split('').reverse().join(''),
  };
  const store = new Store(dir, fakeSafe);
  const c = store.addConnection({ providerId: 'groq', name: 'Groq', baseUrl: 'https://x/v1', apiKey: 'gsk_secret1234', models: ['m'] });
  store.flush();
  const disk = fs.readFileSync(path.join(dir, 'ello-crew.json'), 'utf8');
  assert.ok(!disk.includes('gsk_secret1234'));
  assert.equal(store.connectionsWithKeys()[0].apiKey, 'gsk_secret1234');
  const pub = store.publicConnections()[0];
  assert.equal(pub.apiKeyEnc, undefined);
  assert.equal(pub.keyPreview, 'gsk_…1234');
  assert.match(store.settings.api.localKey, /^sk-ello-/);

  // Reload from disk.
  const again = new Store(dir, fakeSafe);
  assert.equal(again.connectionsWithKeys()[0].apiKey, 'gsk_secret1234');
  again.removeConnection(c.id);
  assert.equal(again.publicConnections().length, 0);
});

test('conversations persist turns and titles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'));
  const store = new Store(dir, null);
  const conv = store.createConversation({ mode: 'company' });
  store.addTurn(conv.id, { question: 'How do I grow my newsletter?', answer: 'Write weekly.' });
  store.flush();
  const again = new Store(dir, null);
  const list = again.listConversations();
  assert.equal(list[0].title, 'How do I grow my newsletter?');
  assert.equal(list[0].turnCount, 1);
});

test('model quality ranks big models above tiny ones', () => {
  assert.ok(modelQuality('llama-3.3-70b-versatile') > modelQuality('llama-3.1-8b-instant'));
  assert.ok(modelQuality('openai/gpt-oss-120b') > modelQuality('gemini-2.5-flash-lite'));
});

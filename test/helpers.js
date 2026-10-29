'use strict';

// A scriptable fake of an OpenAI-compatible provider, so tests never touch the network.

function jsonResponse(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textStream(text, model = 'm') {
  const parts = text.match(/.{1,7}/gs) || [''];
  return sseResponse([
    ...parts.map((p) => ({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })),
    { id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

function completion(text, model = 'm') {
  return jsonResponse(200, {
    id: 'x',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/**
 * handler(ctx) -> Response | Promise<Response>, ctx = { url, host, model, body, stream, headers }
 */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const ctx = { url, host: u.host, path: u.pathname, model: body && body.model, body, stream: !!(body && body.stream), headers: init.headers || {} };
    calls.push(ctx);
    if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return handler(ctx);
  };
  fn.calls = calls;
  return fn;
}

function conn(id, providerId, models, extra = {}) {
  return {
    id,
    providerId,
    name: id,
    baseUrl: `https://${id}.test/v1`,
    apiKey: `key-${id}`,
    enabled: true,
    models: models.map((m) => ({ id: m, enabled: true })),
    ...extra,
  };
}

module.exports = { jsonResponse, sseResponse, textStream, completion, fakeFetch, conn };

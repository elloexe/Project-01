'use strict';

// Orchestrates a question through the company:
//   1. the CEO picks which departments should weigh in (and briefs each one),
//   2. those departments answer in parallel,
//   3. an optional reviewer red-teams the answers,
//   4. the CEO synthesises one final recommendation.
// Every step goes through the router, so each can land on a different free model.

const { DEPARTMENTS, getDepartment, systemPromptFor, keywordRoute } = require('./departments');

const MAX_HISTORY_TURNS = 6;

function routingPrompt(maxDepts) {
  const list = DEPARTMENTS.map((d) => `- ${d.id}: ${d.name} — ${d.summary}`).join('\n');
  return [
    'You are the Chief Executive of an AI company. Decide which departments should answer the owner\'s request.',
    `Departments:\n${list}`,
    `Pick the 1 to ${maxDepts} departments whose expertise matters most (fewer is better; pick 1 for simple or narrow questions).`,
    'For each, write a one-sentence brief of exactly what you need from them.',
    'Reply with ONLY a JSON object, no prose, in this shape:',
    '{"departments":[{"id":"technology","brief":"..."}],"reason":"one short sentence"}',
  ].join('\n\n');
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
function parseRouting(text, maxDepts) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const raw = Array.isArray(obj.departments) ? obj.departments : [];
  const seen = new Set();
  const picks = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item : item && item.id;
    const norm = String(id || '').toLowerCase().trim().replace(/[\s_&]+/g, '-');
    const dept = getDepartment(norm) || DEPARTMENTS.find((d) => d.name.toLowerCase() === String(id || '').toLowerCase());
    if (!dept || seen.has(dept.id)) continue;
    seen.add(dept.id);
    picks.push({ id: dept.id, brief: (item && item.brief) || '' });
    if (picks.length >= maxDepts) break;
  }
  if (!picks.length) return null;
  return { departments: picks, reason: typeof obj.reason === 'string' ? obj.reason : '' };
}

function historyMessages(history) {
  const out = [];
  for (const turn of (history || []).slice(-MAX_HISTORY_TURNS)) {
    if (turn.question) out.push({ role: 'user', content: turn.question });
    if (turn.answer) out.push({ role: 'assistant', content: turn.answer });
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Ask the whole company.
 * @param {object} p
 * @param {import('./router').Router} p.router
 * @param {string} p.question
 * @param {Array<{question, answer}>} [p.history]
 * @param {string} [p.model]  model for department answers ("auto" by default)
 * @param {object} [p.options] { maxDepartments, reviewer, departments: string[] (skip routing), parallel }
 * @param {(evt: object) => void} p.emit
 * @param {AbortSignal} [p.signal]
 */
async function askCompany({ router, question, history = [], model = 'auto', options = {}, emit, signal }) {
  const maxDepts = Math.max(1, Math.min(5, options.maxDepartments || 3));
  const prior = historyMessages(history);
  const transcript = { question, routing: null, departments: [], review: null, answer: '', models: [] };
  const note = (r) => transcript.models.push({ step: r.step, model: r.modelId, provider: r.provider });

  // 1) Routing.
  let routing;
  if (options.departments && options.departments.length) {
    routing = { departments: options.departments.slice(0, maxDepts).map((id) => ({ id, brief: '' })), reason: 'Chosen by you.', method: 'manual' };
  } else {
    emit({ type: 'stage', stage: 'routing' });
    try {
      const r = await router.complete(
        {
          model: options.routingModel || 'fast',
          temperature: 0.1,
          // Generous: free reasoning models spend hundreds of tokens thinking before the JSON.
          max_tokens: 3000,
          messages: [
            { role: 'system', content: routingPrompt(maxDepts) },
            ...prior.slice(-2),
            { role: 'user', content: question },
          ],
        },
        { signal, source: 'crew:routing' }
      );
      note({ step: 'routing', ...r });
      routing = parseRouting(r.content, maxDepts);
      if (routing) routing.method = 'ceo';
    } catch (e) {
      if (e.status === 499) throw e;
      emit({ type: 'warning', message: `Routing call failed (${e.message}); using keyword routing.` });
    }
    if (!routing) {
      routing = { departments: keywordRoute(question, maxDepts).map((id) => ({ id, brief: '' })), reason: 'Matched by keywords.', method: 'keywords' };
    }
  }
  transcript.routing = routing;
  emit({ type: 'routing', routing });

  // 2) Departments answer.
  const concurrency = options.parallel === false ? 1 : 3;
  await mapLimit(routing.departments, concurrency, async (pick) => {
    const dept = getDepartment(pick.id);
    const entry = { id: dept.id, name: dept.name, brief: pick.brief, content: '', model: null, provider: null, error: null };
    transcript.departments.push(entry);
    emit({ type: 'dept-start', id: dept.id, brief: pick.brief });
    const brief = pick.brief ? `\n\nThe CEO's brief for your department: ${pick.brief}` : '';
    const multi = routing.departments.length > 1
      ? `\n\nOther departments also answering: ${routing.departments.filter((d) => d.id !== dept.id).map((d) => getDepartment(d.id).name).join(', ')}. Stay in your lane and keep it under ~300 words.`
      : '';
    try {
      const r = await router.complete(
        {
          model,
          temperature: 0.6,
          messages: [{ role: 'system', content: systemPromptFor(dept) + brief + multi }, ...prior, { role: 'user', content: question }],
        },
        {
          signal,
          source: `crew:${dept.id}`,
          onChunk: (chunk) => {
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (delta && delta.content) emit({ type: 'dept-delta', id: dept.id, delta: delta.content });
          },
        }
      );
      entry.content = r.content;
      entry.model = r.modelId;
      entry.provider = r.provider;
      note({ step: dept.id, ...r });
      emit({ type: 'dept-done', id: dept.id, model: r.modelId, provider: r.provider, content: r.content });
    } catch (e) {
      if (e.status === 499) throw e;
      entry.error = e.message;
      emit({ type: 'dept-error', id: dept.id, error: e.message });
    }
  });

  const answered = transcript.departments.filter((d) => d.content);
  if (!answered.length) {
    throw Object.assign(new Error(transcript.departments[0]?.error || 'No department could answer.'), { status: 503 });
  }

  // A single department's answer *is* the answer unless a review was asked for.
  const memos = answered.map((d) => `### ${d.name}\n${d.content}`).join('\n\n');

  // 3) Optional red-team review.
  if (options.reviewer) {
    emit({ type: 'stage', stage: 'review' });
    try {
      const r = await router.complete(
        {
          model,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content:
                'You are the company\'s independent reviewer. You do not add a new opinion; you check the work. List, briefly: factual errors or shaky claims, contradictions between departments, important risks or options nobody mentioned, and anything that needs a human expert. If the work is solid, say so in one line. Use Markdown bullets, under 200 words.',
            },
            { role: 'user', content: `Owner's question:\n${question}\n\nDepartment answers:\n\n${memos}` },
          ],
        },
        {
          signal,
          source: 'crew:review',
          onChunk: (chunk) => {
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (delta && delta.content) emit({ type: 'review-delta', delta: delta.content });
          },
        }
      );
      transcript.review = { content: r.content, model: r.modelId, provider: r.provider };
      note({ step: 'review', ...r });
      emit({ type: 'review-done', model: r.modelId, provider: r.provider, content: r.content });
    } catch (e) {
      if (e.status === 499) throw e;
      emit({ type: 'warning', message: `Review step failed: ${e.message}` });
    }
  }

  if (answered.length === 1 && !transcript.review) {
    transcript.answer = answered[0].content;
    emit({ type: 'final-done', content: transcript.answer, single: true });
    return transcript;
  }

  // 4) CEO synthesis.
  emit({ type: 'stage', stage: 'synthesis' });
  const reviewText = transcript.review ? `\n\nReviewer's notes:\n${transcript.review.content}` : '';
  const r = await router.complete(
    {
      model,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'You are the Chief Executive. Your departments have reported. Write the owner ONE clear answer that integrates their input: resolve disagreements (say which way you lean and why), take the reviewer\'s notes into account if present, and do not just restate each memo. Structure: a 1–2 sentence bottom line first, then the key points, then a short numbered list of next steps. Markdown. Credit departments briefly in parentheses where useful.',
        },
        ...prior,
        { role: 'user', content: `${question}\n\n---\nDepartment reports:\n\n${memos}${reviewText}` },
      ],
    },
    {
      signal,
      source: 'crew:synthesis',
      onChunk: (chunk) => {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) emit({ type: 'final-delta', delta: delta.content });
      },
    }
  );
  note({ step: 'synthesis', ...r });
  transcript.answer = r.content;
  transcript.synthesisModel = { model: r.modelId, provider: r.provider };
  emit({ type: 'final-done', content: r.content, model: r.modelId, provider: r.provider });
  return transcript;
}

/** Talk to one department (or one specialist in it) directly, streaming. */
async function askDepartment({ router, deptId, specialty, question, history = [], model = 'auto', emit, signal }) {
  const dept = getDepartment(deptId);
  if (!dept) throw new Error(`Unknown department ${deptId}`);
  const r = await router.complete(
    {
      model,
      temperature: 0.6,
      messages: [{ role: 'system', content: systemPromptFor(dept, specialty) }, ...historyMessages(history), { role: 'user', content: question }],
    },
    {
      signal,
      source: `direct:${dept.id}`,
      onChunk: (chunk) => {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) emit({ type: 'final-delta', delta: delta.content });
      },
    }
  );
  emit({ type: 'final-done', content: r.content, model: r.modelId, provider: r.provider });
  return { question, answer: r.content, models: [{ step: dept.id, model: r.modelId, provider: r.provider }] };
}

/** Plain chat with no persona. */
async function askPlain({ router, question, history = [], model = 'auto', system, emit, signal }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...historyMessages(history), { role: 'user', content: question });
  const r = await router.complete(
    { model, messages },
    {
      signal,
      source: 'chat',
      onChunk: (chunk) => {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) emit({ type: 'final-delta', delta: delta.content });
      },
    }
  );
  emit({ type: 'final-done', content: r.content, model: r.modelId, provider: r.provider });
  return { question, answer: r.content, models: [{ step: 'chat', model: r.modelId, provider: r.provider }] };
}

module.exports = { askCompany, askDepartment, askPlain, parseRouting, routingPrompt };

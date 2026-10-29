'use strict';

/* global Markdown, crew */

const state = {
  providers: [],
  departments: [],
  settings: {},
  connections: [],
  conversations: [],
  api: {},
  router: null,
  view: 'chat',
  conv: null, // full conversation currently open (null = new)
  mode: 'company',
  deptId: null,
  specialty: null,
  run: null, // live run UI state
  openConns: new Set(),
  modelFilters: {},
};

// ---------- tiny DOM helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with Markdown.render output
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}

function copy(text, what = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast(what, 'good'));
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

function fmtNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function dept(id) {
  return state.departments.find((d) => d.id === id);
}

function openModal(build) {
  const box = $('#modal-box');
  box.innerHTML = '';
  build(box, closeModal);
  $('#modal').classList.remove('hidden');
  const first = box.querySelector('input, select, textarea');
  if (first) first.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
}
$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ---------- navigation ----------

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'keys') renderKeys();
  if (view === 'router') refreshRouter();
  if (view === 'api') renderApi();
  if (view === 'org') renderOrg();
  if (view === 'chat') {
    if (!state.conv && !state.run) renderMessages();
    $('#input').focus();
  }
}
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function enabledModelCount() {
  return state.connections.filter((c) => c.enabled).reduce((n, c) => n + c.models.filter((m) => m.enabled).length, 0);
}

function renderNavBadges() {
  const n = enabledModelCount();
  $('#nav-models-count').textContent = n ? String(n) : '';
  $('#nav-api-dot').classList.toggle('on', !!state.api.running);
  const providers = new Set(state.connections.filter((c) => c.enabled).map((c) => c.providerId)).size;
  $('#brand-sub').textContent = n ? `${n} models · ${providers} provider${providers === 1 ? '' : 's'}` : 'your free AI company';
}

// ---------- model picker ----------

function renderModelSelect() {
  const sel = $('#model-select');
  const current = state.settings.defaultModel || 'auto';
  sel.innerHTML = '';
  sel.append(h('option', { value: 'auto' }, '⚡ Auto — best available, with failover'));
  sel.append(h('option', { value: 'fast' }, '🏎 Fast — quickest providers first'));
  for (const c of state.connections) {
    if (!c.enabled) continue;
    const models = c.models.filter((m) => m.enabled);
    if (!models.length) continue;
    const g = h('optgroup', { label: c.name });
    for (const m of models) g.append(h('option', { value: `${c.id}/${m.id}` }, m.id));
    sel.append(g);
  }
  sel.value = [...sel.options].some((o) => o.value === current) ? current : 'auto';
}
$('#model-select').addEventListener('change', async (e) => {
  const r = await crew.updateSettings({ defaultModel: e.target.value });
  state.settings = r.settings;
});
$('#max-depts').addEventListener('change', async (e) => {
  const r = await crew.updateSettings({ maxDepartments: Number(e.target.value) });
  state.settings = r.settings;
});
$('#reviewer-toggle').addEventListener('change', async (e) => {
  const r = await crew.updateSettings({ reviewer: e.target.checked });
  state.settings = r.settings;
});

// ---------- conversations sidebar ----------

function renderConvList() {
  const list = $('#conv-list');
  const q = $('#conv-search').value.trim().toLowerCase();
  list.innerHTML = '';
  const convs = state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q));
  if (!convs.length) {
    list.append(h('div', { class: 'empty-side' }, q ? 'No matches.' : 'No conversations yet.'));
    return;
  }
  for (const c of convs) {
    const icon = c.mode === 'company' ? '👑' : c.mode === 'department' ? (dept(c.deptId) || {}).icon || '🏷️' : '💭';
    list.append(
      h(
        'div',
        { class: `conv${state.conv && state.conv.id === c.id ? ' active' : ''}`, onclick: () => openConversation(c.id), title: c.title },
        h('div', { class: 'conv-title' }, `${icon} ${c.title}`),
        h('div', { class: 'conv-meta' }, `${ago(c.updatedAt)} · ${c.turnCount} message${c.turnCount === 1 ? '' : 's'}`)
      )
    );
  }
}
$('#conv-search').addEventListener('input', renderConvList);
$('#new-chat').addEventListener('click', () => newConversation());

async function openConversation(id) {
  if (state.run) return toast('Wait for the current answer to finish, or stop it.', 'bad');
  const conv = await crew.getConversation(id);
  if (!conv) return;
  state.conv = conv;
  state.mode = conv.mode;
  state.deptId = conv.deptId;
  state.specialty = conv.specialty;
  setView('chat');
  renderChatChrome();
  renderMessages();
  renderConvList();
}

function newConversation(mode = 'company', deptId = null, specialty = null) {
  if (state.run) return toast('Wait for the current answer to finish, or stop it.', 'bad');
  state.conv = null;
  state.mode = mode;
  state.deptId = deptId || state.deptId || state.departments[0].id;
  state.specialty = specialty;
  setView('chat');
  renderChatChrome();
  renderMessages();
  renderConvList();
}

// ---------- chat chrome ----------

function modeLabel() {
  if (state.mode === 'company') return '👑 Whole company · the CEO routes your question to the right departments';
  if (state.mode === 'department') {
    const d = dept(state.deptId);
    return `${d.icon} ${d.name}${state.specialty ? ` · ${state.specialty}` : ` · ${d.lead}`}`;
  }
  return '💭 Plain chat · no persona';
}

function renderChatChrome() {
  const locked = !!(state.conv && state.conv.turns.length);
  $('#chat-title').textContent = state.conv ? state.conv.title : 'New conversation';
  $('#chat-mode').textContent = modeLabel();
  $('#company-tools').classList.toggle('hidden', state.mode !== 'company');
  $('#max-depts').value = String(state.settings.maxDepartments || 3);
  $('#reviewer-toggle').checked = !!state.settings.reviewer;
  $('#export-conv').disabled = !state.conv;
  $('#delete-conv').disabled = !state.conv;
  document.querySelectorAll('.mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.disabled = locked && b.dataset.mode !== state.mode;
  });
  const ds = $('#dept-select');
  ds.classList.toggle('hidden', state.mode !== 'department');
  ds.disabled = locked;
  if (!ds.options.length) {
    for (const d of state.departments) ds.append(h('option', { value: d.id }, `${d.icon} ${d.name}`));
  }
  ds.value = state.deptId || state.departments[0].id;
  $('#input').placeholder =
    state.mode === 'company'
      ? 'Ask your company anything… (Enter to send, Shift+Enter for a new line)'
      : state.mode === 'department'
        ? `Ask ${dept(state.deptId).name}…`
        : 'Message…';
}

document.querySelectorAll('.mode').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.disabled) return;
    state.mode = b.dataset.mode;
    state.specialty = null;
    renderChatChrome();
    if (!state.conv) renderMessages();
  })
);
$('#dept-select').addEventListener('change', (e) => {
  state.deptId = e.target.value;
  state.specialty = null;
  renderChatChrome();
});

$('#export-conv').addEventListener('click', async () => {
  if (state.conv && (await crew.exportConversation(state.conv.id))) toast('Exported', 'good');
});
$('#delete-conv').addEventListener('click', () => {
  if (!state.conv || state.run) return;
  const conv = state.conv;
  openModal((box, close) => {
    box.append(
      h('h3', {}, 'Delete conversation?'),
      h('p', {}, `"${conv.title}" will be removed permanently.`),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              state.conversations = await crew.deleteConversation(conv.id);
              close();
              newConversation(state.mode);
            },
          },
          'Delete'
        )
      )
    );
  });
});

// ---------- messages ----------

function scrollToBottom(force = false) {
  const m = $('#messages');
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}

const EXAMPLES = [
  ['Company', 'I want to launch a paid Discord bot for gamers. Is it worth it, how should I price it, and what are the risks?'],
  ['Company', 'Plan the first 30 days of turning my side project into a small business.'],
  ['Technology', 'My Electron app uses 600 MB of RAM. Walk me through finding out why.'],
  ['Security', 'Threat-model a desktop app that stores users\' API keys locally.'],
  ['Marketing', 'Write 3 punchy launch tweets for a free AI router app.'],
  ['Finance', 'If I charge $4/month and 2% of 5,000 free users convert, what\'s my monthly revenue after Stripe fees?'],
];

function renderWelcome() {
  const box = h('div', { class: 'welcome' });
  box.append(h('div', { class: 'logo big-logo' }, 'e'));
  if (!state.connections.length) {
    box.append(
      h('h1', {}, 'Welcome to ello Crew'),
      h('p', {}, 'Your own AI company, powered by free AI tiers. Add a few free API keys; ello Crew pools them and switches to another provider when one hits its limit, so you rarely run out.'),
      h(
        'div',
        { class: 'steps' },
        h('div', { class: 'step' }, h('div', { class: 'n' }, '1'), h('div', {}, h('b', {}, 'Get a free key'), h('div', { class: 'muted small' }, 'Groq, Google AI Studio, Cerebras and OpenRouter take a minute each. No card needed.'))),
        h('div', { class: 'step' }, h('div', { class: 'n' }, '2'), h('div', {}, h('b', {}, 'Paste it on the Keys page'), h('div', { class: 'muted small' }, 'Keys are encrypted with Windows\' own protection (DPAPI) and never leave this PC except to that provider.'))),
        h('div', { class: 'step' }, h('div', { class: 'n' }, '3'), h('div', {}, h('b', {}, 'Ask the company'), h('div', { class: 'muted small' }, 'The CEO sends your question to the right departments and sums up their answers.')))
      ),
      h(
        'div',
        { style: { marginTop: '22px', display: 'flex', gap: '10px', justifyContent: 'center' } },
        h('button', { class: 'btn primary', onclick: () => setView('keys') }, 'Add your first key →'),
        h('button', { class: 'btn', onclick: quickstart }, 'Start without keys')
      ),
      h('p', { class: 'muted small', style: { marginTop: '12px' } }, 'No-key mode uses LLM7 and Kilo Gateway\'s free models. They are slower and more limited, and Kilo may log prompts. Add real keys any time for better models.')
    );
    return box;
  }
  if (state.mode === 'department') {
    const d = dept(state.deptId);
    box.querySelector('.logo').textContent = d.icon;
    box.append(h('h1', {}, state.specialty || d.name), h('p', {}, d.summary));
    const specs = h('div', { class: 'routing', style: { justifyContent: 'center' } });
    for (const s of d.specialties) {
      specs.append(
        h(
          'span',
          {
            class: 'chip clickable',
            style: state.specialty === s ? { borderColor: 'var(--accent)' } : {},
            onclick: () => {
              state.specialty = state.specialty === s ? null : s;
              renderChatChrome();
              renderMessages();
            },
          },
          s
        )
      );
    }
    box.append(h('div', { class: 'muted small' }, 'Optional: talk to a specialist'), specs);
    return box;
  }
  box.append(
    h('h1', {}, state.mode === 'company' ? 'What should the company work on?' : 'Ask anything'),
    h(
      'p',
      {},
      state.mode === 'company'
        ? 'Ask a question and the CEO picks which departments should answer: Technology, Security, Finance, Marketing and more. Each one answers from its own angle, then the CEO combines them into one recommendation.'
        : 'A straight chat with the best free model available, with automatic failover.'
    )
  );
  const ex = h('div', { class: 'examples' });
  for (const [t, q] of EXAMPLES) {
    ex.append(
      h(
        'div',
        {
          class: 'example',
          onclick: () => {
            if (t !== 'Company' && state.mode === 'company') {
              const d = state.departments.find((x) => x.name.startsWith(t));
              if (d) {
                state.mode = 'department';
                state.deptId = d.id;
                renderChatChrome();
              }
            }
            $('#input').value = q;
            autosize();
            $('#input').focus();
          },
        },
        h('div', { class: 't' }, t === 'Company' ? '👑 Whole company' : `${(state.departments.find((x) => x.name.startsWith(t)) || {}).icon || ''} ${t}`),
        q
      )
    );
  }
  box.append(ex);
  return box;
}

async function quickstart(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  const r = await crew.quickstart();
  state.connections = r.connections;
  for (const x of r.results) toast(`${x.name}: ${x.message}`, x.ok ? 'good' : 'bad');
  afterConnectionsChange();
  if (enabledModelCount()) renderMessages();
  else {
    btn.disabled = false;
    btn.textContent = 'Start without keys';
  }
}

function renderMessages() {
  const m = $('#messages');
  m.innerHTML = '';
  if (!state.conv || !state.conv.turns.length) {
    m.append(renderWelcome());
    return;
  }
  for (const t of state.conv.turns) m.append(renderSavedTurn(t, state.conv));
  scrollToBottom(true);
}

function modelTag(model, provider) {
  if (!model) return null;
  return h('span', { class: 'model-tag', title: `${provider || ''} · ${model}` }, `${provider ? `${provider} · ` : ''}${model}`);
}

function deptCard(d, { brief, content, model, provider, error, open = false, streaming = false }) {
  const info = dept(d) || { name: d, icon: '•', color: '#888' };
  const body = h('div', { class: `dept-body md${streaming ? ' cursor' : ''}`, html: error ? '' : Markdown.render(content || '') });
  if (error) body.textContent = error;
  const tagSlot = h('span', { class: 'tag-slot' }, modelTag(model, provider));
  const head = h(
    'div',
    { class: 'dept-head' },
    h('span', { class: 'caret' }, '▸'),
    h('span', {}, info.icon),
    h('span', { class: 'name' }, info.name),
    h('span', { class: 'brief' }, brief || info.summary),
    streaming ? h('span', { class: 'spinner' }) : null,
    tagSlot
  );
  const card = h('div', { class: `dept-card${open ? ' open' : ''}${error ? ' error' : ''}`, style: { '--c': info.color } }, head, body);
  head.addEventListener('click', () => card.classList.toggle('open'));
  return { card, body, head, tagSlot };
}

function answerCard({ who, icon, content, streaming = false }) {
  const body = h('div', { class: `md${streaming ? ' cursor' : ''}`, html: Markdown.render(content || '') });
  const foot = h('div', { class: 'answer-foot' });
  const card = h('div', { class: 'answer' }, h('div', { class: 'answer-head' }, h('span', {}, icon), h('span', { class: 'who' }, who)), body, foot);
  return { card, body, foot };
}

function addAnswerFooter(foot, models, content, ms) {
  foot.innerHTML = '';
  const seen = new Set();
  for (const m of models || []) {
    const k = `${m.provider}·${m.model}`;
    if (!m.model || seen.has(k)) continue;
    seen.add(k);
    foot.append(modelTag(m.model, m.provider));
  }
  if (ms) foot.append(h('span', { class: 'muted small' }, `${(ms / 1000).toFixed(1)}s`));
  foot.append(h('button', { class: 'btn small', onclick: () => copy(content, 'Answer copied') }, 'Copy'));
}

function routingRow(routing) {
  const row = h('div', { class: 'routing' }, h('span', { class: 'label' }, routing.method === 'manual' ? 'You picked' : routing.method === 'keywords' ? 'Routed by keywords to' : 'CEO routed to'));
  for (const p of routing.departments) {
    const d = dept(p.id);
    row.append(h('span', { class: 'chip', title: p.brief || d.summary }, h('span', { class: 'swatch', style: { background: d.color } }), `${d.icon} ${d.name}`));
  }
  if (routing.reason) row.append(h('span', { class: 'muted' }, `· ${routing.reason}`));
  return row;
}

function answerIdentity(conv, turn) {
  if (conv.mode === 'department') {
    const d = dept(conv.deptId);
    return { who: conv.specialty || `${d.name} (${d.lead})`, icon: d.icon };
  }
  if (conv.mode === 'plain') return { who: 'Assistant', icon: '💭' };
  const answered = (turn.departments || []).filter((d) => d.content);
  if (answered.length === 1 && !turn.review) {
    const d = dept(answered[0].id);
    return { who: `${d.name} (${d.lead})`, icon: d.icon };
  }
  return { who: 'CEO · final answer', icon: '👑' };
}

function renderSavedTurn(t, conv) {
  const wrap = h('div', { class: 'turn' });
  wrap.append(h('div', { class: 'q' }, h('div', { class: 'q-bubble' }, t.question)));
  if (t.routing) wrap.append(routingRow(t.routing));
  const answered = (t.departments || []).filter((d) => d.content || d.error);
  const single = answered.length === 1 && !t.review;
  if (answered.length && !single) {
    const list = h('div', { class: 'depts' });
    for (const d of answered) list.append(deptCard(d.id, { brief: d.brief, content: d.content, model: d.model, provider: d.provider, error: d.error }).card);
    if (t.review) {
      const r = deptCard('executive', { brief: 'Independent review of the answers above', content: t.review.content, model: t.review.model, provider: t.review.provider });
      r.head.querySelector('.name').textContent = 'Reviewer';
      r.head.children[1].textContent = '🔍';
      r.card.style.setProperty('--c', '#9aa3b5');
      list.append(r.card);
    }
    wrap.append(list);
  }
  if (t.answer) {
    const id = answerIdentity(conv, t);
    const a = answerCard({ ...id, content: t.answer });
    addAnswerFooter(a.foot, t.models, t.answer, t.ms);
    wrap.append(a.card);
  } else if (t.error) {
    wrap.append(h('div', { class: 'error-box' }, t.error));
  }
  return wrap;
}

// ---------- live run ----------

let renderQueued = false;
const dirty = new Set();
function queueRender(target) {
  dirty.add(target);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    for (const t of dirty) t.el.innerHTML = Markdown.render(t.text);
    dirty.clear();
    scrollToBottom();
  });
}

function stageText(stage) {
  return { routing: 'The CEO is deciding who should answer…', review: 'The reviewer is checking the answers…', synthesis: 'The CEO is writing the final answer…' }[stage] || 'Working…';
}

function startLiveTurn(question, mode) {
  const wrap = h('div', { class: 'turn' });
  wrap.append(h('div', { class: 'q' }, h('div', { class: 'q-bubble' }, question)));
  const stage = h('div', { class: 'stage' }, h('span', { class: 'spinner' }), h('span', {}, mode === 'company' ? stageText('routing') : 'Thinking…'));
  wrap.append(stage);
  const m = $('#messages');
  if (m.querySelector('.welcome')) m.innerHTML = '';
  m.append(wrap);
  scrollToBottom(true);
  return { wrap, stage, depts: {}, deptList: null, single: false, final: null, review: null };
}

function setStage(run, text) {
  if (!text) {
    run.stage.classList.add('hidden');
    return;
  }
  run.stage.classList.remove('hidden');
  run.stage.lastChild.textContent = text;
  run.wrap.append(run.stage); // keep it last
}

function ensureFinal(run, identity) {
  if (run.final) return run.final;
  const a = answerCard({ ...identity, content: '', streaming: true });
  run.final = { ...a, text: '', el: a.body };
  run.wrap.insertBefore(a.card, run.stage);
  return run.final;
}

function handleChatEvent(e) {
  const run = state.run;
  if (!run || e.runId !== run.runId) return;

  switch (e.type) {
    case 'stage':
      setStage(run, stageText(e.stage));
      if (e.stage === 'synthesis') {
        for (const d of Object.values(run.depts)) d.card.classList.remove('open');
      }
      break;

    case 'routing': {
      run.wrap.insertBefore(routingRow(e.routing), run.stage);
      run.single = e.routing.departments.length === 1 && !run.reviewer;
      if (!run.single) {
        run.deptList = h('div', { class: 'depts' });
        run.wrap.insertBefore(run.deptList, run.stage);
      }
      setStage(run, run.single ? null : `${e.routing.departments.length} departments are working on it…`);
      break;
    }

    case 'dept-start': {
      if (run.single) {
        const d = dept(e.id);
        const f = ensureFinal(run, { who: `${d.name} (${d.lead})`, icon: d.icon });
        f.deptId = e.id;
      } else {
        const c = deptCard(e.id, { brief: e.brief, content: '', open: true, streaming: true });
        run.depts[e.id] = { ...c, text: '', el: c.body };
        run.deptList.append(c.card);
      }
      break;
    }

    case 'dept-delta': {
      const t = run.single ? run.final : run.depts[e.id];
      if (!t) break;
      t.text += e.delta;
      queueRender(t);
      break;
    }

    case 'dept-done': {
      if (run.single) break;
      const t = run.depts[e.id];
      if (!t) break;
      t.text = e.content;
      t.el.classList.remove('cursor');
      queueRender(t);
      const sp = t.head.querySelector('.spinner');
      if (sp) sp.remove();
      t.tagSlot.append(modelTag(e.model, e.provider));
      break;
    }

    case 'dept-error': {
      if (run.single) {
        setStage(run, null);
        break;
      }
      const t = run.depts[e.id];
      if (!t) break;
      t.card.classList.add('error');
      t.el.classList.remove('cursor', 'md');
      t.el.textContent = e.error;
      const sp = t.head.querySelector('.spinner');
      if (sp) sp.remove();
      break;
    }

    case 'review-delta': {
      if (!run.review) {
        const c = deptCard('executive', { brief: 'Independent review of the answers above', content: '', open: true, streaming: true });
        c.head.querySelector('.name').textContent = 'Reviewer';
        c.head.children[1].textContent = '🔍';
        c.card.style.setProperty('--c', '#9aa3b5');
        run.review = { ...c, text: '', el: c.body };
        (run.deptList || run.wrap).append(c.card);
      }
      run.review.text += e.delta;
      queueRender(run.review);
      break;
    }

    case 'review-done':
      if (run.review) {
        run.review.el.classList.remove('cursor');
        const sp = run.review.head.querySelector('.spinner');
        if (sp) sp.remove();
        run.review.tagSlot.append(modelTag(e.model, e.provider));
      }
      break;

    case 'final-delta': {
      const identity =
        run.mode === 'department'
          ? { who: state.specialty || `${dept(state.deptId).name} (${dept(state.deptId).lead})`, icon: dept(state.deptId).icon }
          : run.mode === 'plain'
            ? { who: 'Assistant', icon: '💭' }
            : { who: 'CEO · final answer', icon: '👑' };
      const f = ensureFinal(run, identity);
      setStage(run, null);
      f.text += e.delta;
      queueRender(f);
      break;
    }

    case 'final-done': {
      const f = run.final || ensureFinal(run, { who: 'Answer', icon: '💬' });
      f.text = e.content;
      f.el.classList.remove('cursor');
      queueRender(f);
      setStage(run, null);
      break;
    }

    case 'warning':
      run.wrap.insertBefore(h('div', { class: 'warn-line' }, `⚠ ${e.message}`), run.stage);
      break;

    case 'error': {
      setStage(run, null);
      if (run.final) run.final.el.classList.remove('cursor');
      const box = h('div', { class: 'error-box' }, e.error);
      const tried = (e.attempts || []).filter((a) => a.error || a.skipped);
      if (tried.length) {
        box.append(h('ul', {}, tried.map((a) => h('li', {}, `${a.ref}: ${a.error || a.skipped}`))));
      }
      if (/No models available/.test(e.error)) box.append(h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn small', onclick: () => setView('keys') }, 'Open Keys & models')));
      run.wrap.append(box);
      scrollToBottom();
      break;
    }

    case 'turn-saved': {
      state.conversations = e.conversations;
      endRun();
      crew.getConversation(e.conversationId).then((conv) => {
        state.conv = conv;
        // Replace the live view with the canonical saved rendering (adds model tags, copy, timing).
        if (e.turn.answer) run.wrap.replaceWith(renderSavedTurn(e.turn, conv));
        renderConvList();
        renderChatChrome();
      });
      break;
    }
    default:
  }
}

function endRun() {
  state.run = null;
  $('#send-btn').classList.remove('hidden');
  $('#stop-btn').classList.add('hidden');
  $('#input').focus();
}

async function sendMessage() {
  const input = $('#input');
  const question = input.value.trim();
  if (!question || state.run) return;
  if (!enabledModelCount()) {
    toast('Add a provider key first.', 'bad');
    setView('keys');
    return;
  }
  input.value = '';
  autosize();
  const mode = state.conv ? state.conv.mode : state.mode;
  const run = startLiveTurn(question, mode);
  run.mode = mode;
  run.reviewer = mode === 'company' && !!state.settings.reviewer;
  state.run = run;
  $('#send-btn').classList.add('hidden');
  $('#stop-btn').classList.remove('hidden');
  try {
    const r = await crew.send({
      conversationId: state.conv ? state.conv.id : null,
      mode,
      deptId: state.deptId,
      specialty: state.specialty,
      model: state.settings.defaultModel || 'auto',
      question,
      maxDepartments: state.settings.maxDepartments,
      reviewer: state.settings.reviewer,
    });
    run.runId = r.runId;
    if (!state.conv) {
      const conv = await crew.getConversation(r.conversationId);
      // turn-saved may already have loaded a newer copy
      if (!state.conv) state.conv = conv;
      renderChatChrome();
    }
  } catch (err) {
    run.wrap.append(h('div', { class: 'error-box' }, err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
    setStage(run, null);
    endRun();
  }
}

// Events can arrive before crew.send resolves with the runId; buffer them.
const pendingEvents = [];
crew.onChatEvent((e) => {
  if (state.run && !state.run.runId) {
    pendingEvents.push(e);
    const wait = () => {
      if (!state.run) return;
      if (!state.run.runId) return setTimeout(wait, 10);
      while (pendingEvents.length) handleChatEvent(pendingEvents.shift());
    };
    if (pendingEvents.length === 1) wait();
    return;
  }
  handleChatEvent(e);
});

$('#send-btn').addEventListener('click', sendMessage);
$('#stop-btn').addEventListener('click', () => {
  if (state.run && state.run.runId) crew.cancel(state.run.runId);
});
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(220, t.scrollHeight)}px`;
}
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
$('#messages').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-code');
  if (btn) copy(btn.closest('.code').querySelector('code').textContent, 'Code copied');
});

// ---------- org chart ----------

function renderOrg() {
  const ceo = dept('executive');
  const ceoCard = $('#ceo-card');
  ceoCard.innerHTML = '';
  ceoCard.append(
    h('div', { class: 'big' }, '👑'),
    h('div', {}, h('h3', {}, 'Chief Executive'), h('p', {}, 'Reads every question, picks the departments that should answer, briefs them, and combines their answers into one recommendation.')),
    h('button', { class: 'btn primary', onclick: () => newConversation('company') }, 'Ask the company')
  );
  const grid = $('#org-grid');
  grid.innerHTML = '';
  for (const d of state.departments) {
    if (d.id === ceo.id) continue;
    grid.append(
      h(
        'div',
        { class: 'dept-tile', style: { '--c': d.color } },
        h('div', { class: 'top' }, h('span', { class: 'emoji' }, d.icon), h('div', {}, h('div', { class: 't' }, d.name), h('div', { class: 'lead' }, d.lead))),
        h('div', { class: 'sum' }, d.summary),
        h('div', { class: 'specs' }, d.specialties.map((s) => h('span', { class: 'chip clickable', title: `Talk to the ${s} specialist`, onclick: () => newConversation('department', d.id, s) }, s))),
        h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => newConversation('department', d.id) }, `Talk to ${d.lead}`))
      )
    );
  }
  const execTile = h(
    'div',
    { class: 'dept-tile', style: { '--c': ceo.color } },
    h('div', { class: 'top' }, h('span', { class: 'emoji' }, ceo.icon), h('div', {}, h('div', { class: 't' }, ceo.name), h('div', { class: 'lead' }, 'Advisors to the CEO'))),
    h('div', { class: 'sum' }, ceo.summary),
    h('div', { class: 'specs' }, ceo.specialties.map((s) => h('span', { class: 'chip clickable', onclick: () => newConversation('department', ceo.id, s) }, s))),
    h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => newConversation('department', ceo.id) }, 'Talk 1:1 with the CEO'))
  );
  grid.prepend(execTile);
}

// ---------- keys & models ----------

function renderKeys() {
  const enc = $('#enc-notice');
  enc.className = state.encryption ? 'notice' : 'notice warn';
  enc.textContent = state.encryption
    ? '🔒 Keys are encrypted with your Windows account (DPAPI) and only sent to the provider they belong to.'
    : '⚠ OS encryption is unavailable on this system, so keys are stored obfuscated but not encrypted.';
  renderConnections();
  renderProviders();
}

function renderConnections() {
  const box = $('#connections');
  box.innerHTML = '';
  if (!state.connections.length) {
    box.append(h('div', { class: 'card muted' }, 'No keys yet. Pick a provider below. Groq, Google Gemini, Cerebras and OpenRouter are the best free starting points.'));
    return;
  }
  const pinned = new Set(state.settings.pinned || []);
  for (const c of state.connections) {
    const open = state.openConns.has(c.id);
    const provider = state.providers.find((p) => p.id === c.providerId) || {};
    const enabledCount = c.models.filter((m) => m.enabled).length;
    const ok = c.lastCheck ? c.lastCheck.ok : null;
    const el = h('div', { class: `conn${open ? ' open' : ''}${c.enabled ? '' : ' disabled'}` });

    const toggle = h('label', { class: 'toggle', title: c.enabled ? 'Enabled' : 'Disabled' }, h('input', { type: 'checkbox', checked: c.enabled, onchange: async (e) => {
      state.connections = await crew.updateConnection({ id: c.id, patch: { enabled: e.target.checked } });
      afterConnectionsChange();
    } }), h('span', { class: 'track' }));

    const btnTest = h('button', { class: 'btn small', onclick: async () => {
      btnTest.disabled = true;
      btnTest.textContent = 'Testing…';
      const r = await crew.testConnection({ id: c.id });
      state.connections = r.connections;
      toast(r.message, r.ok ? 'good' : 'bad');
      afterConnectionsChange();
    } }, 'Test');
    const btnRefresh = h('button', { class: 'btn small', title: 'Fetch the current model list', onclick: async () => {
      btnRefresh.disabled = true;
      btnRefresh.textContent = 'Refreshing…';
      state.connections = await crew.refreshConnection(c.id);
      afterConnectionsChange();
    } }, 'Refresh models');
    const btnRemove = h('button', { class: 'btn small danger', onclick: () => confirmRemove(c) }, 'Remove');

    el.append(
      h(
        'div',
        { class: 'conn-head' },
        h('span', { class: `status-dot${ok === true ? ' ok' : ok === false ? ' bad' : ''}` }),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'cname' }, c.name, provider.local ? h('span', { class: 'tag green', style: { marginLeft: '8px' } }, 'local') : null),
          h('div', { class: 'meta' }, `${c.keyPreview ? `key ${c.keyPreview} · ` : 'no key · '}${enabledCount}/${c.models.length} models on${c.providerId === 'custom' || provider.local ? ` · ${c.baseUrl}` : ''}`)
        ),
        h('button', { class: 'btn small', onclick: () => {
          if (state.openConns.has(c.id)) state.openConns.delete(c.id);
          else state.openConns.add(c.id);
          renderConnections();
        } }, open ? 'Hide models' : 'Models'),
        btnTest,
        btnRefresh,
        btnRemove,
        toggle
      )
    );
    if (c.lastCheck) el.append(h('div', { class: `conn-check${c.lastCheck.ok ? '' : ' bad'}` }, `${c.lastCheck.ok ? '✓' : '✕'} ${c.lastCheck.message} · ${ago(c.lastCheck.time)}`));

    if (open) {
      const filter = state.modelFilters[c.id] || '';
      const list = h('div', { class: 'model-list' });
      const fillList = (q) => {
        list.innerHTML = '';
        for (const m of c.models.filter((x) => !q || x.id.toLowerCase().includes(q.toLowerCase()))) {
          const ref = `${c.id}/${m.id}`;
          list.append(
            h(
              'div',
              { class: 'model-row' },
              h('button', { class: `star${pinned.has(ref) ? ' on' : ''}`, title: pinned.has(ref) ? 'Unpin' : 'Pin: try this model first in Auto', onclick: () => togglePin(ref) }, pinned.has(ref) ? '★' : '☆'),
              h('label', { title: m.id }, h('input', { type: 'checkbox', checked: m.enabled, onchange: async (e) => {
                state.connections = await crew.toggleModel({ id: c.id, modelId: m.id, enabled: e.target.checked });
                afterConnectionsChange(false);
              } }), m.id)
            )
          );
        }
      };
      fillList(filter);
      const limitInput = (key, placeholder) =>
        h('input', { class: 'input', type: 'number', min: '0', placeholder, value: c[key] ?? '', title: `Override ${key.toUpperCase()} (empty = provider default, 0 = unlimited)`, onchange: async (e) => {
          state.connections = await crew.updateConnection({ id: c.id, patch: { [key]: e.target.value } });
          toast('Limit saved', 'good');
        } });
      el.append(
        h(
          'div',
          { class: 'conn-models' },
          h(
            'div',
            { class: 'models-toolbar' },
            h('input', { class: 'input', placeholder: 'Filter models…', value: filter, oninput: (e) => {
              state.modelFilters[c.id] = e.target.value;
              fillList(e.target.value);
            } }),
            h('button', { class: 'btn small', onclick: async () => {
              state.connections = await crew.toggleModel({ id: c.id, modelId: '*', enabled: true });
              afterConnectionsChange();
            } }, 'Enable all'),
            h('button', { class: 'btn small', onclick: async () => {
              state.connections = await crew.toggleModel({ id: c.id, modelId: '*', enabled: false });
              afterConnectionsChange();
            } }, 'Disable all'),
            h('span', { style: { flex: 1 } }),
            h('span', { class: 'limits' }, 'Per model: RPM', limitInput('rpm', String((provider.limits || {}).rpm ?? '')), 'RPD', limitInput('rpd', String((provider.limits || {}).rpd ?? '')))
          ),
          list
        )
      );
    }
    box.append(el);
  }
}

function confirmRemove(c) {
  openModal((box, close) => {
    box.append(
      h('h3', {}, `Remove ${c.name}?`),
      h('p', {}, 'The key is deleted from this PC. You can add it again any time.'),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const r = await crew.removeConnection(c.id);
          state.connections = r.connections;
          state.settings = r.settings;
          close();
          afterConnectionsChange();
        } }, 'Remove')
      )
    );
  });
}

async function togglePin(ref) {
  const pinned = [...(state.settings.pinned || [])];
  const i = pinned.indexOf(ref);
  if (i >= 0) pinned.splice(i, 1);
  else pinned.push(ref);
  const r = await crew.updateSettings({ pinned });
  state.settings = r.settings;
  if (state.view === 'keys') renderConnections();
  if (state.view === 'router') refreshRouter();
}

function afterConnectionsChange(rerender = true) {
  if (rerender && state.view === 'keys') renderKeys();
  renderModelSelect();
  renderNavBadges();
}

function renderProviders() {
  const grid = $('#provider-grid');
  grid.innerHTML = '';
  const have = new Set(state.connections.map((c) => c.providerId));
  for (const p of state.providers) {
    grid.append(
      h(
        'div',
        { class: 'provider' },
        h(
          'div',
          { class: 'pname' },
          p.name,
          p.local ? h('span', { class: 'tag green' }, 'local') : p.keyOptional && !p.custom ? h('span', { class: 'tag' }, 'no key needed') : null,
          have.has(p.id) ? h('span', { class: 'tag green' }, 'added') : null
        ),
        h('div', { class: 'pnote' }, p.note),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn small primary', onclick: () => addProviderModal(p) }, have.has(p.id) ? 'Add another' : p.keyOptional ? 'Connect' : 'Add key'),
          p.signup ? h('button', { class: 'btn small', onclick: () => crew.openExternal(p.signup) }, p.local ? 'Download ↗' : p.keyOptional ? 'Website ↗' : 'Get a free key ↗') : null
        )
      )
    );
  }
}

function addProviderModal(p) {
  openModal((box, close) => {
    const needsUrl = p.custom || p.local;
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: p.keyOptional ? 'optional' : 'paste your API key', autocomplete: 'off', spellcheck: 'false' });
    const urlInput = needsUrl ? h('input', { class: 'input', value: p.baseUrl || '', placeholder: 'http://127.0.0.1:8080/v1' }) : null;
    const nameInput = p.custom ? h('input', { class: 'input', placeholder: 'e.g. My vLLM box' }) : null;
    const err = h('div', { class: 'modal-error' });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, p.keyOptional ? 'Connect' : 'Add key');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          submit.textContent = 'Checking…';
          try {
            const r = await crew.addConnection({ providerId: p.id, apiKey: keyInput.value, baseUrl: urlInput ? urlInput.value : undefined, name: nameInput ? nameInput.value : undefined });
            state.connections = r.connections;
            state.openConns.add(r.id);
            close();
            const c = state.connections.find((x) => x.id === r.id);
            toast(r.warning || `${c.name} connected: ${c.models.length} models`, r.warning ? '' : 'good');
            afterConnectionsChange();
          } catch (ex) {
            err.textContent = ex.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            submit.disabled = false;
            submit.textContent = p.keyOptional ? 'Connect' : 'Add key';
          }
        },
      },
      h('h3', {}, p.custom ? 'Custom OpenAI-compatible endpoint' : `Connect ${p.name}`),
      h('p', {}, p.note, p.signup && !p.local ? [' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); crew.openExternal(p.signup); } }, 'Get a key ↗')] : null),
      nameInput ? h('label', { class: 'field' }, 'Name', nameInput) : null,
      urlInput ? h('label', { class: 'field' }, 'Base URL (ends in /v1)', urlInput) : null,
      h('label', { class: 'field' }, `API key${p.keyOptional ? ' (optional)' : ''}`, keyInput),
      err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), submit)
    );
    box.append(form);
  });
}

// ---------- router ----------

let routerTimer = null;
async function refreshRouter() {
  state.router = await crew.routerStatus();
  renderRouter();
  clearInterval(routerTimer);
  routerTimer = setInterval(() => {
    if (state.view !== 'router') return clearInterval(routerTimer);
    crew.routerStatus().then((s) => {
      state.router = s;
      renderRouter();
    });
  }, 3000);
}

function renderRouter() {
  const s = state.router;
  if (!s) return;
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const u = Object.values(s.usage[today] || {});
  const sum = (k) => u.reduce((n, x) => n + (x[k] || 0), 0);
  const cooling = s.models.filter((m) => m.cooldownUntil).length;
  const stats = $('#router-stats');
  stats.innerHTML = '';
  const stat = (v, k) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
  stats.append(
    stat(fmtNum(sum('requests')), 'requests today'),
    stat(fmtNum(sum('promptTokens') + sum('completionTokens')), 'tokens today'),
    stat(fmtNum(sum('failures')), 'failovers today'),
    stat(`${s.models.length - cooling}/${s.models.length}`, 'models ready'),
    stat(String(cooling), 'cooling down')
  );

  // pinned order
  const pl = $('#pinned-list');
  pl.innerHTML = '';
  const pinned = state.settings.pinned || [];
  if (!pinned.length) pl.append(h('div', { class: 'muted small' }, 'Nothing pinned. Auto ranks models by size and family.'));
  else {
    const wrap = h('div', { class: 'pinned' });
    pinned.forEach((ref, i) => {
      const move = async (d) => {
        const next = [...pinned];
        const j = i + d;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        const r = await crew.updateSettings({ pinned: next });
        state.settings = r.settings;
        renderRouter();
      };
      const conn = state.connections.find((c) => ref.startsWith(`${c.id}/`));
      wrap.append(
        h(
          'div',
          { class: 'pinned-row' },
          h('span', { class: 'n' }, `${i + 1}.`),
          h('span', { class: 'grow', title: ref }, conn ? `${conn.name} · ${ref.slice(conn.id.length + 1)}` : ref),
          h('button', { class: 'icon-btn', onclick: () => move(-1), title: 'Up' }, '↑'),
          h('button', { class: 'icon-btn', onclick: () => move(1), title: 'Down' }, '↓'),
          h('button', { class: 'icon-btn', onclick: () => togglePin(ref), title: 'Unpin' }, '✕')
        )
      );
    });
    pl.append(wrap);
  }

  // models table
  const mt = $('#router-models');
  mt.innerHTML = '';
  mt.append(h('tr', {}, ['Provider', 'Model', 'Status', 'This minute', 'Today'].map((x) => h('th', {}, x))));
  const usageCell = (used, limit) => {
    const cell = h('td', {}, `${used}${limit ? ` / ${limit}` : ''}`);
    if (limit) cell.append(h('div', { class: 'bar' }, h('span', { style: { width: `${Math.min(100, (used / limit) * 100)}%` } })));
    return cell;
  };
  const models = [...s.models].sort((a, b) => (b.cooldownUntil ? 1 : 0) - (a.cooldownUntil ? 1 : 0) || b.usedToday - a.usedToday || b.quality - a.quality);
  for (const m of models.slice(0, 300)) {
    const left = m.cooldownUntil ? Math.max(0, Math.round((m.cooldownUntil - Date.now()) / 1000)) : 0;
    const status = m.cooldownUntil
      ? h('td', { class: 'cool' }, `⏳ ${left > 3600 ? `${Math.round(left / 3600)}h` : left > 60 ? `${Math.round(left / 60)}m` : `${left}s`} · ${m.cooldownReason}`)
      : h('td', { class: 'ok' }, 'ready');
    mt.append(h('tr', {}, h('td', {}, m.provider), h('td', { class: 'mono' }, m.modelId), status, usageCell(m.usedMinute, m.rpm), usageCell(m.usedToday, m.rpd)));
  }
  if (!models.length) mt.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No enabled models. Add keys on the Keys page.')));

  // log
  const lt = $('#router-log');
  lt.innerHTML = '';
  lt.append(h('tr', {}, ['Time', 'From', 'Provider · model', 'Result', 'Time taken', 'Tokens'].map((x) => h('th', {}, x))));
  const log = [...s.log].reverse().slice(0, 120);
  for (const e of log) {
    lt.append(
      h(
        'tr',
        {},
        h('td', {}, new Date(e.time).toLocaleTimeString()),
        h('td', {}, e.source),
        h('td', { class: 'mono' }, `${e.provider} · ${e.model}`),
        h('td', { class: e.ok ? 'ok' : 'bad', title: e.error || '' }, e.ok ? '✓ ok' : `✕ ${(e.error || '').slice(0, 90)}`),
        h('td', {}, e.ms != null ? `${(e.ms / 1000).toFixed(1)}s` : ''),
        h('td', {}, e.tokens ? fmtNum(e.tokens) : '')
      )
    );
  }
  if (!log.length) lt.append(h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No requests yet.')));
}

$('#clear-cooldowns').addEventListener('click', async () => {
  state.router = await crew.clearCooldowns();
  renderRouter();
  toast('All cooldowns cleared', 'good');
});

let routerEventQueued = false;
crew.onRouterEvent(() => {
  if (state.view !== 'router' || routerEventQueued) return;
  routerEventQueued = true;
  setTimeout(async () => {
    routerEventQueued = false;
    state.router = await crew.routerStatus();
    renderRouter();
  }, 400);
});

// ---------- local API ----------

function renderApi() {
  const a = state.api;
  const card = $('#api-card');
  card.innerHTML = '';
  const status = a.running ? h('span', { class: 'ok', style: { color: 'var(--good)' } }, `● Running on port ${a.port}`) : h('span', { class: 'muted' }, a.enabled ? '● Not running' : '○ Off');
  const portInput = h('input', { class: 'input', type: 'number', min: '1024', max: '65535', value: a.port, style: { width: '110px' } });
  const save = async (patch) => {
    const r = await crew.updateSettings({ api: patch });
    state.settings = r.settings;
    state.api = r.api;
    if (r.api.error) toast(r.api.error, 'bad');
    renderApi();
    renderNavBadges();
  };
  card.append(
    h('div', { class: 'api-row' }, h('span', { class: 'lbl' }, 'Server'), h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: a.enabled, onchange: (e) => save({ enabled: e.target.checked }) }), h('span', { class: 'track' }), h('span', {}, a.enabled ? 'On' : 'Off')), status),
    h('div', { class: 'api-row' }, h('span', { class: 'lbl' }, 'Port'), portInput, h('button', { class: 'btn small', onclick: () => save({ port: Math.max(1024, Math.min(65535, parseInt(portInput.value, 10) || 4891)) }) }, 'Apply')),
    h('div', { class: 'api-row' }, h('span', { class: 'lbl' }, 'Base URL'), h('div', { class: 'copyable' }, h('span', {}, a.baseUrl), h('button', { class: 'btn small', onclick: () => copy(a.baseUrl, 'Base URL copied') }, 'Copy'))),
    h(
      'div',
      { class: 'api-row' },
      h('span', { class: 'lbl' }, 'API key'),
      h('div', { class: 'copyable' }, h('span', {}, a.requireKey ? a.localKey : 'not required'), a.requireKey ? h('button', { class: 'btn small', onclick: () => copy(a.localKey, 'Key copied') }, 'Copy') : null),
      a.requireKey ? h('button', { class: 'btn small', onclick: async () => { state.api = await crew.regenerateApiKey(); renderApi(); toast('New key generated; update your apps.', 'good'); } }, 'Regenerate') : null,
      h('label', { class: 'toggle', title: 'Without a key, any program on this PC can use your quota' }, h('input', { type: 'checkbox', checked: a.requireKey, onchange: (e) => save({ requireKey: e.target.checked }) }), h('span', { class: 'track' }), h('span', {}, 'Require key'))
    ),
    h('div', { class: 'muted small' }, 'Only listens on 127.0.0.1, so other devices on your network cannot reach it.')
  );

  const key = a.requireKey ? a.localKey : 'anything';
  const snippets = [
    ['Any OpenAI client', 'Point the base URL at ello Crew. Use model "auto" (or "fast", a specific model id, or a department).', `Base URL: ${a.baseUrl}\nAPI key:  ${key}\nModel:    auto`],
    ['curl', 'Quick test from a terminal.', `curl ${a.baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'`],
    ['Python (openai)', 'pip install openai', `from openai import OpenAI\nclient = OpenAI(base_url="${a.baseUrl}", api_key="${key}")\nr = client.chat.completions.create(\n    model="auto",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(r.choices[0].message.content)`],
    ['Cline / Roo Code', 'Settings → API Provider → "OpenAI Compatible".', `Base URL: ${a.baseUrl}\nAPI Key:  ${key}\nModel ID: auto`],
    ['Continue (config.yaml)', 'Add to ~/.continue/config.yaml.', `models:\n  - name: ello Crew\n    provider: openai\n    model: auto\n    apiBase: ${a.baseUrl}\n    apiKey: ${key}`],
    ['Aider', 'Run in your project folder.', `set OPENAI_API_BASE=${a.baseUrl}\nset OPENAI_API_KEY=${key}\naider --model openai/auto`],
    ['Departments as models', 'Each department is a model with its persona built in. "crew/company" runs the whole pipeline (text only).', ['crew/company', ...state.departments.map((d) => `crew/${d.id}`)].join('\n')],
  ];
  const sn = $('#api-snippets');
  sn.innerHTML = '';
  for (const [title, desc, code] of snippets) {
    sn.append(h('div', { class: 'snippet' }, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h3', {}, title), h('button', { class: 'btn small', onclick: () => copy(code) }, 'Copy')), h('p', {}, desc), h('pre', {}, code)));
  }
}

crew.onApiStatus((s) => {
  state.api = s;
  if (s.error) toast(s.error, 'bad');
  renderNavBadges();
  if (state.view === 'api') renderApi();
});

// ---------- boot ----------

(async function boot() {
  const init = await crew.init();
  Object.assign(state, init);
  state.deptId = state.departments[0].id;
  renderModelSelect();
  renderNavBadges();
  renderConvList();
  renderChatChrome();
  renderMessages();
  if (!state.connections.length) setView('chat');
  $('#input').focus();
})();

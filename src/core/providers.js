'use strict';

// Built-in providers. Every one speaks the OpenAI wire format at `baseUrl`
// (/models and /chat/completions), so a single adapter covers them all.
// Provider list and endpoints follow tashfeenahmed/freellmapi (MIT).

const PROVIDERS = [
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    signup: 'https://console.groq.com/keys',
    note: 'Very fast. Free tier: per-model RPM/RPD limits, no card.',
    defaultModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    limits: { rpm: 30, rpd: 1000 },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    signup: 'https://aistudio.google.com/apikey',
    note: 'Gemini Flash models on the AI Studio free tier.',
    defaultModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    limits: { rpm: 10, rpd: 250 },
    // Gemini's OpenAI-compat /models returns ids like "models/gemini-2.5-flash".
    normalizeModelId: (id) => id.replace(/^models\//, ''),
    modelFilter: (id) => /gemini|gemma/i.test(id) && !/embedding|aqa|imagen|veo|tts|image/i.test(id),
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    signup: 'https://cloud.cerebras.ai/',
    note: 'Extremely fast inference, generous daily token budget.',
    defaultModels: ['gpt-oss-120b', 'llama-3.3-70b', 'qwen-3-32b'],
    limits: { rpm: 30, rpd: 14400 },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    signup: 'https://openrouter.ai/keys',
    note: 'Only the zero-cost ":free" routes are used.',
    defaultModels: ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    limits: { rpm: 20, rpd: 50 },
    headers: { 'HTTP-Referer': 'https://github.com/elloexe/Project-01', 'X-Title': 'ello Crew' },
    modelFilter: (id) => id.endsWith(':free'),
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    signup: 'https://console.mistral.ai/api-keys',
    note: 'Free "Experiment" plan.',
    defaultModels: ['mistral-small-latest', 'mistral-medium-latest', 'codestral-latest'],
    limits: { rpm: 60, rpd: 0 },
    modelFilter: (id) => !/embed|moderation|ocr/i.test(id),
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    signup: 'https://build.nvidia.com/',
    note: 'Free credit pool, ~40 requests/min shared across models.',
    defaultModels: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-v3.1'],
    limits: { rpm: 40, rpd: 0 },
    modelFilter: (id) => !/embed|rerank|guard|reward|clip|nv-ingest/i.test(id),
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    signup: 'https://huggingface.co/settings/tokens',
    note: 'Inference Providers router; small monthly free credit.',
    defaultModels: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen3-32B'],
    limits: { rpm: 20, rpd: 0 },
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    signup: 'https://dashboard.cohere.com/api-keys',
    note: 'Trial key: 1,000 calls/month.',
    defaultModels: ['command-a-03-2025', 'command-r-plus'],
    limits: { rpm: 20, rpd: 33 },
    modelFilter: (id) => /command/i.test(id),
  },
  {
    id: 'llm7',
    name: 'LLM7.io',
    baseUrl: 'https://api.llm7.io/v1',
    signup: 'https://token.llm7.io/',
    note: 'Works without a key for basic models; a free token raises limits.',
    keyOptional: true,
    defaultModels: ['gpt-oss:20b', 'codestral-latest'],
    limits: { rpm: 10, rpd: 0 },
    // Only the free tier: chat models that aren't billed per use.
    modelObjectFilter: (m) => (m.model_type || 'chat') === 'chat' && m.usage_based_only !== true,
  },
  {
    id: 'kilo',
    name: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    signup: 'https://kilo.ai/',
    note: 'Keyless ":free" routes, 200 requests/hour per IP. Prompts may be logged.',
    keyOptional: true,
    defaultModels: ['kilo-auto/free'],
    limits: { rpm: 3, rpd: 0 },
    modelFilter: (id) => id.endsWith(':free') || id === 'kilo-auto/free',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    signup: 'https://ollama.com/download',
    note: 'Models running on this PC. Unlimited, private, no key.',
    keyOptional: true,
    local: true,
    defaultModels: [],
    limits: { rpm: 0, rpd: 0 },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    signup: 'https://lmstudio.ai/',
    note: 'Start the LM Studio server, then add it here. No key.',
    keyOptional: true,
    local: true,
    defaultModels: [],
    limits: { rpm: 0, rpd: 0 },
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    signup: '',
    note: 'Any OpenAI-compatible endpoint: vLLM, llama.cpp, a remote gateway…',
    keyOptional: true,
    custom: true,
    defaultModels: [],
    limits: { rpm: 0, rpd: 0 },
  },
];

const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  return byId[id] || null;
}

// Public, serialisable view for the renderer (functions stripped).
function publicCatalog() {
  return PROVIDERS.map(({ modelFilter, modelObjectFilter, normalizeModelId, headers, ...rest }) => rest);
}

// Rough "how capable is this model" score, used to order the automatic route
// when the user hasn't pinned an order. Bigger and newer families rank higher.
function modelQuality(modelId) {
  const id = modelId.toLowerCase();
  let score = 0;
  const size = id.match(/(\d+(?:\.\d+)?)b\b/);
  if (size) score += Math.min(40, Math.log2(parseFloat(size[1]) + 1) * 5);
  const families = [
    [/gpt-oss-120b|deepseek-(?:v3|r1|chat)|kimi-k2|qwen3-(?:235|coder)|glm-4\.[5-9]|gemini-2\.5-pro|command-a|llama-4-maverick/, 30],
    [/gemini-2\.5-flash(?!-lite)|llama-3\.3-70b|mistral-medium|qwen-?3|gpt-oss|nemotron-super|mistral-large/, 22],
    [/gemini.*lite|mistral-small|llama-4-scout|gemma-3|codestral|command-r/, 14],
    [/8b|7b|mini|nano|tiny|instant|3b|1b/, -8],
  ];
  for (const [re, pts] of families) {
    if (re.test(id)) {
      score += pts;
      break;
    }
  }
  return score;
}

module.exports = { PROVIDERS, getProvider, publicCatalog, modelQuality };

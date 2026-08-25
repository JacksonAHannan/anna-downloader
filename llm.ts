import axios from 'axios';

export type LLMProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'xai' | 'mistral' | 'groq' | 'deepseek' | 'cohere' | 'perplexity';

export interface GeneratedBook {
  author: string;
  title: string;
  reason: string;
}

interface ProviderDefinition {
  id: LLMProviderId;
  label: string;
  keyNames: string[];
  modelEnv: string;
  defaultModel: string;
  kind: 'openai-responses' | 'anthropic' | 'gemini' | 'openai-compatible' | 'cohere';
  endpoint?: string;
}

const PROVIDERS: ProviderDefinition[] = [
  { id: 'openai', label: 'OpenAI', keyNames: ['OPENAI_API_KEY', 'OPENAI_KEY'], modelEnv: 'OPENAI_MODEL', defaultModel: 'gpt-5-mini', kind: 'openai-responses', endpoint: 'https://api.openai.com/v1/responses' },
  { id: 'anthropic', label: 'Anthropic', keyNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'], modelEnv: 'ANTHROPIC_MODEL', defaultModel: 'claude-sonnet-4-5', kind: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages' },
  { id: 'gemini', label: 'Google Gemini', keyNames: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY'], modelEnv: 'GEMINI_MODEL', defaultModel: 'gemini-2.5-flash', kind: 'gemini' },
  { id: 'openrouter', label: 'OpenRouter', keyNames: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'], modelEnv: 'OPENROUTER_MODEL', defaultModel: 'openai/gpt-5-mini', kind: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  { id: 'xai', label: 'xAI', keyNames: ['XAI_API_KEY'], modelEnv: 'XAI_MODEL', defaultModel: 'grok-4-fast', kind: 'openai-compatible', endpoint: 'https://api.x.ai/v1/chat/completions' },
  { id: 'mistral', label: 'Mistral', keyNames: ['MISTRAL_API_KEY'], modelEnv: 'MISTRAL_MODEL', defaultModel: 'mistral-small-latest', kind: 'openai-compatible', endpoint: 'https://api.mistral.ai/v1/chat/completions' },
  { id: 'groq', label: 'Groq', keyNames: ['GROQ_API_KEY'], modelEnv: 'GROQ_MODEL', defaultModel: 'llama-3.3-70b-versatile', kind: 'openai-compatible', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
  { id: 'deepseek', label: 'DeepSeek', keyNames: ['DEEPSEEK_API_KEY'], modelEnv: 'DEEPSEEK_MODEL', defaultModel: 'deepseek-chat', kind: 'openai-compatible', endpoint: 'https://api.deepseek.com/chat/completions' },
  { id: 'cohere', label: 'Cohere', keyNames: ['COHERE_API_KEY'], modelEnv: 'COHERE_MODEL', defaultModel: 'command-a-03-2025', kind: 'cohere', endpoint: 'https://api.cohere.com/v2/chat' },
  { id: 'perplexity', label: 'Perplexity', keyNames: ['PERPLEXITY_API_KEY'], modelEnv: 'PERPLEXITY_MODEL', defaultModel: 'sonar', kind: 'openai-compatible', endpoint: 'https://api.perplexity.ai/chat/completions' },
];

const BOOK_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    books: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          author: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['author', 'title', 'reason'],
      },
    },
  },
  required: ['books'],
};

function providerKey(provider: ProviderDefinition): string {
  return provider.keyNames.map((name) => process.env[name]?.trim()).find(Boolean) || '';
}

export function listLLMProviders() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: Boolean(providerKey(provider)),
    model: process.env[provider.modelEnv]?.trim() || provider.defaultModel,
  }));
}

function normalizeBook(value: unknown): GeneratedBook | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const authorValue = item.author ?? item.authors;
  const author = Array.isArray(authorValue)
    ? authorValue.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).join('; ')
    : typeof authorValue === 'string' ? authorValue.trim() : '';
  const reason = typeof item.reason === 'string' ? item.reason.trim() : typeof item.description === 'string' ? item.description.trim() : '';
  return title && author ? { title, author, reason } : null;
}

export function parseGeneratedBookList(raw: unknown, limit: number, excludedTitles: string[] = []): GeneratedBook[] {
  let value = raw;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { value = JSON.parse(cleaned); }
    catch { throw new Error('The provider returned text that was not valid JSON.'); }
  }
  const items = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as any).books) ? (value as any).books : [];
  const excluded = new Set(excludedTitles.map((title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  const seen = new Set<string>();
  const books: GeneratedBook[] = [];
  for (const item of items) {
    const book = normalizeBook(item);
    if (!book) continue;
    const titleKey = book.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const key = `${book.author.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${titleKey}`;
    if (!titleKey || excluded.has(titleKey) || seen.has(key)) continue;
    seen.add(key);
    books.push(book);
    if (books.length >= limit) break;
  }
  if (!books.length) throw new Error('The provider did not return any valid author/title pairs.');
  return books;
}

function generationPrompt(request: string, count: number, excludedTitles: string[]): string {
  const exclusions = excludedTitles.length ? `\nDo not repeat these existing titles: ${excludedTitles.slice(0, 200).join(' | ')}` : '';
  return `Create a curated list of ${count} real, published books for this request:\n\n${request}\n\nUse accurate canonical book titles and author names. Do not invent books. Mix foundational and newer works when appropriate. Return JSON only as {"books":[{"author":"...","title":"...","reason":"one concise sentence"}]}.${exclusions}`;
}

function openAICompatibleText(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

export async function generateBookList(options: { providerId: string; model?: string; request: string; count: number; excludedTitles?: string[] }): Promise<{ books: GeneratedBook[]; provider: string; model: string }> {
  const provider = PROVIDERS.find((candidate) => candidate.id === options.providerId);
  if (!provider) throw new Error('Unsupported LLM provider.');
  const key = providerKey(provider);
  if (!key) throw new Error(`${provider.label} is not configured. Add ${provider.keyNames[0]} to .env and restart the server.`);
  const model = options.model?.trim() || process.env[provider.modelEnv]?.trim() || provider.defaultModel;
  if (!/^[a-z0-9._:/-]{1,160}$/i.test(model)) throw new Error('Invalid model name.');
  const excludedTitles = options.excludedTitles || [];
  const prompt = generationPrompt(options.request, options.count, excludedTitles);
  const system = 'You are a rigorous bibliographer. Follow the requested scope, prefer books that actually exist, and return only the requested JSON object.';
  let raw: unknown;

  if (provider.kind === 'openai-responses') {
    const apiResponse = await axios.post(provider.endpoint!, {
      model,
      instructions: system,
      input: prompt,
      text: { format: { type: 'json_schema', name: 'book_list', strict: true, schema: BOOK_LIST_SCHEMA } },
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120_000 });
    raw = apiResponse.data?.output?.flatMap((item: any) => item?.content || []).find((item: any) => item?.type === 'output_text')?.text;
  } else if (provider.kind === 'anthropic') {
    const apiResponse = await axios.post(provider.endpoint!, {
      model, max_tokens: Math.min(12_000, Math.max(2_000, options.count * 180)), system,
      messages: [{ role: 'user', content: prompt }],
    }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 120_000 });
    raw = apiResponse.data?.content?.find((item: any) => item?.type === 'text')?.text;
  } else if (provider.kind === 'gemini') {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const apiResponse = await axios.post(endpoint, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: BOOK_LIST_SCHEMA },
    }, { headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, timeout: 120_000 });
    raw = apiResponse.data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').join('');
  } else if (provider.kind === 'cohere') {
    const apiResponse = await axios.post(provider.endpoint!, {
      model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      response_format: { type: 'json_object', schema: BOOK_LIST_SCHEMA },
      max_tokens: Math.min(12_000, Math.max(2_000, options.count * 180)),
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120_000 });
    raw = apiResponse.data?.message?.content?.map((part: any) => part?.text || '').join('');
  } else {
    const apiResponse = await axios.post(provider.endpoint!, {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: Math.min(12_000, Math.max(2_000, options.count * 180)),
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 120_000 });
    raw = openAICompatibleText(apiResponse.data);
  }

  return { books: parseGeneratedBookList(raw, options.count, excludedTitles), provider: provider.id, model };
}

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { generateBookList, listLLMProviders, parseGeneratedBookList } from './llm';

const mockAxios = new MockAdapter(axios);
const originalOpenAIKey = process.env.OPENAI_API_KEY;

describe('LLM book-list generation', () => {
  beforeEach(() => {
    mockAxios.reset();
    process.env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
  });

  it('parses fenced JSON, accepts author arrays, and removes duplicates and exclusions', () => {
    const books = parseGeneratedBookList('```json\n{"books":['
      + '{"authors":["Jane Jacobs"],"title":"The Death and Life of Great American Cities","reason":"Foundational."},'
      + '{"author":"Jane Jacobs","title":"The Death and Life of Great American Cities","reason":"Duplicate."},'
      + '{"author":"Donald Shoup","title":"The High Cost of Free Parking","reason":"Parking policy."}'
      + ']}\n```', 20, ['The High Cost of Free Parking']);

    expect(books).toEqual([{ author: 'Jane Jacobs', title: 'The Death and Life of Great American Cities', reason: 'Foundational.' }]);
  });

  it('reports configured providers without exposing API keys', () => {
    const openAI = listLLMProviders().find((provider) => provider.id === 'openai');
    expect(openAI).toEqual(expect.objectContaining({ label: 'OpenAI', configured: true, model: expect.any(String) }));
    expect(JSON.stringify(openAI)).not.toContain('test-openai-key');
  });

  it('uses OpenAI structured output and returns normalized books', async () => {
    mockAxios.onPost('https://api.openai.com/v1/responses').reply((request) => {
      const body = JSON.parse(request.data);
      expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'book_list', strict: true });
      expect(request.headers?.Authorization).toBe('Bearer test-openai-key');
      return [200, { output: [{ content: [{ type: 'output_text', text: '{"books":[{"author":"Jane Jacobs","title":"The Economy of Cities","reason":"Core urban theory."}]}' }] }] }];
    });

    await expect(generateBookList({ providerId: 'openai', request: 'Urban economics', count: 10 })).resolves.toMatchObject({
      provider: 'openai',
      books: [{ author: 'Jane Jacobs', title: 'The Economy of Cities', reason: 'Core urban theory.' }],
    });
  });
});

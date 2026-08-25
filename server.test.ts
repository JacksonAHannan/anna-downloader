import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { AddressInfo } from 'net';
import { request, type Server } from 'http';
import { startServer } from './server';

describe('HTTP API', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    server = startServer(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    jest.restoreAllMocks();
  });

  it('binds to loopback instead of exposing the service to the LAN', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('returns destination state as JSON', async () => {
    const response = await fetch(`${baseUrl}/api/destination`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(expect.objectContaining({ path: expect.any(String), exists: expect.any(Boolean), canBrowse: expect.any(Boolean) }));
  });

  it('returns restorable session state', async () => {
    const response = await fetch(`${baseUrl}/api/session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      rows: expect.any(Array), destination: expect.any(String), runState: expect.any(String), scanState: expect.any(String),
    }));
  });

  it('reports LLM provider availability without returning credentials', async () => {
    const response = await fetch(`${baseUrl}/api/llm/providers`);
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: Array<Record<string, unknown>> };
    expect(body.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'openai', label: 'OpenAI', configured: expect.any(Boolean), model: expect.any(String) })]));
    expect(JSON.stringify(body)).not.toMatch(/sk-[a-z0-9]/i);
  });

  it('rejects an empty CSV import without mutating the catalog', async () => {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'content-type': 'text/csv' }, body: '   ',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'The selected CSV is empty.' });
  });

  it('rejects non-local Host headers', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(`${baseUrl}/api/destination`, { headers: { host: 'attacker.example' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(status).toBe(403);
  });
});

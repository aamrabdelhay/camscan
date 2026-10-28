import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/ai/free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/ai/free', () => {
  it('rejects a missing key without making an upstream request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(makeRequest({ apiKey: '', prompt: 'Summarise this page.' }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins requests to the $0 router and does not send paid fallbacks', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'A faithful summary.' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(makeRequest({
      apiKey: 'sk-or-v1-test-free-key',
      prompt: 'Summarise the source.\\nSOURCE TEXT START\\nExample\\nSOURCE TEXT END',
    }));

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-or-v1-test-free-key' });
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.model).toBe('openrouter/free');
    expect(payload).not.toHaveProperty('models');
    expect(payload.stream).toBe(false);

    const result = await response.json() as { text: string; model: string };
    expect(result).toEqual({ text: 'A faithful summary.', model: 'openrouter/free' });
  });

  it('reports free-model rate limits and never exposes upstream diagnostics', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ error: { message: 'private provider diagnostic' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(makeRequest({
      apiKey: 'sk-or-v1-test-free-key',
      prompt: 'Explain this paragraph.',
    }));

    expect(response.status).toBe(429);
    const result = await response.json() as { error: string };
    expect(result.error).toContain('rate limit');
    expect(result.error).not.toContain('private provider diagnostic');
  });
});

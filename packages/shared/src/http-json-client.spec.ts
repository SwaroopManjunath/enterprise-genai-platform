import { HttpJsonClient, type DownstreamError } from './http-json-client';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const clientWith = (fetchImpl: jest.Mock, timeoutMs = 1000) =>
  new HttpJsonClient({ service: 'retrieval', baseUrl: 'http://svc.test/', timeoutMs, fetchImpl });

const failure = (promise: Promise<unknown>): Promise<DownstreamError> =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error as DownstreamError,
  );

describe('HttpJsonClient', () => {
  it('posts JSON with the bearer token and extra headers, and returns the body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ ok: true }));

    const result = await clientWith(fetchImpl).post(
      '/v1/x',
      'tok',
      { a: 1 },
      { 'x-request-id': 'r1' },
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(result).toEqual({ ok: true });
    expect(url).toBe('http://svc.test/v1/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      'x-request-id': 'r1',
    });
  });

  it.each([
    ['get', 'GET', false],
    ['put', 'PUT', true],
    ['delete', 'DELETE', false],
  ] as const)('%s uses %s and %s a body', async (name, method, hasBody) => {
    const fetchImpl = jest.fn().mockResolvedValue(json({}));
    const client = clientWith(fetchImpl);

    if (name === 'put') await client.put('/x', 't', { a: 1 });
    else await client[name]('/x', 't');

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe(method);
    expect('body' in init).toBe(hasBody);
  });

  it('maps an error response to its status, code and Retry-After', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': '7' } }),
      );

    const error = await failure(clientWith(fetchImpl).post('/x', 't', {}));

    expect(error).toMatchObject({
      service: 'retrieval',
      kind: 'http',
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 7,
    });
  });

  it('copes with an error body that is not JSON', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const error = await failure(clientWith(fetchImpl).post('/x', 't', {}));
    expect(error).toMatchObject({ kind: 'http', status: 502, code: undefined });
  });

  it('reports a slow dependency as a timeout and a dead one as unreachable', async () => {
    const slow = jest.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () =>
            reject((init.signal as AbortSignal).reason),
          );
        }),
    );
    expect((await failure(clientWith(slow, 20).post('/x', 't', {}))).kind).toBe('timeout');

    const dead = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect((await failure(clientWith(dead).post('/x', 't', {}))).kind).toBe('unreachable');
  });

  it('never puts the token in an error message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({}, { status: 500 }));
    const error = await failure(clientWith(fetchImpl).post('/x', 'super-secret-token', {}));
    expect(error.message).not.toContain('super-secret-token');
  });
});

describe('HttpJsonClient.postEventStream', () => {
  const sse = (...blocks: string[]): Response =>
    new Response(blocks.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const collect = async (stream: AsyncGenerator<{ event?: string; data: string }>) => {
    const out = [];
    for await (const message of stream) out.push(message);
    return out;
  };

  it('posts with the bearer token and an event-stream Accept, and yields the events', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(sse('event: delta\ndata: {"text":"hi"}\n\n', 'event: done\ndata: {}\n\n'));

    const events = await collect(
      clientWith(fetchImpl).postEventStream(
        '/v1/chat',
        'user-token',
        { stream: true },
        { 'x-request-id': 'r1' },
      ),
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://svc.test/v1/chat');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer user-token',
      accept: 'text/event-stream',
      'x-request-id': 'r1',
    });
    expect(events).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('turns an error status before the first event into the same DownstreamError as post', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'quota_exceeded' } }), {
        status: 429,
        headers: { 'retry-after': '9', 'content-type': 'application/json' },
      }),
    );

    const error = await collect(clientWith(fetchImpl).postEventStream('/x', 't', {})).catch(
      (e) => e,
    );

    expect(error).toMatchObject({
      name: 'DownstreamError',
      kind: 'http',
      status: 429,
      code: 'quota_exceeded',
      retryAfterSeconds: 9,
    });
  });

  it('reports an unreachable service', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    const error = await collect(clientWith(fetchImpl).postEventStream('/x', 't', {})).catch(
      (e) => e,
    );

    expect(error).toMatchObject({ kind: 'unreachable' });
  });

  it('times out a stream that goes quiet, but not one that keeps talking', async () => {
    const quiet = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const received: string[] = [];
    const error = await (async () => {
      try {
        for await (const m of clientWith(quiet, 60).postEventStream('/x', 't', {}))
          received.push(m.data);
      } catch (e) {
        return e;
      }
    })();

    expect(received).toEqual(['first']);
    expect(error).toMatchObject({ kind: 'timeout' });
  });

  it('ends quietly, and closes the connection, when the caller aborts', async () => {
    let closed = false;
    const fetchImpl = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: one\n\n'));
          init.signal?.addEventListener('abort', () => {
            closed = true;
            controller.error(new Error('aborted'));
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const abort = new AbortController();

    const received: string[] = [];
    for await (const m of clientWith(fetchImpl, 5000).postEventStream(
      '/x',
      't',
      {},
      {},
      abort.signal,
    )) {
      received.push(m.data);
      abort.abort();
    }

    expect(received).toEqual(['one']);
    expect(closed).toBe(true);
  });
});

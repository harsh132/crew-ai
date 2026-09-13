/**
 * Serving a `(Request) => Response` handler on Node's `http` module.
 *
 * The runtime used to call `Bun.serve`, which tied it to Bun. Published as an
 * npm package it has to run on plain Node, and this is the same shape — port,
 * hostname, a fetch handler — so the handler itself did not change at all. It
 * still runs under Bun too, which implements `node:http`.
 *
 * Unlike the SDK's authority adapter, which buffers each response whole, this
 * streams. The page's event stream (`/api/events`) is a response that never
 * ends, and a buffered one would never be sent. For the same reason the
 * request's `signal` is aborted when the browser goes away, which is how that
 * route stops subscribing.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type ServeOptions = {
  port: number;
  hostname: string;
  fetch: (request: Request) => Promise<Response>;
};

/** Collects a request body as text. Every API route here takes JSON. */
const readBody = (incoming: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    incoming.setEncoding('utf8');
    let body = '';
    incoming.on('data', (chunk: string) => {
      body += chunk;
    });
    incoming.on('end', () => resolve(body));
    incoming.on('error', reject);
  });

const toRequest = async (incoming: IncomingMessage, hostname: string, port: number, signal: AbortSignal): Promise<Request> => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`http://${hostname}:${port}${incoming.url ?? '/'}`, {
    method,
    headers,
    signal,
    ...(hasBody ? { body: await readBody(incoming) } : {}),
  });
};

const send = async (response: Response, outgoing: ServerResponse, signal: AbortSignal): Promise<void> => {
  const headers: Record<string, string> = {};
  (response.headers as unknown as { forEach(fn: (value: string, key: string) => void): void }).forEach((value, key) => {
    headers[key] = value;
  });
  outgoing.writeHead(response.status, headers);

  if (!response.body) {
    outgoing.end();
    return;
  }

  /*
    Chunk by chunk, flushed as they come, so a stream that stays open reaches
    the browser while it is still open.
  */
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
  } finally {
    reader.releaseLock();
    outgoing.end();
  }
};

/** Starts serving. Resolves once listening; rejects if the port cannot be bound. */
export const serve = (options: ServeOptions): Promise<void> =>
  new Promise((resolve, reject) => {
    const server = createServer((incoming, outgoing) => {
      const abort = new AbortController();
      outgoing.on('close', () => {
        if (!outgoing.writableFinished) abort.abort();
      });

      void (async () => {
        try {
          const request = await toRequest(incoming, options.hostname, options.port, abort.signal);
          await send(await options.fetch(request), outgoing, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) return;
          console.error('crew: request failed', error);
          if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'something went wrong' }));
        }
      })();
    });

    /* The event stream is meant to stay open; Node's idle timeouts would cut it. */
    server.requestTimeout = 0;
    server.keepAliveTimeout = 0;

    server.once('error', reject);
    server.listen(options.port, options.hostname, () => resolve());
  });

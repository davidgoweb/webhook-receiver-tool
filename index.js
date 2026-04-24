'use strict';

/**
 * webhook-pipe — stateless webhook inspection tool
 *
 * Architecture:
 *   Each viewer owns a private AsyncQueue. The subscriber registry maps
 *   path → Map<viewerId, AsyncQueue>. Dispatch pushes only to the queues
 *   registered for that exact path, so there is no cross-path data leakage
 *   and no O(n-all-viewers) broadcast cost.
 *
 * Fixes vs original:
 *   1. Broadcast routing bug   — per-path subscriber Map, not a global EventEmitter
 *   2. Listener accumulation   — generators pull from a queue; no stream.once in loop
 *   3. No disconnect handling  — socket 'close'/'error' events call removeSubscriber
 *   4. No SSE connection cap   — MAX_VIEWERS_PER_PATH enforced with 503
 *   5. Sensitive header leak   — allowlist applied before emitting
 *   6. Dead code / no limits   — onPayload removed; bodyLimit + path regex added
 *   7. Graceful shutdown       — SIGTERM/SIGINT drain all queues cleanly
 */

const fastify = require('fastify')({
  logger: true,
  // Hard cap on incoming body size (default 64 KB; override via env)
  bodyLimit: parseInt(process.env.BODY_LIMIT_BYTES || '65536', 10),
});

const fastifySse       = require('fastify-sse-v2');
const fastifyStatic    = require('@fastify/static');
const fastifyRateLimit = require('@fastify/rate-limit');
const { randomUUID }   = require('crypto');
const nodePath         = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (all overridable via environment variables)
// ─────────────────────────────────────────────────────────────────────────────

const PORT               = 3088;
const BASE_URL           = process.env.BASE_URL                || '';
const MAX_VIEWERS_PATH   = parseInt(process.env.MAX_VIEWERS_PER_PATH || '50',  10);
const RATE_LIMIT_MAX     = parseInt(process.env.RATE_LIMIT_MAX       || '100', 10);
const RATE_LIMIT_WINDOW  = process.env.RATE_LIMIT_WINDOW             || '1 minute';

// Only forward these headers from incoming webhooks to viewers.
// Never forward Authorization, Cookie, Set-Cookie, or any bearer tokens.
const ALLOWED_HEADERS = new Set([
  'content-type',
  'user-agent',
  'x-forwarded-for',
  'x-request-id',
  'x-webhook-source',
  // Common webhook signature headers (safe to expose — they're HMACs, not secrets)
  'x-hub-signature-256',   // GitHub
  'x-gitlab-token',        // GitLab (value is a hash, not the raw secret)
  'x-stripe-signature',    // Stripe
  'svix-id',               // Svix / Clerk
  'svix-timestamp',
  'svix-signature',
]);

// Paths must be alphanumeric with dashes, underscores, or forward slashes.
// Maximum 128 characters to prevent unbounded map-key strings.
const VALID_PATH_RE = /^[a-zA-Z0-9\-_/]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// AsyncQueue — per-viewer message delivery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A simple single-consumer async queue.
 *
 * push(item) delivers immediately if a consumer is waiting, otherwise
 *            enqueues. After close(), push() is a no-op and next() returns null.
 */
class AsyncQueue {
  #buffer  = [];
  #waiters = [];
  #closed  = false;

  push(item) {
    if (this.#closed) return;
    if (this.#waiters.length > 0) {
      this.#waiters.shift()(item);
    } else {
      this.#buffer.push(item);
    }
  }

  next() {
    if (this.#closed)         return Promise.resolve(null);
    if (this.#buffer.length)  return Promise.resolve(this.#buffer.shift());
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  /** Signal the generator to exit its loop cleanly. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const resolve of this.#waiters) resolve(null);
    this.#waiters = [];
    this.#buffer  = [];
  }

  get isClosed() { return this.#closed; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriber registry
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, Map<string, AsyncQueue>>} */
const subscribers = new Map();

function addSubscriber(path, id, queue) {
  if (!subscribers.has(path)) subscribers.set(path, new Map());
  subscribers.get(path).set(id, queue);
}

function removeSubscriber(path, id) {
  const viewers = subscribers.get(path);
  if (!viewers) return;
  viewers.get(id)?.close();
  viewers.delete(id);
  if (viewers.size === 0) subscribers.delete(path);
}

/**
 * Push a payload to every viewer watching `path`.
 * Cost: O(viewers on this path) — not O(all viewers).
 * @returns {number} number of viewers that received the payload
 */
function dispatch(path, payload) {
  const viewers = subscribers.get(path);
  if (!viewers || viewers.size === 0) return 0;
  for (const queue of viewers.values()) queue.push(payload);
  return viewers.size;
}

function viewerCount(path) {
  return subscribers.get(path)?.size ?? 0;
}

function totalViewers() {
  let n = 0;
  for (const m of subscribers.values()) n += m.size;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header sanitisation
// ─────────────────────────────────────────────────────────────────────────────

function filterHeaders(raw) {
  const safe = {};
  for (const [k, v] of Object.entries(raw)) {
    if (ALLOWED_HEADERS.has(k.toLowerCase())) safe[k] = v;
  }
  return safe;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────────────

fastify.register(fastifyRateLimit, {
  max:        RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW,
  keyGenerator: req => req.ip,
  errorResponseBuilder: (_req, ctx) => ({
    status:  429,
    error:   'Too Many Requests',
    message: `Rate limit exceeded. Retry after ${ctx.after}.`,
  }),
});

// Accept any content type — webhook senders use application/json,
// application/x-www-form-urlencoded, text/plain, and more.
// The built-in JSON parser still takes priority for application/json;
// everything else arrives as a raw string.
fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
  done(null, body || null);
});

fastify.register(fastifySse);

// Serve the browser viewer from /public (for static assets)
fastify.register(fastifyStatic, {
  root:   nodePath.join(__dirname, 'public'),
  prefix: '/public',
});

// Serve index.html with injected BASE_URL config
const fs = require('fs');
fastify.get('/', async (_req, reply) => {
  const htmlPath = nodePath.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  // Inject BASE_URL as a global variable before the script tag
  const configScript = `<script>window.CONFIG = { BASE_URL: ${JSON.stringify(BASE_URL)} };</script>`;
  html = html.replace('<script>', configScript + '<script>');
  reply.type('text/html').send(html);
});

// ─────────────────────────────────────────────────────────────────────────────
// Path validation hook (runs for all /webhook/* routes)
// ─────────────────────────────────────────────────────────────────────────────

fastify.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/webhook/')) return;  // only validate webhook routes
  const raw = request.params?.['*'];
  if (!raw) return;
  if (!VALID_PATH_RE.test(raw)) {
    return reply.code(400).send({
      status:  'error',
      message: 'Path must be 1–128 characters: letters, digits, hyphens, underscores, or forward slashes.',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Health endpoint
// ─────────────────────────────────────────────────────────────────────────────

fastify.get('/health', async () => ({
  status:               'ok',
  uptime:               process.uptime(),
  activeSubscriberPaths: subscribers.size,
  totalViewers:         totalViewers(),
  memoryMB:             (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Webhook endpoint
// ─────────────────────────────────────────────────────────────────────────────

fastify.all('/webhook/*', async (request, reply) => {
  const path = request.params['*'];

  // ── VIEW mode ─────────────────────────────────────────────────────────────
  //   GET /webhook/<path>?action=view
  // ─────────────────────────────────────────────────────────────────────────
  if (request.method === 'GET' && request.query.action === 'view') {

    // Enforce per-path connection cap before allocating anything
    if (viewerCount(path) >= MAX_VIEWERS_PATH) {
      return reply.code(503).send({
        status:  'error',
        message: `Maximum concurrent viewers (${MAX_VIEWERS_PATH}) reached for this path. Try again later.`,
      });
    }

    const viewerId = randomUUID();
    const queue    = new AsyncQueue();

    addSubscriber(path, viewerId, queue);

    // Remove subscriber on ANY socket termination event
    const cleanup = () => removeSubscriber(path, viewerId);
    request.raw.once('close',   cleanup);
    request.raw.once('error',   cleanup);
    request.raw.once('aborted', cleanup);

    return reply.sse((async function* () {

      // Immediate acknowledgement — client knows the connection is live
      yield {
        event: 'connected',
        data:  JSON.stringify({
          viewerId,
          path,
          viewers: viewerCount(path),
          maxViewers: MAX_VIEWERS_PATH,
        }),
      };

      // Yield payloads as they arrive.
      // null is the close signal from AsyncQueue — exit cleanly without throwing.
      while (true) {
        const item = await queue.next();
        if (item === null) break;

        // Emit request metadata and body as two distinct SSE events
        // so consumers can handle them independently
        const { body, ...meta } = item;
        // fastify-sse-v2 expects strings for data field
        // Use compact JSON to avoid potential SSE multi-line issues
        yield { event: 'meta', data: JSON.stringify(meta) };
        yield { event: 'body', data: JSON.stringify(body ?? null) };
      }

    })());
  }

  // ── RECEIVE mode ──────────────────────────────────────────────────────────
  //   POST / PUT / PATCH / DELETE /webhook/<path>
  // ─────────────────────────────────────────────────────────────────────────
  // Normalize body: if it's a string that looks like JSON, parse it.
  // Fastify auto-parses application/json to objects, but other content-types
  // arrive as raw strings due to our wildcard parser.
  let normalizedBody = request.body ?? null;
  if (typeof normalizedBody === 'string' && normalizedBody.trim()) {
    try {
      normalizedBody = JSON.parse(normalizedBody);
    } catch {
      // Not JSON — keep as string
    }
  }

  const payload = {
    id:        randomUUID(),
    timestamp: new Date().toISOString(),
    method:    request.method,
    path,
    // Only safe, pre-approved headers are forwarded
    headers:   filterHeaders(request.headers),
    query:     Object.keys(request.query).length ? request.query : undefined,
    body:      normalizedBody,
  };

  const deliveredTo = dispatch(path, payload);

  return {
    status:      'received',
    id:          payload.id,
    path,
    deliveredTo,
    timestamp:   payload.timestamp,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 fallback
// ─────────────────────────────────────────────────────────────────────────────

fastify.setNotFoundHandler((_req, reply) => {
  reply.code(404).send({ status: 'error', message: 'Not found.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — drain all queues before exiting
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal) {
  fastify.log.info(`${signal} received — draining ${totalViewers()} viewer queue(s)`);
  for (const [path, viewers] of subscribers) {
    for (const [id] of viewers) removeSubscriber(path, id);
  }
  await fastify.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Webhook tool running on port ${PORT}`);
    fastify.log.info(`Max viewers per path: ${MAX_VIEWERS_PATH}`);
    fastify.log.info(`Rate limit: ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
})();

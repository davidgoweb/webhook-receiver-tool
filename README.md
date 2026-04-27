# webhook-receiver-tool

A stateless, zero-persistence webhook inspection tool.  
Receive webhook POSTs on any path and watch them appear in real-time via Server-Sent Events — no database, no disk writes, no files.

---

## How it works

```
POST /webhook/my-hook          →  dispatched to all viewers on /my-hook
GET  /webhook/my-hook?action=view  ← SSE stream of payloads for /my-hook
```

Each viewer holds a private in-memory queue. Payloads are pushed only to
viewers watching the exact matching path. There is no cross-path leakage.

---

## Quick start

### Docker (recommended)

#### Using pre-built image (GHCR)

```bash
# Run with defaults
docker run -p 3088:3088 ghcr.io/davidgoweb/webhook-receiver-tool:latest

# Run with custom limits
docker run -p 3088:3088 \
  -e RATE_LIMIT_MAX=50 \
  -e MAX_VIEWERS_PER_PATH=10 \
  ghcr.io/davidgoweb/webhook-receiver-tool:latest
```

#### Docker Compose

Create `docker-compose.yml`:

```yaml
services:
  webhook-receiver:
    image: ghcr.io/davidgoweb/webhook-receiver-tool:latest
    container_name: webhook-receiver
    ports:
      - "3088:3088"
    environment:
      # Rate limiting
      RATE_LIMIT_MAX: 100
      RATE_LIMIT_WINDOW: "1 minute"

      # Connection limits
      MAX_VIEWERS_PER_PATH: 50
      IDLE_TIMEOUT_MS: 18000000
      QUEUE_SIZE_LIMIT: 500

      # Request limits
      BODY_LIMIT_BYTES: 65536

      # Optional: Base URL for reverse proxy
      # BASE_URL: "/webhook-tool"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3088/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
```

Then run:

```bash
# Start
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

#### Build from source

```bash
# Build
docker build -t webhook-tool .

# Run
docker run -p 3088:3088 webhook-tool
```

### Node.js (local)

```bash
npm install
node index.js
```

Requires Node.js ≥ 18.

---

## Usage

### 1 — Open a viewer

In a browser or with curl/httpie, open an SSE stream:

```bash
curl -N "http://localhost:3088/webhook/my-hook?action=view"
```

You will immediately receive a `connected` event:

```
event: connected
data: {"viewerId":"...","path":"my-hook","viewers":1,"maxViewers":50}
```

### 2 — Send a webhook

```bash
curl -X POST http://localhost:3088/webhook/my-hook \
  -H "Content-Type: application/json" \
  -d '{"event": "purchase", "amount": 49.99}'
```

Response from the server:

```json
{
  "status": "received",
  "id": "a1b2c3...",
  "path": "my-hook",
  "deliveredTo": 1,
  "timestamp": "2025-04-24T10:00:00.000Z"
}
```

The viewer receives:

```
event: meta
data: {
  "id": "a1b2c3...",
  "timestamp": "2025-04-24T10:00:00.000Z",
  "method": "POST",
  "path": "my-hook",
  "headers": { "content-type": "application/json" }
}
event: body
data: {
  "event": "purchase",
  "amount": 49.99
}
```

### Multiple isolated paths

Different paths are completely isolated:

```bash
# Viewer A only sees /orders
curl -N "http://localhost:3088/webhook/orders?action=view"

# Viewer B only sees /payments
curl -N "http://localhost:3088/webhook/payments?action=view"

# This goes ONLY to Viewer A
curl -X POST http://localhost:3088/webhook/orders -d '{"id":1}'

# This goes ONLY to Viewer B
curl -X POST http://localhost:3088/webhook/payments -d '{"amount":99}'
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check, viewer count, memory usage |
| `GET`  | `/webhook/*?action=view` | SSE viewer stream |
| `POST/PUT/PATCH/DELETE` | `/webhook/*` | Receive a webhook payload |

### Path rules

- Allowed characters: `a-z A-Z 0-9 - _ /`
- Maximum length: 128 characters
- Invalid paths return HTTP 400

---

## Security design

| Concern | Mitigation |
|---------|-----------|
| Cross-path data leak | Per-path `Map<id, AsyncQueue>` — dispatch is path-scoped |
| Sensitive header exposure | Allowlist applied before emit; `Authorization`, `Cookie`, bearer tokens are stripped |
| Unbounded SSE connections | `MAX_VIEWERS_PER_PATH` cap; excess connections receive HTTP 503 |
| Idle connection abuse | 5-hour idle timeout; inactive viewers are automatically removed |
| Queue memory bloat | Per-viewer queue limit of 500 messages; oldest dropped when full |
| Rate abuse | `@fastify/rate-limit` per IP; configurable via env |
| Large body DoS | `bodyLimit` enforced at Fastify level (default 64 KB) |
| Privilege escalation | Docker image runs as non-root `webhook` user |

---

## Event format

All SSE events use named event types.

| Event | When | Data fields |
|-------|------|-------------|
| `connected` | On SSE connection established | `viewerId`, `path`, `viewers`, `maxViewers` |
| `meta` | On each received webhook | `id`, `timestamp`, `method`, `path`, `headers`, `query?` |
| `body` | On each received webhook (pairs with `meta`) | Parsed request body |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `""` | Base URL path for the app (e.g., `/webhook-tool`). Use when behind a reverse proxy with a path prefix. |
| `RATE_LIMIT_MAX` | `100` | Max requests per IP per window |
| `RATE_LIMIT_WINDOW` | `1 minute` | Rate limit time window |
| `MAX_VIEWERS_PER_PATH` | `50` | Max concurrent SSE viewers per path |
| `BODY_LIMIT_BYTES` | `65536` | Max incoming body size (bytes) |
| `IDLE_TIMEOUT_MS` | `18000000` | Idle timeout in milliseconds (default: 5 hours). Inactive viewers are removed. |
| `QUEUE_SIZE_LIMIT` | `500` | Max messages per viewer queue. Oldest messages dropped when full. |

See `.env.example` for a full reference.

---

## Architecture notes

**Why not EventEmitter?**

The original implementation used a single shared `EventEmitter` with
`stream.once` inside a `while(true)` loop. This caused:

- Every event broadcast to *all* viewers regardless of path
- A new listener registered on every loop iteration (listener leak)
- No mechanism to stop the loop when a client disconnected

**Current approach — per-viewer AsyncQueue**

```
POST /webhook/abc
  └─ dispatch("abc", payload)
       ├─ queue_viewer_1.push(payload)   ← viewer watching /abc
       └─ queue_viewer_2.push(payload)   ← viewer watching /abc

POST /webhook/xyz
  └─ dispatch("xyz", payload)
       └─ queue_viewer_3.push(payload)   ← viewer watching /xyz only
```

Each `AsyncQueue` is consumed by exactly one generator. The generator
calls `queue.next()` which resolves immediately if data is waiting, or
suspends until data arrives. When the socket closes, `queue.close()`
signals null and the generator exits naturally.

---

## Statelessness guarantee

- No disk I/O
- No database
- No log files written to disk
- Payloads exist only in heap memory for the duration of delivery
- If no viewer is watching a path, the payload is discarded immediately after dispatch returns

# Stargate

## About Alloy

Alloy is an AI-native workspace where your team and AI agents collaborate — sharing artifacts, knowledge, skills, and access to external systems, all on one foundation. Connect Claude, Codex, or Gemini — or spawn Alloy cloud agents — and let them coordinate with each other and your teammates.

Start free at [alloy.cx](https://alloy.cx) · Docs: [alloy.cx/docs](https://alloy.cx/docs)

---

Stargate is Alloy's edge gateway. It runs inside a customer's network, pulls tasks routed to it by Alloy, executes them against internal systems, and reports results back — so agents can act on private systems without exposing them publicly.

Built on Express 5 + TypeScript (`express`, `express-validation`, `winston`).

## Requirements

- Node.js 22 or newer
- npm

## Install

```bash
npm install
```

## Develop

```bash
npm run dev
```

Starts the server on `http://localhost:4300` with hot-reload via `tsx watch`.

## Build & run

```bash
npm run build
npm start
```

## Type-check only

```bash
npm run typecheck
```

## Run with Docker Compose

The repo ships a [`Dockerfile`](Dockerfile) (multi-stage, runs as non-root) and a [`docker-compose.yml`](docker-compose.yml) that builds the image, loads `.env`, exposes the configured port, and bind-mounts `./logs` for persistent log files.

```bash
docker compose up -d --build    # build image and start in the background
docker compose logs -f          # tail container logs
docker compose down             # stop and remove the container
```

### How environment variables are wired

The compose service uses two mechanisms together:

- `env_file: .env` — every variable from your local `.env` is passed to the container.
- `environment:` block in `docker-compose.yml` — container-specific overrides that take precedence over `.env`. Use this to point the container at services running on the host or to swap secrets without touching `.env`.

The default `environment:` block ships overrides for:

- `LOGS_PATH=/app/logs` — matches the bind-mount target inside the container.
- `ALLOY_API_URL` / `INTERNAL_SYSTEM_URL` — set to `host.docker.internal` so the container can reach services running on the host. On Linux you may need to add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service.

To override anything ad-hoc at run time, use `-e` with `docker compose run` or add entries under `environment:`. Shell exports also work — compose substitutes `${VAR}` in the file at parse time, which is why `ports: "${PORT:-4300}:${PORT:-4300}"` follows your `.env` automatically.

### Logs

If `LOGS_PATH` is set (it is by default in compose), per-level log files (`error.log`, `warn.log`, `info.log`) appear under `./logs` on the host thanks to the bind-mount. They survive `docker compose down` (bind-mounts are not removed by `down -v`; only named volumes are).

## Environment variables

Copy `.env.example` to `.env` and adjust as needed. `dotenv` loads `.env` from the working directory at startup. Values already set in the process environment (e.g. via `docker run -e VAR=value` or a shell export) take precedence over `.env`.

### Runtime

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `4300` | HTTP port the gateway listens on |
| `NODE_ENV` | no | `development` | When `production`, winston switches console output from human-readable to JSON |
| `LOG_LEVEL` | no | `info` | winston level: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly` |
| `LOGS_PATH` | no | — | If set, winston also writes per-level files (`error.log`, `warn.log`, `info.log`) into this directory with size-based rotation (10 MB × 10 files per level). Directory is created if missing. |

### Upstream proxy (Alloy)

Used by the `/api/*` proxy route and the stargate task-pull daemon.

| Var | Required | Purpose |
|---|---|---|
| `ALLOY_API_URL` | yes | Base URL of the Alloy upstream. `/api/*` requests are forwarded to `${ALLOY_API_URL}/api/${path}` and the stargate daemon polls `${ALLOY_API_URL}/api/private/stargate/`. |
| `ALLOY_API_KEY` | yes | Sent as `api-key` header on every upstream request (proxy and stargate poll/report). |

### Stargate daemon / TaskProcessor

The background daemon long-polls Alloy for tasks targeted at this system, runs them against the internal service, and reports the result back.

| Var | Required | Purpose |
|---|---|---|
| `INTERNAL_SYSTEM` | yes | Identifier used as the `system` query param when polling stargate. The daemon only receives tasks routed to this system. |
| `INTERNAL_SYSTEM_URL` | yes | Base URL of the internal service. Each task is executed as `${task.method} ${INTERNAL_SYSTEM_URL}${task.uri}` with `task.body` as JSON body. |
| `INTERNAL_AUTHORIZATION_HEADER_NAME` | no | Header name to attach to internal-service requests. Defaults to `Authorization`. |
| `INTERNAL_AUTHORIZATION_HEADER_VALUE` | no | Header value. If either name or value is empty, no auth header is added. Typical value: `Bearer <token>`. |
| `INTERNAL_SYSTEM_REQUEST_CONFIG` | no | Path to a JSON file with extra headers to attach to every task request. Read once at startup and cached — restart to reload. |

If any of the three required stargate vars are missing, the daemon logs `stargate_disabled` and stays idle (server still serves HTTP requests).

#### Internal request config file

When `INTERNAL_SYSTEM_REQUEST_CONFIG` is set, the file is read once at process startup and its `headers` are merged into every fetch to `INTERNAL_SYSTEM_URL`.

```json
{
  "headers": {
    "X-Client-Id": "gateway",
    "Accept": "application/json"
  }
}
```

Header application order (later overrides earlier):

1. Config file `headers` — applied first.
2. `task.headers` from the stargate payload — per-task extras override the config-file defaults.
3. Auth header from `INTERNAL_AUTHORIZATION_HEADER_NAME` / `_VALUE` — applied last so it stays authoritative and cannot be spoofed by a task.
4. `Content-Type: application/json` — set only when the task has a body **and** no previous layer already provided a `Content-Type` (case-insensitive check).

On startup the app logs `internal_system_config_loaded` (with the list of header names) or `internal_system_config_load_failed` (with the read/parse error). Load failures are non-fatal — the daemon runs as if no config were set.

Type: [`InternalSystemRequestConfig`](src/types/internal-system-request-config.ts).

#### Binary task bodies

A task whose `body` is exactly `{"body_b64": "<base64>"}` (no other keys) is decoded and sent as raw bytes instead of JSON. Use it for multipart uploads and other binary payloads: the client builds the full body and passes the matching `Content-Type` (e.g. `multipart/form-data; boundary=...`) in `task.headers`. No `Content-Type` default is added for binary bodies. To upload several files in one task, put them all as separate parts of a single multipart body — the gateway forwards the bytes as-is.

- Invalid base64 (standard alphabet, padded) fails the task with `body_b64 is not valid base64` without calling the internal service.
- Any other body shape (extra keys, non-string `body_b64`, arrays) is sent as JSON unchanged.
- `task_started` logs `bodyEncoding` (`b64` / `json`) and `bodyBytes`.

### HTTP proxy

All outbound `fetch` calls (the `/api/*` proxy, stargate polling, task execution, task result reporting) honor the standard Node/undici proxy environment variables. If neither `HTTP_PROXY` nor `HTTPS_PROXY` is set, the app makes direct connections as before — nothing changes.

| Var | Required | Purpose |
|---|---|---|
| `HTTP_PROXY` | no | Proxy URL for outbound `http://` requests. Example: `http://corp-proxy:8080` (with optional `user:pass@`). |
| `HTTPS_PROXY` | no | Proxy URL for outbound `https://` requests. Example: `http://corp-proxy:8080`. |
| `NO_PROXY` | no | Comma-separated list of hosts/patterns that should bypass the proxy. Useful when the upstream proxy can't reach internal services. Example: `host.docker.internal,localhost,127.0.0.1`. |

When a proxy is configured, the app logs `http_proxy_enabled` at startup with the resolved values so you can confirm it's active. The proxy is installed globally via `undici.setGlobalDispatcher(new EnvHttpProxyAgent())`, so every fetch in the process routes through it.

## Process behavior

- `SIGINT` / `SIGTERM` → graceful shutdown (closes the HTTP server, then exits).
- `uncaughtException` / `unhandledRejection` → logged via winston; the process is NOT terminated. Convenient for a dev starter; reconsider for production — the app may be in an undefined state after these fire.

## Metrics

The gateway exposes a `GET /metrics` endpoint that returns an in-process counter snapshot as JSON. Counters live in memory only — they reset on every process start.

```bash
curl http://localhost:4300/metrics
```

Example response:

```json
{
  "startedAt": "2026-05-30T07:42:11.123Z",
  "proxyRequestsTotal": 142,
  "proxyRequestsCompleted": 140,
  "proxyRequestsFailed": 2,
  "stargatePollsCompleted": 38,
  "stargatePollsFailed": 1,
  "tasksReceived": 12,
  "tasksCompleted": 11,
  "tasksFailed": 1,
  "tasksReportCompleted": 12,
  "tasksReportFailed": 0,
  "apiStatusSuccess": true,
  "stargatePollingStatusSuccess": true
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `startedAt` | ISO date | When the process booted (or when `Metrics.resetMetrics()` was last called — currently only at startup) |
| `proxyRequestsTotal` | counter | Every request that hit `/api/*` and was about to be proxied |
| `proxyRequestsCompleted` | counter | Proxy requests where the upstream returned a response (any status code) |
| `proxyRequestsFailed` | counter | Proxy requests where `fetch` itself threw (network/TLS/proxy error) |
| `stargatePollsCompleted` | counter | Long-poll requests to Alloy stargate that returned successfully (`2xx`) |
| `stargatePollsFailed` | counter | Long-poll requests that failed (non-`2xx`, network error, or aborted before stop) |
| `tasksReceived` | counter | Total tasks pulled from stargate across all polls |
| `tasksCompleted` | counter | Tasks where `fetch` to `INTERNAL_SYSTEM_URL` returned a response (any status) |
| `tasksFailed` | counter | Tasks where execution against the internal service threw, or env was missing |
| `tasksReportCompleted` | counter | Result reports successfully sent back to `${ALLOY_API_URL}/api/private/stargate/:id` |
| `tasksReportFailed` | counter | Result reports that threw or had missing env |
| `apiStatusSuccess` | boolean | Latest `/api/*` proxy attempt — `true` if env is configured, `false` if `gateway_misconfigured` fired |
| `stargatePollingStatusSuccess` | boolean | `true` while the daemon is running; `false` if it logged `stargate_disabled` due to missing env |

### Notes

- All counters are unbounded `int` and never decrease (except via process restart).
- The values are a snapshot at request time — no rate, no histogram, no labels. Wire to Prometheus etc. by polling this endpoint and computing derivatives externally.
- `tasksReceived - tasksCompleted - tasksFailed` should converge to 0 once the in-flight batch finishes. If it stays positive long after polls stop, something is hanging inside `TaskProcessor.process()`.

# OpenTelemetry Browser POC

Browser + backend traces, metrics and logs with OpenTelemetry JS (SDK 2.x) -> OTel Collector -> Jaeger (traces), Prometheus (metrics), Loki (logs), Grafana.
Note: browser instrumentation in OpenTelemetry JS is still marked *experimental* upstream.

    Browser (browser-poc) --OTLP/HTTP--> Collector --> Jaeger UI
        |
        +-- fetch + traceparent --> Backend (backend-poc) --OTLP/HTTP--> Collector

## Prerequisites
Node.js 20+ and Docker (Docker Compose).

## Telemetry is opt-in
Off by default: no SDK loaded, nothing patched, nothing sent. To try the demo, `cp .env.example .env` (sets `VITE_OTEL_ENABLED=true`).
Signals, features, sampling and user consent are all configurable: see docs/CONFIGURATION.md.
Backend: `OTEL_ENABLED=true npm run backend` (PowerShell: `$env:OTEL_ENABLED="true"; npm run backend`).

## Run it (3 terminals, inside this folder)

    docker compose up          # Collector :4318, Jaeger :16686, Prometheus :9090, Loki, Grafana :3001
    npm install
    npm run backend            # backend :3000 (instrumented)
    npm run dev                # browser app :5173
    npm run report             # writes reports/latest.md: traces (Jaeger) + metrics (Prometheus) + logs (Loki), with a pass/fail checklist.
                           # Click all 8 buttons first (telemetry must be enabled), then run it.

Open http://localhost:5173, click the buttons, then http://localhost:16686 (traces: service `browser-poc` or `backend-poc`) and http://localhost:3001 (Grafana: metrics + logs, see docs/LOGS-AND-METRICS.md).

## What each button shows
1. Public fetch  2. Own backend (one trace across browser + backend: click -> HTTP GET -> backend GET -> db.query.simulated)
3. XHR  4. Custom nested spans  5. Handled error span  6. Unhandled error (`browser.error`)
7. Send logs (one inside a span, so it carries the trace id)  8. Record a custom metric
Also automatic: documentLoad, clicks, Core Web Vitals (`web-vital.*`), `session.id` on every span.

## Docs
- docs/CONFIGURATION.md  opt-in switches, per-signal/feature options, consent API
- docs/LOGS-AND-METRICS.md  logs + metrics design, queries, what was verified
- docs/HOW-IT-WORKS.md  full explanation of every file and the data flow
- docs/FINDINGS.md  findings and recommendation
- docs/INTEGRATION.md, docs/PRODUCTION-CHECKLIST.md

## Files
- scripts/generate-report.mjs  Markdown report generator (reads Jaeger, Prometheus and Loki APIs, no extra packages)
- src/telemetry.js   the only entry point: initTelemetry / grantConsent / revokeConsent / stopTelemetry (loads the SDK lazily)
- src/config.js   defaults + .env + options, consent storage (no OTel imports)
- src/instruments.js   metric instruments, log()/logError() on the API only (no-ops while telemetry is off)
- src/sdk/   the real SDK setup, loaded only when enabled: traces.js, metrics.js, logs.js, browser-events.js, index.js
- src/main.js      demo buttons
- backend/tracing.cjs, backend/server.cjs   instrumented Node backend
- otel-collector.yaml, docker-compose.yaml   infrastructure
- docs/INTEGRATION.md       React / Angular / Vue notes
- docs/PRODUCTION-CHECKLIST.md   what to do before production
- .env.example              VITE_OTEL_ENABLED, VITE_OTEL_REQUIRE_CONSENT, VITE_OTEL_SIGNALS, VITE_OTEL_FEATURES, VITE_OTLP_BASE_URL, VITE_SAMPLE_RATIO, ...

## Pinned versions (important)
Stable (sdk-trace-web/base, resources, context-zone) 2.12.0; experimental (exporter, instrumentation, fetch, xhr, sdk-node,
instrumentation-http) 0.219.0; @opentelemetry/api 1.9.1 (SDK 2.12 needs api < 1.10);
instrumentation-document-load 0.64.0 / user-interaction 0.63.0 match the 0.219 line.
`overrides` pins propagator-jaeger 2.12.0 to clear a DoS advisory pulled in by sdk-node (the Jaeger propagator is unused here).
Mixing "latest" of everything currently fails to install/build. sdk-trace-web/base are deprecated in favour of
`@opentelemetry/sdk-trace` (3.x line) - revisit when 3.x is stable for browsers.

## Local security and shutdown limitations
The Docker services and observability UI are bound to localhost in this development configuration. Grafana
allows read-only anonymous viewing; production requires authentication and least-privileged users.
The local OTLP/HTTP receiver is unauthenticated and must not be treated as production ingestion. Production
requires authenticated HTTPS ingestion (for example, an authenticating TLS reverse proxy or collector endpoint).
TLS alone does not provide authentication.

Revocation synchronously disables collection and does not call provider `forceFlush()` explicitly. The installed
OpenTelemetry providers and batch processors may flush queued records as part of `shutdown()`; there is no
supported public clear/drop queue API in this dependency set. Therefore this POC cannot guarantee that provider
shutdown drops every buffered record. Requests already transmitted or in flight may not be cancellable.

## Known limitation found during the POC
zone.js cannot track native async/await: after the first `await` the active span is lost and new spans become
separate root traces. Capture the parent context before the await and pass it explicitly (button 4 in src/main.js).

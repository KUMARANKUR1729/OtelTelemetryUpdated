// Quarantined legacy entry point. It must not initialize providers outside the consent lifecycle.
throw new Error('Legacy OpenTelemetry modules are disabled; use src/telemetry.js and src/sdk/index.js');

// OpenTelemetry bootstrap for the browser (production-minded POC).
// Must be imported BEFORE any app code so instrumentations can patch fetch/XHR early.

import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { onLCP, onCLS, onINP, onFCP, onTTFB } from 'web-vitals';
import { OTLP_BASE, CONSOLE_DEBUG, SESSION_ID, resource } from './common.js';
import { meterProvider, recordVital, errorCount, HttpMetricsSpanProcessor } from './metrics.js';
import { loggerProvider, log, logError } from './logs.js';

// ---- Config (override with a .env file, see .env.example) -------------------
const OTLP_URL = `${OTLP_BASE}/v1/traces`;
const SAMPLE_RATIO = Number(import.meta.env.VITE_SAMPLE_RATIO ?? 1); // 1 = keep 100% (POC); e.g. 0.1 in prod
// Only these origins receive the `traceparent` header (avoids leaking trace IDs / CORS errors on 3rd parties)
const PROPAGATE_TO = [/localhost:3000/];
// Never trace the telemetry export itself
const IGNORE_URLS = [/localhost:4318/]; // covers /v1/traces, /v1/metrics and /v1/logs

// Adds session.id to every span at start time
class SessionSpanProcessor {
  onStart(span) { span.setAttribute('session.id', SESSION_ID); }
  onEnd() {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

// ---- PII scrubbing: strip query strings / fragments from URL attributes -----
// Query strings often contain tokens, emails or ids. Runs just before export.
const URL_ATTRS = ['http.url', 'url.full', 'http.target', 'url.query', 'url.path'];
const stripQuery = (v) => (typeof v === 'string' ? v.replace(/[?#].*$/, '') : v);

class RedactingExporter {
  constructor(inner) { this.inner = inner; }
  export(spans, resultCallback) {
    for (const span of spans) {
      for (const key of URL_ATTRS) {
        if (key in span.attributes) span.attributes[key] = stripQuery(span.attributes[key]);
      }
      // Exception messages can contain user data: keep type, truncate message
      for (const ev of span.events || []) {
        const msg = ev.attributes?.['exception.message'];
        if (typeof msg === 'string') ev.attributes['exception.message'] = msg.slice(0, 200);
        if (ev.attributes?.['exception.stacktrace']) delete ev.attributes['exception.stacktrace'];
      }
    }
    this.inner.export(spans, resultCallback);
  }
  shutdown() { return this.inner.shutdown(); }
  forceFlush() { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}

// ---- Provider ---------------------------------------------------------------
const processors = [
  new SessionSpanProcessor(),
  new HttpMetricsSpanProcessor(), // turns fetch/XHR spans into the browser.http.client.duration histogram
  new BatchSpanProcessor(new RedactingExporter(new OTLPTraceExporter({ url: OTLP_URL })), {
    maxQueueSize: 100,
    maxExportBatchSize: 30,
    scheduledDelayMillis: 2000,
  }),
];
if (CONSOLE_DEBUG) processors.unshift(new SimpleSpanProcessor(new ConsoleSpanExporter()));

const provider = new WebTracerProvider({
  resource, // shared with metrics and logs (src/common.js)
  // ParentBased: if a parent decided to sample, children follow; otherwise sample by ratio
  sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(SAMPLE_RATIO) }),
  spanProcessors: processors,
});

// ZoneContextManager keeps the "current span" across promises/timeouts
// (NOT across native async/await: pass context explicitly there, see src/main.js).
provider.register({ contextManager: new ZoneContextManager() });

// ---- Automatic instrumentation ---------------------------------------------
registerInstrumentations({
  instrumentations: [
    new DocumentLoadInstrumentation(),
    new UserInteractionInstrumentation(),
    new FetchInstrumentation({
      propagateTraceHeaderCorsUrls: PROPAGATE_TO,
      ignoreUrls: IGNORE_URLS,
      clearTimingResources: true,
    }),
    new XMLHttpRequestInstrumentation({
      propagateTraceHeaderCorsUrls: PROPAGATE_TO,
      ignoreUrls: IGNORE_URLS,
    }),
  ],
});

// ---- Global error tracking --------------------------------------------------
const errTracer = trace.getTracer('browser-errors');
function reportError(name, err) {
  const span = errTracer.startSpan(name);
  const e = err instanceof Error ? err : new Error(String(err));
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
  span.end();
  errorCount.add(1, { 'error.kind': name });          // metric: how many
  logError(`Unhandled: ${e.message}`, e, { 'error.kind': name }); // log: what (carries trace id if a span is active)
}
window.addEventListener('error', (ev) => reportError('browser.error', ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => reportError('browser.unhandledrejection', ev.reason));

// ---- Core Web Vitals as spans ----------------------------------------------
const vitalsTracer = trace.getTracer('web-vitals');
function reportVital(metric) {
  const span = vitalsTracer.startSpan(`web-vital.${metric.name}`);
  span.setAttribute('web_vital.name', metric.name);
  span.setAttribute('web_vital.value', metric.value);
  span.setAttribute('web_vital.rating', metric.rating);
  span.setAttribute('web_vital.id', metric.id);
  span.end();
  recordVital(metric); // same value as a histogram: percentiles/trends across all users
}
[onLCP, onCLS, onINP, onFCP, onTTFB].forEach((fn) => fn(reportVital));

// ---- Flush everything when the user leaves/hides the page (reduces data loss) ----
const flushAll = () => Promise.allSettled([provider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush()]);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});

log('info', 'telemetry initialised', { 'telemetry.signals': 'traces,metrics,logs' });

console.info('[otel] browser tracing initialised ->', OTLP_URL, `(session ${SESSION_ID})`);

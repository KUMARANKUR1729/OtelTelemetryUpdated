// Quarantined legacy entry point. See src/telemetry.js for consent-controlled initialization.
throw new Error('Legacy OpenTelemetry modules are disabled; use src/telemetry.js and src/sdk/index.js');

// Browser metrics: MeterProvider -> OTLP/HTTP -> Collector -> Prometheus.
import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLP_BASE, resource } from './common.js';

export const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${OTLP_BASE}/v1/metrics` }),
      exportIntervalMillis: 10_000, // POC: fast feedback. Production: 30-60 s.
    }),
  ],
});
metrics.setGlobalMeterProvider(meterProvider);

const meter = metrics.getMeter('browser-poc-metrics', '0.1.0');

// ---- Instruments -------------------------------------------------------------
export const uiClicks = meter.createCounter('app.ui.clicks', {
  description: 'Button clicks in the demo UI',
});
export const errorCount = meter.createCounter('browser.errors', {
  description: 'Unhandled errors and promise rejections',
});
const httpDuration = meter.createHistogram('browser.http.client.duration', {
  description: 'Duration of fetch/XHR calls made by the page',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [25, 50, 100, 250, 500, 1000, 2500, 5000] },
});
const vitalHistograms = {
  LCP: meter.createHistogram('web_vital.lcp', { unit: 'ms', advice: { explicitBucketBoundaries: [500, 1000, 2500, 4000, 6000] } }),
  FCP: meter.createHistogram('web_vital.fcp', { unit: 'ms', advice: { explicitBucketBoundaries: [500, 1000, 1800, 3000, 5000] } }),
  TTFB: meter.createHistogram('web_vital.ttfb', { unit: 'ms', advice: { explicitBucketBoundaries: [100, 200, 800, 1800, 3000] } }),
  INP: meter.createHistogram('web_vital.inp', { unit: 'ms', advice: { explicitBucketBoundaries: [50, 200, 500, 1000] } }),
  CLS: meter.createHistogram('web_vital.cls', { advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5] } }),
};
export function recordVital(metric) {
  vitalHistograms[metric.name]?.record(metric.value, { 'web_vital.rating': metric.rating });
}

// ---- RED metrics derived from spans -----------------------------------------
// Every finished fetch/XHR span also records a duration. No per-call code needed.
// Attributes are kept LOW cardinality: host + method + status, never the full URL.
const HTTP_SCOPES = ['@opentelemetry/instrumentation-fetch', '@opentelemetry/instrumentation-xml-http-request'];
export class HttpMetricsSpanProcessor {
  onStart() {}
  onEnd(span) {
    if (!HTTP_SCOPES.includes(span.instrumentationScope?.name)) return;
    const a = span.attributes;
    let host = a['server.address'] ?? a['http.host'];
    if (!host) {
      try { host = new URL(a['http.url'] ?? a['url.full']).host; } catch { host = 'unknown'; }
    }
    const [s, ns] = span.duration;
    httpDuration.record(s * 1000 + ns / 1e6, {
      'http.request.method': a['http.request.method'] ?? a['http.method'] ?? 'GET',
      'http.response.status_code': a['http.response.status_code'] ?? a['http.status_code'] ?? 0,
      'server.address': host,
    });
  }
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

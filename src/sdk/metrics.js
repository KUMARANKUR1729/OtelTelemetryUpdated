import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

class GatedExporter {
  constructor(inner, gate) { this.inner = inner; this.gate = gate; }
  export(metrics, resultCallback) {
    if (!this.gate.active) { resultCallback({ code: 0 }); return; }
    this.inner.export(metrics, resultCallback);
  }
  forceFlush() { return this.gate.active ? (this.inner.forceFlush?.() ?? Promise.resolve()) : Promise.resolve(); }
  shutdown() { return this.inner.shutdown(); }
}

export function startMetrics(config, resource) {
  const exportGate = { active: true };
  const provider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new GatedExporter(new OTLPMetricExporter({ url: `${config.otlpBase}/v1/metrics` }), exportGate),
        exportIntervalMillis: config.metricsIntervalMs, // POC: 10 s. Production: 30-60 s.
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  return {
    flush: () => provider.forceFlush(),
    stop: async () => { exportGate.active = false; await provider.shutdown(); metrics.disable(); },
  };
}

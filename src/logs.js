// Quarantined legacy entry point. See src/telemetry.js for consent-controlled initialization.
throw new Error('Legacy OpenTelemetry modules are disabled; use src/telemetry.js and src/sdk/index.js');

// Browser logs: LoggerProvider -> OTLP/HTTP -> Collector -> Loki.
// Logs emitted while a span is active automatically carry that span's trace_id/span_id,
// so in Grafana you can jump from a log line to its trace.
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor, ConsoleLogRecordExporter } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLP_BASE, resource, SESSION_ID, CONSOLE_DEBUG, CAPTURE_CONSOLE } from './common.js';

// Adds session.id and scrubs the body before the record is queued for export.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const MAX_BODY = 500;
class SessionAndRedactProcessor {
  onEmit(record) {
    record.setAttribute('session.id', SESSION_ID);
    if (typeof record.body === 'string') {
      record.setBody(record.body.replace(EMAIL, '[email]').slice(0, MAX_BODY));
    }
  }
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

const processors = [
  new SessionAndRedactProcessor(), // must run before the exporting processor
  new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${OTLP_BASE}/v1/logs` }), {
    maxQueueSize: 200,
    maxExportBatchSize: 50,
    scheduledDelayMillis: 2000,
  }),
];
if (CONSOLE_DEBUG) processors.push(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));

export const loggerProvider = new LoggerProvider({ resource, processors });
logs.setGlobalLoggerProvider(loggerProvider);

const logger = logs.getLogger('browser-poc-logs', '0.1.0');

const LEVELS = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};
export function log(level, body, attributes = {}) {
  logger.emit({
    severityNumber: LEVELS[level],
    severityText: level.toUpperCase(),
    body,
    attributes,
  });
}
// Errors: keep type + message only (no stack trace, same privacy rule as spans)
export function logError(body, err, attributes = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  log('error', body, { ...attributes, 'exception.type': e.name, 'exception.message': e.message.slice(0, 200) });
}

// ---- Forward console.warn / console.error as log records --------------------
// The flag stops a loop if exporting itself ever prints to the console.
if (CAPTURE_CONSOLE) {
  let inside = false;
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (inside) return;
      inside = true;
      try {
        log(level, args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '), {
          'log.source': 'console',
        });
      } catch { /* never break the app because of logging */ } finally { inside = false; }
    };
  }
}

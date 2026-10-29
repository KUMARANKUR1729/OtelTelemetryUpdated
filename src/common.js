// Quarantined legacy module. Importing any standalone legacy telemetry module is unsafe
// because it can bypass the consent-controlled canonical SDK in src/sdk/index.js.
throw new Error('Legacy OpenTelemetry modules are disabled; use src/telemetry.js and src/sdk/index.js');

// Shared by traces, metrics and logs: one Resource (who is sending), one session id, one set of settings.
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const env = import.meta.env;

// Base URL of the collector. VITE_OTLP_URL (old name, full traces URL) is still honoured.
export const OTLP_BASE = (
  env.VITE_OTLP_BASE_URL ||
  (env.VITE_OTLP_URL || '').replace(/\/v1\/traces\/?$/, '') ||
  'http://localhost:4318'
).replace(/\/$/, '');

export const ENV_NAME = env.VITE_ENV || 'local';
export const CONSOLE_DEBUG = (env.VITE_CONSOLE_SPANS ?? 'true') === 'true';
export const CAPTURE_CONSOLE = (env.VITE_CAPTURE_CONSOLE ?? 'true') === 'true';

export const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'browser-poc',
  [ATTR_SERVICE_VERSION]: '0.3.0',
  'deployment.environment.name': ENV_NAME,
});

// Groups everything from one browser tab session. Used on spans and logs only.
// Deliberately NOT put on metrics: a unique id per session would create one time series per user (cardinality blow-up).
function getSessionId() {
  try {
    let id = sessionStorage.getItem('otel.session.id');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('otel.session.id', id);
    }
    return id;
  } catch {
    return 'unknown'; // storage blocked
  }
}
export const SESSION_ID = getSessionId();

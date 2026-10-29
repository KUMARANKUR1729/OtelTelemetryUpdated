// The ONLY entry point app code needs. Cheap to import: it pulls in no OpenTelemetry SDK code.
// The SDK (src/sdk/*) is loaded with dynamic import() only after telemetry is switched on, so while it is off:
//   no SDK bytes downloaded, fetch/XHR not patched, zone.js not loaded, no storage written, no network requests.
import { resolveConfig, readConsent, writeConsent } from './config.js';

const state = { status: 'off', reason: 'not initialised', config: null, stop: null };
const listeners = new Set();
let queue = Promise.resolve(); // lifecycle work runs one at a time
let generation = 0;
let sdkStarter = null;

export function _setSdkStarterForTests(starter) { sdkStarter = starter; }

function setStatus(status, reason = '') {
  state.status = status; // 'off' | 'waiting-consent' | 'starting' | 'on'
  state.reason = reason;
  const snapshot = getTelemetryStatus();
  listeners.forEach((fn) => { try { fn(snapshot); } catch { /* listener errors must not break telemetry */ } });
}
const serialise = (fn) => (queue = queue.then(fn, fn).catch((e) => console.warn('[otel] telemetry error:', e?.message ?? e)));

export function getTelemetryStatus() {
  const c = state.config;
  return {
    status: state.status,
    reason: state.reason,
    enabled: !!c?.enabled,
    requireConsent: !!c?.requireConsent,
    consent: readConsent(),
    signals: c ? Object.keys(c.signals).filter((k) => c.signals[k]) : [],
  };
}
export function onTelemetryStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Call once at app start. Safe to call with no arguments: telemetry then stays off unless .env opts in. */
export function initTelemetry(options = {}) {
  generation++;
  const requestedGeneration = generation;
  return serialise(async () => {
    await stopNow();
    if (requestedGeneration !== generation) return;
    const config = resolveConfig(options);
    state.config = config;
    if (!config.enabled) return setStatus('off', 'disabled by configuration (opt-in: set VITE_OTEL_ENABLED=true or pass { enabled: true })');
    if (!SIGNALS_ON(config)) return setStatus('off', 'every signal is switched off');
    if (config.requireConsent && readConsent() !== 'granted') return setStatus('waiting-consent', 'waiting for user consent');
    await startNow(requestedGeneration);
  });
}

/** User said yes. Starts telemetry if the config allows it (and remembers the choice). */
export function grantConsent() {
  writeConsent('granted');
  if (state.status === 'starting' || state.status === 'on') {
    setStatus(state.status, state.reason);
    return Promise.resolve(queue);
  }
  generation++;
  const grantedGeneration = generation;
  setStatus('starting', 'consent granted');
  return serialise(async () => {
    if (grantedGeneration !== generation || readConsent() !== 'granted') return;
    if (state.config?.enabled && SIGNALS_ON(state.config) && state.status !== 'on') await startNow(grantedGeneration);
    else setStatus(state.status, state.reason);
  });
}

/** User said no / withdrew consent. Collection is inactive synchronously; cleanup runs separately. */
export function revokeConsent() {
  writeConsent('denied');
  generation++;
  const stop = state.stop;
  state.stop = null;
  setStatus(state.config?.requireConsent ? 'waiting-consent' : 'off', 'consent withdrawn');
  return serialise(async () => {
    if (stop) await stop();
  });
}

/** Developer-side kill switch (e.g. for tests or a settings page). Does not change stored consent. */
export function stopTelemetry() {
  generation++;
  const stop = state.stop;
  state.stop = null;
  setStatus('off', 'stopped');
  return serialise(async () => { if (stop) await stop(); });
}

const SIGNALS_ON = (c) => Object.values(c.signals).some(Boolean);

async function startNow(requestedGeneration) {
  if (requestedGeneration !== generation || readConsent() !== 'granted' && state.config.requireConsent) return;
  setStatus('starting');
  const isCurrent = () => requestedGeneration === generation &&
    (!state.config.requireConsent || readConsent() === 'granted');
  try {
    const starter = sdkStarter ?? (await import('./sdk/index.js')).startSdk;
    if (!isCurrent()) return;
    const stop = await starter(state.config, isCurrent);
    if (!isCurrent()) {
      await stop();
      return;
    }
    state.stop = stop;
    setStatus('on');
  } catch (e) {
    state.stop = null;
    if (isCurrent()) setStatus('off', `failed to start: ${e?.message ?? e}`);
  }
}
async function stopNow() {
  const stop = state.stop;
  state.stop = null;
  if (stop) await stop();
}

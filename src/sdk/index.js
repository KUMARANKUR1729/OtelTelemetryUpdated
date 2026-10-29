// Starts the signals/features the config allows and returns one stop() function that undoes all of it.
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { log } from '../instruments.js';

export async function startSdk(config, isCurrent = () => true) {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    'deployment.environment.name': config.environment,
  });
  const handles = []; // each: { flush(), stop() }

  let stopped = false;
  const stopAll = async () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', onHide);
    for (const h of handles.reverse()) { try { await h.stop(); } catch { /* keep stopping the rest */ } }
  };
  const flushAll = () => Promise.allSettled(handles.map((h) => h.flush?.()));
  const onHide = () => { if (isCurrent() && !stopped && document.visibilityState === 'hidden') flushAll(); };
  const ensureCurrent = () => { if (!isCurrent() || stopped) throw new Error('telemetry startup cancelled'); };

  try {
    const { signals, features } = config;
    // Order matters: logs and metrics first, so spans/errors created later can already use them.
    if (signals.logs) { ensureCurrent(); handles.push((await import('./logs.js')).startLogs(config, resource)); }
    ensureCurrent();
    if (signals.metrics) { ensureCurrent(); handles.push((await import('./metrics.js')).startMetrics(config, resource)); }
    ensureCurrent();
    if (signals.traces) { ensureCurrent(); handles.push((await import('./traces.js')).startTraces(config, resource)); }
    ensureCurrent();
    if (features.consoleCapture && signals.logs) handles.push((await import('./logs.js')).startConsoleCapture());
    if (features.errors || features.webVitals) handles.push(await (await import('./browser-events.js')).startBrowserEvents(config, isCurrent));
    ensureCurrent();
  } catch (e) {
    await stopAll();
    throw e;
  }

  document.addEventListener('visibilitychange', onHide); // normal operation flush only
  if (isCurrent()) log('info', 'telemetry initialised', { 'telemetry.signals': enabledSignals(config).join(',') });
  if (isCurrent() && config.consoleDebug) console.info('[otel] telemetry started ->', config.otlpBase);

  return stopAll;
}

const enabledSignals = (c) => Object.keys(c.signals).filter((k) => c.signals[k]);

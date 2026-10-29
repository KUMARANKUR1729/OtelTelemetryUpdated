import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initTelemetry, grantConsent, revokeConsent, stopTelemetry, getTelemetryStatus, _setSdkStarterForTests } from '../src/telemetry.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('shutdown gates are installed before batch processors can flush', async () => {
  for (const file of ['src/sdk/traces.js', 'src/sdk/logs.js', 'src/sdk/metrics.js']) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /exportGate\.active = false/);
    assert.match(source, /if \(!this\.gate\.active\)/);
  }
});

test('browser event cleanup runs for cancellation and normal shutdown', async () => {
  const source = await readFile('src/sdk/browser-events.js', 'utf8');
  assert.match(source, /await stopBrowserListeners\(\)/);
  assert.match(source, /cleanups\.forEach/);
  assert.match(source, /removeEventListener/);
});

test('legacy modules cannot initialize outside the canonical lifecycle', async () => {
  await assert.rejects(import('../src/tracing.js'), /Legacy OpenTelemetry modules are disabled/);
  await assert.rejects(import('../src/common.js'), /Legacy OpenTelemetry modules are disabled/);
});

test('telemetry stays disabled when master switch is off', async () => {
  _setSdkStarterForTests(async () => { throw new Error('must not start'); });
  await initTelemetry({ enabled: false });
  assert.equal(getTelemetryStatus().status, 'off');
});

test('missing consent waits and denied consent does not start', async () => {
  storage.clear();
  let starts = 0;
  _setSdkStarterForTests(async () => { starts++; return async () => {}; });
  await initTelemetry({ enabled: true, requireConsent: true });
  assert.equal(getTelemetryStatus().status, 'waiting-consent');
  assert.equal(starts, 0);
});

test('grant starts once and repeated grants do not duplicate SDKs', async () => {
  storage.clear();
  let starts = 0;
  _setSdkStarterForTests(async () => { starts++; return async () => {}; });
  await initTelemetry({ enabled: true, requireConsent: true });
  await grantConsent();
  await grantConsent();
  assert.equal(starts, 1);
  await revokeConsent();
});

test('revoke is synchronous and re-grant restarts telemetry', async () => {
  storage.clear();
  let starts = 0;
  let stops = 0;
  _setSdkStarterForTests(async () => { starts++; return async () => { stops++; }; });
  await initTelemetry({ enabled: true, requireConsent: true });
  grantConsent();
  revokeConsent();
  assert.equal(getTelemetryStatus().status, 'waiting-consent');
  await grantConsent();
  assert.equal(starts, 1);
  await revokeConsent();
  assert.equal(stops, 1);
});

test('rapid grant-revoke-grant leaves only one valid SDK running', async () => {
  storage.clear();
  let starts = 0;
  let stops = 0;
  _setSdkStarterForTests(async (_config, isCurrent) => {
    await sleep(5);
    if (!isCurrent()) return async () => {};
    starts++;
    return async () => { stops++; };
  });
  await initTelemetry({ enabled: true, requireConsent: true });
  grantConsent();
  revokeConsent();
  await grantConsent();
  assert.equal(starts, 1);
  await revokeConsent();
  assert.equal(stops, 1);
});

test('revocation invalidates SDK startup and startup failure does not activate it', async () => {
  storage.clear();
  _setSdkStarterForTests(async (_config, isCurrent) => {
    await sleep(5);
    if (!isCurrent()) throw new Error('sdk initialization failed');
  });
  await initTelemetry({ enabled: true, requireConsent: true });
  grantConsent();
  revokeConsent();
  await sleep(10);
  assert.equal(getTelemetryStatus().status, 'waiting-consent');
  await stopTelemetry();
});

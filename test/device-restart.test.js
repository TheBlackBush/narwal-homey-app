'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// The Homey runtime is not available in tests; stub the base classes so the
// device's own client lifecycle logic can be exercised.
class HomeyBase {}
const homeyPath = Module._resolveFilename('homey', module);
require.cache[homeyPath] = {
  id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: HomeyBase, Driver: HomeyBase, App: HomeyBase },
};
const NarwalHomeyDevice = require('../lib/NarwalHomeyDevice');

function fakeDevice(settings = { ip: '10.0.0.1', port: 9002, dev_mock: false }) {
  const device = Object.create(NarwalHomeyDevice.prototype);
  const timers = new Set();
  device.starts = 0;
  device.settingsWrites = [];
  device.log = () => {};
  device.error = () => {};
  device.getSettings = () => ({ ...settings });
  device.setSettings = async (next) => {
    device.settingsWrites.push(next); Object.assign(settings, next);
  };
  device.homey = {
    setTimeout: (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t); fn();
      }, ms); timers.add(t); return t;
    },
    clearTimeout: (t) => {
      timers.delete(t); clearTimeout(t);
    },
  };
  device.pendingTimers = () => timers.size;
  return device;
}

test('starting the client stops a client that is already running', () => {
  const device = fakeDevice();
  let stopped = 0;
  device._client = {
    stop: () => {
      stopped += 1;
    },
    removeAllListeners: () => {},
  };
  device._settings = () => ({
    ip: '127.0.0.1', port: 9002, pollInterval: 60000, mock: true, protocol: 'v1', productKey: 'QxMSPG6VSO', deviceId: '',
  });
  device.getCapabilityValue = () => null;

  device._startClient();

  assert.strictEqual(stopped, 1);
  device._stopClient();
});

test('two quick restarts schedule a single client start', async () => {
  const device = fakeDevice();
  device._startClient = () => {
    device.starts += 1;
  };

  device._restartClient();
  device._restartClient();
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.strictEqual(device.starts, 1);
});

test('the same new address reported twice updates the setting once', async () => {
  const device = fakeDevice();
  device._startClient = () => {
    device.starts += 1;
  };

  const results = await Promise.all([device.onDiscoveredAddress('10.0.0.2'), device.onDiscoveredAddress('10.0.0.2')]);
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepStrictEqual(results.sort(), [false, true]);
  assert.strictEqual(device.settingsWrites.length, 1);
  assert.strictEqual(device.starts, 1);
});

test('stopping the client cancels a pending restart', async () => {
  const device = fakeDevice();
  device._startClient = () => {
    device.starts += 1;
  };

  device._restartClient();
  device._stopClient();
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.strictEqual(device.starts, 0);
});

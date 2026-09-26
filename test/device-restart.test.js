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

const RESTART_DELAY_MS = 500;

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

  test.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    device._restartClient();
    device._restartClient();
    test.mock.timers.tick(RESTART_DELAY_MS);

    assert.strictEqual(device.starts, 1);
  } finally {
    test.mock.timers.reset();
  }
});

test('the same new address reported twice updates the setting once', async () => {
  const device = fakeDevice();
  device._startClient = () => {
    device.starts += 1;
  };

  test.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const results = await Promise.all([device.onDiscoveredAddress('10.0.0.2'), device.onDiscoveredAddress('10.0.0.2')]);
    test.mock.timers.tick(RESTART_DELAY_MS);

    assert.deepStrictEqual(results.sort(), [false, true]);
    assert.strictEqual(device.settingsWrites.length, 1);
    assert.strictEqual(device.starts, 1);
  } finally {
    test.mock.timers.reset();
  }
});

test('stopping the client cancels a pending restart', async () => {
  const device = fakeDevice();
  device._startClient = () => {
    device.starts += 1;
  };

  test.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    device._restartClient();
    device._stopClient();
    test.mock.timers.tick(RESTART_DELAY_MS);

    assert.strictEqual(device.starts, 0);
  } finally {
    test.mock.timers.reset();
  }
});

function settingsDevice() {
  const device = fakeDevice();
  device.restarts = 0;
  device._restartClient = () => {
    device.restarts += 1;
  };
  device._validateDefaultRoomSettings = async () => {};
  return device;
}

test('only connection settings reconnect the robot', async () => {
  const device = settingsDevice();

  for (const key of ['ip', 'port', 'poll_interval', 'dev_mock']) {
    await device.onSettings({ changedKeys: [key], newSettings: device.getSettings() });
  }
  await device.onSettings({ changedKeys: ['default_fan_speed'], newSettings: device.getSettings() });

  assert.strictEqual(device.restarts, 4);
});

test('choosing default rooms switches on starting with them', async () => {
  const device = settingsDevice();
  const newSettings = { ...device.getSettings(), default_room_ids: '1,2', use_default_rooms_for_start: false };

  await device.onSettings({ changedKeys: ['default_room_ids'], newSettings });

  assert.deepStrictEqual(device.settingsWrites, [{ use_default_rooms_for_start: true }]);
  assert.strictEqual(device.restarts, 0);
});

function cloudDevice(account) {
  const device = fakeDevice();
  const store = { deviceId: 'dev', productKey: 'QxMSPG6VSO' };
  device.unavailable = [];
  device.getStoreValue = (key) => store[key] || null;
  device.getCapabilityValue = () => null;
  device.setUnavailable = async (message) => device.unavailable.push(message);
  device.homey.app = { getConnectionMode: () => 'cloud', cloud: { getAccount: () => account } };
  return device;
}

test('in Cloud mode a signed-out app leaves the robot unavailable without connecting', () => {
  const { NarwalClient } = require('../lib/NarwalClient'); // eslint-disable-line global-require
  const start = test.mock.method(NarwalClient.prototype, 'start', () => {});
  const device = cloudDevice(null);

  device._startClient();

  assert.ok(!device._client, 'no client is created');
  assert.match(device.unavailable[0], /Sign in/);
  assert.strictEqual(start.mock.callCount(), 0);
  start.mock.restore();
});

test('in Cloud mode a signed-in app connects the robot through the account', () => {
  const { NarwalClient } = require('../lib/NarwalClient'); // eslint-disable-line global-require
  const start = test.mock.method(NarwalClient.prototype, 'start', () => {});
  const account = { signedIn: true };
  const device = cloudDevice(account);

  device._startClient();

  assert.strictEqual(device._client.cloud.account, account);
  assert.strictEqual(start.mock.callCount(), 1);
  device._stopClient();
  start.mock.restore();
});

test('the cloud check says whether this robot is on the Narwal account, without IDs', async () => {
  const account = {
    signedIn: true,
    listRobots: async () => [
      { deviceId: 'other-flow2', productId: 'QxMSPG6VSO' },
      { deviceId: 'a-freo', productId: 'fjhpiem4ba' },
    ],
  };
  const device = cloudDevice(account); // stored deviceId 'dev', productKey 'QxMSPG6VSO'

  const check = await device._checkCloudAccount();

  assert.deepStrictEqual(check, {
    onAccount: false, accountRobots: 2, sameModelRobots: 1, checkedAt: check.checkedAt,
  });
  assert.ok(!JSON.stringify(check).includes('other-flow2'));
});

test('connecting again replaces a stale Disconnected status', async () => {
  const device = cloudDevice({ signedIn: true });
  const values = { narwal_status: 'Disconnected' };
  device.getCapabilityValue = (cap) => values[cap];
  device.hasCapability = () => true;
  device.setCapabilityValue = async (cap, value) => {
    values[cap] = value;
  };
  device.setAvailable = async () => {};
  device._trigger = async () => {};

  await device._onConnected();

  assert.strictEqual(values.narwal_status, 'Connected');
});

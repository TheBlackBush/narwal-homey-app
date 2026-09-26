'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// The Homey runtime is not available in tests; stub the base classes.
class HomeyBase {}
const homeyPath = Module._resolveFilename('homey', module);
require.cache[homeyPath] = {
  id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: HomeyBase, Driver: HomeyBase, App: HomeyBase },
};
const NarwalApp = require('../app');
const api = require('../api');

function fakeSettings() {
  const data = {};
  return {
    get: (key) => (key in data ? data[key] : null),
    set: (key, value) => {
      data[key] = value;
    },
    unset: (key) => {
      delete data[key];
    },
  };
}

async function startedApp() {
  const app = new NarwalApp();
  app.log = () => {};
  app.error = () => {};
  app.homey = {
    settings: fakeSettings(),
    discovery: {
      getStrategy: () => {
        throw new Error('no mDNS in tests');
      },
    },
  };
  await app.onInit();
  const devices = [0, 1].map(() => {
    const device = {
      reconnects: 0,
      onConnectionChanged: () => {
        device.reconnects += 1;
      },
    };
    app.registerNarwalDevice(device);
    return device;
  });
  return { app, devices };
}

test('switching Local and Cloud reconnects every robot', async () => {
  const { app, devices } = await startedApp();

  app.setConnectionMode({ mode: 'cloud' });
  app.setConnectionMode({ mode: 'local' });

  assert.deepStrictEqual(devices.map((d) => d.reconnects), [2, 2]);
});

test('an account change reconnects robots only in Cloud mode', async () => {
  const { app, devices } = await startedApp();

  app.cloud._changed(false); // e.g. signing in while Local is chosen
  assert.deepStrictEqual(devices.map((d) => d.reconnects), [0, 0]);

  app.setConnectionMode({ mode: 'cloud' });
  app.cloud._changed(false); // signing in or out while Cloud is chosen
  assert.deepStrictEqual(devices.map((d) => d.reconnects), [2, 2]);
});

test('API routes pass requests to the app and survive missing bodies and queries', async () => {
  const calls = [];
  const homey = {
    app: {
      setConnectionMode: (body) => calls.push(['mode', body]),
      cloudLoginWithPassword: (body) => calls.push(['password', body]),
      cloudRequestEmailCode: (body) => calls.push(['request-code', body]),
      cloudLoginWithEmailCode: (body) => calls.push(['code', body]),
      refreshSettingsRoomsMap: (id) => calls.push(['rooms', id]),
    },
  };

  await api.setConnectionMode({ homey });
  await api.cloudLoginPassword({ homey, body: { email: 'e' } });
  await api.cloudRequestCode({ homey });
  await api.cloudLoginCode({ homey });
  await api.refreshRoomsMap({ homey, body: { deviceId: 'a' } });
  await api.refreshRoomsMap({ homey, query: { did: 'b' } });
  await api.refreshRoomsMap({ homey });

  assert.deepStrictEqual(calls, [
    ['mode', {}], ['password', { email: 'e' }], ['request-code', {}], ['code', {}],
    ['rooms', 'a'], ['rooms', 'b'], ['rooms', ''],
  ]);
});

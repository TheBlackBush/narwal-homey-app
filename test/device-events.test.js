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
const NarwalHomeyDevice = require('../lib/NarwalHomeyDevice');
const { RobotState } = require('../lib/constants');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeDevice() {
  const device = Object.create(NarwalHomeyDevice.prototype);
  device.triggers = [];
  device.savedRooms = [];
  device.images = 0;
  device.log = () => {};
  device.error = () => {};
  device.setStoreValue = async () => {};
  device.getStoreValue = () => null;
  // Flow triggers take a moment, as they do on Homey.
  device._trigger = async (id) => {
    device.triggers.push(id);
    await tick();
  };
  device._saveRooms = async (rooms) => {
    device.savedRooms.push(rooms);
  };
  device.setCameraImage = async () => {};
  device.homey = {
    images: {
      createImage: async () => {
        device.images += 1;
        await tick();
        return { setStream: () => {}, update: async () => {} };
      },
    },
  };
  return device;
}

test('status updates arriving together fire each Flow trigger once', async () => {
  const device = fakeDevice();
  device._prev = {
    state: RobotState.DOCKED, docked: true, charging: false, battery: 80,
  };
  // Capability writes take a moment, as they do on Homey.
  device._applyStatusToCapabilities = async () => {
    await tick();
  };
  const cleaning = {
    state: RobotState.CLEANING, docked: false, charging: false, battery: 80,
  };

  await Promise.all([device._onStatus(cleaning), device._onStatus({ ...cleaning })]);

  assert.deepStrictEqual(device.triggers.filter((id) => id === 'started_cleaning'), ['started_cleaning']);
  assert.deepStrictEqual(device.triggers.filter((id) => id === 'undocked'), ['undocked']);
});

test('a map without rooms keeps the stored rooms', async () => {
  const device = fakeDevice();
  device._renderMap = async () => {};

  await device._onMap({ rooms: [], updatedAt: 1 });
  await device._onMap({ updatedAt: 2 });
  await device._onMap({ rooms: [{ id: 1, name: 'Kitchen' }], updatedAt: 3 });

  assert.deepStrictEqual(device.savedRooms, [[{ id: 1, name: 'Kitchen' }]]);
});

test('refreshing rooms and map handles the new map once', async () => {
  const device = fakeDevice();
  const map = { rooms: [{ id: 1, name: 'Kitchen' }], updatedAt: 1 };
  let handled = 0;
  device._onMap = async () => {
    handled += 1;
  };
  // The client emits 'map' itself when it takes in a new map.
  device._client = {
    connected: true,
    refreshMap: async () => {
      await device._onMap(map);
      return map;
    },
  };

  await device.refreshRoomsAndMap();

  assert.strictEqual(handled, 1);
});

test('two map renders at once create one camera image', async () => {
  const device = fakeDevice();
  const map = {
    rooms: [],
    updatedAt: 1,
    bounds: {
      minX: 0, minY: 0, maxX: 10, maxY: 10,
    },
  };

  await Promise.all([device._renderMap(map), device._renderMap(map)]);

  assert.strictEqual(device.images, 1);
});

test('every Flow trigger the device fires is a defined trigger card', () => {
  const fs = require('node:fs'); // eslint-disable-line global-require
  const path = require('node:path'); // eslint-disable-line global-require
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'NarwalHomeyDevice.js'), 'utf8');
  const fired = new Set([...source.matchAll(/_trigger\('([a-z_]+)'/g)].map((m) => m[1]));
  const defined = new Set(fs.readdirSync(path.join(__dirname, '..', '.homeycompose', 'flow', 'triggers'))
    .map((f) => f.replace(/\.json$/, '')));

  assert.ok(fired.size >= 10, 'found the trigger calls');
  assert.deepStrictEqual([...fired].filter((id) => !defined.has(id)), []);
  assert.deepStrictEqual([...defined].filter((id) => !fired.has(id)), [], 'no trigger card is left unused');
});

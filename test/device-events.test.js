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

function liveDevice() {
  const device = fakeDevice();
  device.pushes = [];
  device.getId = () => 'dev-1';
  device.homey.api = { realtime: (event, data) => device.pushes.push({ event, data }) };
  device.homey.setTimeout = setTimeout;
  device.homey.clearTimeout = clearTimeout;
  device._client = {
    lastStaticMap: {
      border: {
        bottom: 0, top: 9, left: 0, right: 9,
      },
    },
  };
  device._mapRenderData = { meta: { crop: { x: 0, y: 0, sourceHeight: 10 } } };
  return device;
}

const live = (x, y, trail) => ({
  robot: { x, y, theta: 0 }, lostPosition: false, trail: trail.map(([tx, ty]) => ({ x: tx, y: ty })),
});

test('live robot messages build a trail and are pushed to the widget, at most every 2 s', () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const device = liveDevice();
  try {
    device._onLive(live(1, 1, [[0, 0], [1, 1]]));
    device._onLive(live(2, 1, [[1, 1], [2, 1]]));
    assert.strictEqual(device.pushes.length, 1, 'first push at once, the next waits');
    assert.deepStrictEqual(device.pushes[0].data.points, [{ x: 0, y: 9 }, { x: 1, y: 8 }]);
    assert.strictEqual(device.pushes[0].event, 'narwal:live');
    assert.strictEqual(device.pushes[0].data.deviceId, 'dev-1');

    test.mock.timers.tick(2000);
    assert.strictEqual(device.pushes.length, 2);
    assert.deepStrictEqual(device.pushes[1].data, {
      deviceId: 'dev-1', robot: { x: 2, y: 8, theta: 0 }, lostPosition: false, from: 2, points: [{ x: 2, y: 8 }], total: 3,
    });
    assert.deepStrictEqual(device.getLiveData().points, [{ x: 0, y: 9 }, { x: 1, y: 8 }, { x: 2, y: 8 }]);
  } finally {
    test.mock.timers.reset();
  }
});

test('a new clean starts a new trail', async () => {
  const device = liveDevice();
  device._applyStatusToCapabilities = async () => {};
  device._onLive(live(1, 1, [[0, 0], [1, 1]]));
  device._prev = { state: RobotState.DOCKED };

  await device._onStatus({ state: RobotState.CLEANING, docked: false });

  assert.deepStrictEqual(device.getLiveData().points, []);
  clearTimeout(device._livePushTimer);
});

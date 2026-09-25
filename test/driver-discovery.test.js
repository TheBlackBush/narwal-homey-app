'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// The Homey runtime is not available in tests; stub the base classes.
function HomeyBase() {}
const homeyPath = Module._resolveFilename('homey', module);
require.cache[homeyPath] = {
  id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: HomeyBase, Driver: HomeyBase, App: HomeyBase },
};
const { NarwalHomeyDriver } = require('../lib/NarwalHomeyDriver');
const { NarwalClient } = require('../lib/NarwalClient');

const DEVICE_ID = '0123456789abcdef0123456789ab7721';

test.afterEach(() => test.mock.restoreAll());

function flow2Model(driver) {
  Object.defineProperty(driver, 'modelId', { value: 'narwal_flow_2' });
  return driver;
}

function fakeDriver({ results = [], devices = [] } = {}) {
  const driver = flow2Model(Object.create(NarwalHomeyDriver.prototype));
  driver.log = () => {};
  driver.error = () => {};
  driver.homey = { discovery: { getStrategy: () => ({ getDiscoveryResults: () => Object.fromEntries(results.map((r, i) => [String(i), r])) }) } };
  driver.getDevices = () => devices.map(({ dataId, deviceId }) => ({ getData: () => ({ id: dataId }), getStoreValue: () => deviceId }));
  return driver;
}

test('listing found robots answers without probing any robot', async () => {
  const probe = test.mock.method(NarwalClient, 'probe', async () => {
    throw new Error('should not probe');
  });
  const driver = fakeDriver({
    results: [
      { name: '_app_wss_server_ab7721', address: '10.0.0.2' },
      { name: '_app_wss_server_cccccc', address: '10.0.0.3' },
      { name: '_app_wss_server_dddddd', address: 'fd00::1' },
    ],
    devices: [{ dataId: 'narwal_flow_2-10.0.0.9-9002', deviceId: DEVICE_ID }],
  });

  const robots = await driver._listFoundRobots();

  assert.strictEqual(probe.mock.callCount(), 0);
  assert.deepStrictEqual(robots, [
    { ip: '10.0.0.2', suffix: 'ab7721', added: true },
    { ip: '10.0.0.3', suffix: 'cccccc', added: false },
  ]);
});

test('listing found robots returns an empty list when discovery is unavailable', async () => {
  const driver = fakeDriver();
  driver.homey = {
    discovery: {
      getStrategy: () => {
        throw new Error('no strategy');
      },
    },
  };

  assert.deepStrictEqual(await driver._listFoundRobots(), []);
});

test('identifying a robot of this model returns a device ready to add', async () => {
  test.mock.method(NarwalClient, 'probe', async () => ({ topicPrefix: '/mkbqaprvrb', deviceId: DEVICE_ID, state: 'docked' }));
  const driver = fakeDriver();

  const robot = await driver._identifyRobot({ ip: '10.0.0.2', suffix: 'ab7721' });

  assert.strictEqual(robot.group, 'match');
  assert.strictEqual(robot.device.data.id, DEVICE_ID);
  assert.strictEqual(robot.device.settings.ip, '10.0.0.2');
});

test('identifying a silent robot reports it as not answering instead of throwing', async () => {
  test.mock.method(NarwalClient, 'probe', async () => {
    throw new Error('Connection timed out');
  });
  const driver = fakeDriver();

  const robot = await driver._identifyRobot({ ip: '10.0.0.4', suffix: 'eeeeee' });

  assert.strictEqual(robot.group, 'unknown');
  assert.strictEqual(robot.responded, false);
  assert.strictEqual(robot.device, undefined);
});

test('identifying rejects anything that is not an IPv4 address', async () => {
  const probe = test.mock.method(NarwalClient, 'probe', async () => ({}));
  const driver = fakeDriver();

  await assert.rejects(driver._identifyRobot({ ip: 'example.com', suffix: 'ab7721' }), /IPv4/);
  assert.strictEqual(probe.mock.callCount(), 0);
});

function withCloud(driver, { mode = 'cloud', signedIn = true, robots = [] } = {}) {
  const account = { signedIn, listRobots: async () => robots };
  driver.homey.app = {
    cloud: {
      getMode: () => mode,
      getAccount: () => (signedIn ? account : null),
      status: () => ({ mode, signedIn, email: signedIn ? 'me@example.com' : null }),
    },
  };
  return driver;
}

const ACCOUNT_ROBOTS = [
  { deviceId: DEVICE_ID, productId: 'QxMSPG6VSO', name: 'Kitchen robot' },
  { deviceId: 'ffffffffffffffffffffffffffcccccc', productId: 'fjhpiem4ba', name: 'Upstairs' },
];

test('the pairing screen learns the app mode and sign-in state', () => {
  const driver = withCloud(fakeDriver(), { mode: 'cloud', signedIn: false });

  assert.deepStrictEqual(driver._pairingMode(), { mode: 'cloud', signedIn: false });
});

test('cloud pairing lists the account robots with their local IP when found', async () => {
  const driver = withCloud(fakeDriver({ results: [{ name: '_app_wss_server_ab7721', address: '10.0.0.2' }] }), { robots: ACCOUNT_ROBOTS });

  const robots = await driver._listCloudRobots();

  assert.deepStrictEqual(robots.map((r) => [r.name, r.group, r.ip]), [
    ['Kitchen robot', 'match', '10.0.0.2'],
    ['Upstairs', 'other', ''],
  ]);
});

test('cloud pairing asks to sign in when no account is signed in', async () => {
  const driver = withCloud(fakeDriver(), { signedIn: false });

  await assert.rejects(driver._listCloudRobots(), /Sign in/);
});

test('adding a cloud robot builds a device with its device id and model key', async () => {
  const driver = withCloud(fakeDriver({ results: [{ name: '_app_wss_server_ab7721', address: '10.0.0.2' }] }), { robots: ACCOUNT_ROBOTS });

  const device = await driver._cloudDevice({ deviceId: DEVICE_ID });

  assert.strictEqual(device.data.id, DEVICE_ID);
  assert.strictEqual(device.name, 'Kitchen robot');
  assert.strictEqual(device.store.deviceId, DEVICE_ID);
  assert.strictEqual(device.store.productKey, 'QxMSPG6VSO');
  assert.strictEqual(device.settings.ip, '10.0.0.2');
});

test('adding a robot that is not on the account, or of another model, is refused', async () => {
  const driver = withCloud(fakeDriver(), { robots: ACCOUNT_ROBOTS });

  await assert.rejects(driver._cloudDevice({ deviceId: 'nope' }), /not found/);
  await assert.rejects(driver._cloudDevice({ deviceId: 'ffffffffffffffffffffffffffcccccc' }), /Narwal Freo 20/);
});

function pairSession(driver) {
  const handlers = {};
  driver.onPair({
    setHandler: (name, fn) => {
      handlers[name] = fn;
    },
  });
  return handlers;
}

test('the pairing screen can reach every handler it calls', () => {
  const handlers = pairSession(fakeDriver());

  for (const name of ['validate', 'list_devices', 'discover', 'identify', 'pairing_mode', 'cloud_robots', 'cloud_add']) {
    assert.strictEqual(typeof handlers[name], 'function', name);
  }
});

test('pairing cannot switch on mock mode; only NARWAL_MOCK=1 can', async () => {
  const probe = test.mock.method(NarwalClient, 'probe', async () => ({ deviceId: DEVICE_ID }));
  const saved = process.env.NARWAL_MOCK;
  delete process.env.NARWAL_MOCK;
  try {
    const handlers = pairSession(fakeDriver());

    await assert.rejects(handlers.validate({ ip: '', dev_mock: true }), /IPv4/);
    const { device } = await handlers.validate({ ip: '10.0.0.5', dev_mock: true });

    assert.strictEqual(device.settings.dev_mock, false);
    assert.strictEqual(probe.mock.calls[0].arguments[0].mock, false);
  } finally {
    if (saved === undefined) delete process.env.NARWAL_MOCK;
    else process.env.NARWAL_MOCK = saved;
  }
});

function flowDriver() {
  const cards = {};
  const card = (kind) => (id) => {
    const key = `${kind}:${id}`;
    cards[key] = cards[key] || {
      registerRunListener: (fn) => {
        cards[key].run = fn;
        cards[key].registrations = (cards[key].registrations || 0) + 1;
      },
      registerArgumentAutocompleteListener: () => {},
    };
    return cards[key];
  };
  const homey = { flow: { getActionCard: card('actions'), getConditionCard: card('conditions') } };
  const make = () => {
    const driver = fakeDriver();
    driver.homey = homey;
    return driver;
  };
  return { make, cards };
}

test('Flow listeners are registered once for all drivers and match the Flow cards', () => {
  const fs = require('node:fs'); // eslint-disable-line global-require
  const path = require('node:path'); // eslint-disable-line global-require
  const { make, cards } = flowDriver();

  make()._registerFlowOnce();
  make()._registerFlowOnce(); // a second driver

  assert.ok(Object.values(cards).every((c) => c.registrations === 1));
  const compose = (kind) => fs.readdirSync(path.join(__dirname, '..', '.homeycompose', 'flow', kind))
    .filter((f) => f.endsWith('.json')).map((f) => `${kind}:${f.replace(/\.json$/, '')}`);
  assert.deepStrictEqual(Object.keys(cards).sort(), [...compose('actions'), ...compose('conditions')].sort());
});

test('Flow cards pass their arguments to the device', async () => {
  const { make, cards } = flowDriver();
  make()._registerFlowOnce();
  const seen = [];
  const device = {
    setFanSpeed: async (speed) => seen.push(['fan', speed]),
    cleanRoom: async (room) => seen.push(['room', room]),
    getCapabilityValue: () => 50,
  };

  await cards['actions:set_fan_speed'].run({ device, fan_speed: 'quiet' });
  await cards['actions:clean_room'].run({ device, room: { id: '3' } });

  assert.deepStrictEqual(seen, [['fan', 'quiet'], ['room', { id: '3' }]]);
  assert.strictEqual(await cards['conditions:battery_above'].run({ device, percent: 49 }), true);
  assert.strictEqual(await cards['conditions:battery_above'].run({ device, percent: 50 }), false, 'above, not equal');
  assert.strictEqual(await cards['conditions:battery_above'].run({ device: { getCapabilityValue: () => null }, percent: 0 }), false);
});

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

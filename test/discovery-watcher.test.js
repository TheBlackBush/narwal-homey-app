'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { DiscoveryWatcher } = require('../lib/DiscoveryWatcher');

const DEVICE_ID = '0123456789abcdef0123456789ab7721';

function fakeResult(address, name = '_app_wss_server_ab7721') {
  const result = new EventEmitter();
  result.name = name;
  result.address = address;
  return result;
}

function fakeStrategy(results = []) {
  const strategy = new EventEmitter();
  strategy.getDiscoveryResults = () => Object.fromEntries(results.map((r, i) => [String(i), r]));
  return strategy;
}

function fakeDevice(deviceId = DEVICE_ID) {
  const calls = [];
  return {
    calls,
    getStoreValue: (key) => (key === 'deviceId' ? deviceId : null),
    onDiscoveredAddress: async (ip) => {
      calls.push(ip); return true;
    },
  };
}

test('watcher routes a new discovery result to the matching device only', () => {
  const strategy = fakeStrategy();
  const device = fakeDevice();
  const other = fakeDevice('ffffffffffffffffffffffffffffffff');
  new DiscoveryWatcher({ strategy, getDevices: () => [device, other] }).start();

  strategy.emit('result', fakeResult('10.0.0.8'));

  assert.deepStrictEqual(device.calls, ['10.0.0.8']);
  assert.deepStrictEqual(other.calls, []);
});

test('watcher follows address changes of results it already knows', () => {
  const existing = fakeResult('10.0.0.8');
  const strategy = fakeStrategy([existing]);
  const device = fakeDevice();
  new DiscoveryWatcher({ strategy, getDevices: () => [device] }).start();

  existing.address = '10.0.0.9';
  existing.emit('addressChanged', existing);
  const fresh = fakeResult('10.0.0.10', '_app_wss_server_ab7721');
  strategy.emit('result', fresh);
  fresh.address = '10.0.0.11';
  fresh.emit('addressChanged', fresh);

  assert.deepStrictEqual(device.calls, ['10.0.0.9', '10.0.0.10', '10.0.0.11']);
});

test('watcher checks a device against results already found when it registers', () => {
  const device = fakeDevice();
  const watcher = new DiscoveryWatcher({ strategy: fakeStrategy([fakeResult('fd00::1'), fakeResult('10.0.0.8')]), getDevices: () => [] });

  watcher.checkDevice(device);

  assert.deepStrictEqual(device.calls, ['10.0.0.8']);
});

test('watcher never throws when discovery is unavailable or broken', () => {
  const broken = new EventEmitter();
  broken.getDiscoveryResults = () => {
    throw new Error('boom');
  };
  const device = fakeDevice();

  assert.doesNotThrow(() => new DiscoveryWatcher({ strategy: broken, getDevices: () => [device] }).start());
  assert.doesNotThrow(() => new DiscoveryWatcher({ strategy: broken, getDevices: () => [] }).checkDevice(device));
  assert.doesNotThrow(() => new DiscoveryWatcher({ strategy: null, getDevices: () => [] }).checkDevice(device));
  assert.deepStrictEqual(device.calls, []);
});

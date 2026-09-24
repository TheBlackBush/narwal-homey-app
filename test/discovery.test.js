'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  suffixFromName, resultSuffix, pickIPv4, matchesDeviceId, uniqueResults, buildPairEntry, markAdded,
} = require('../lib/Discovery');

const FLOW_2 = { id: 'narwal_flow_2', name: 'Narwal Flow 2' };
const DEVICE_ID = '0123456789abcdef0123456789ab7721';

test('suffixFromName reads the 6-character robot id from service and host names', () => {
  assert.strictEqual(suffixFromName('_app_wss_server_6B7721'), '6b7721');
  assert.strictEqual(suffixFromName('_app_wss_server_6b7721._narwal_sweeper._tcp.local'), '6b7721');
  assert.strictEqual(suffixFromName('NARWAL_6b7721.local'), '6b7721');
  assert.strictEqual(suffixFromName('homey'), null);
  assert.strictEqual(suffixFromName(undefined), null);
});

test('resultSuffix falls back from name to host', () => {
  assert.strictEqual(resultSuffix({ name: 'x', host: 'NARWAL_ab12cd.local' }), 'ab12cd');
  assert.strictEqual(resultSuffix({}), null);
});

test('pickIPv4 ignores IPv6 addresses', () => {
  assert.strictEqual(pickIPv4({ address: '10.200.20.61' }), '10.200.20.61');
  assert.strictEqual(pickIPv4({ address: 'fd00::1' }), null);
  assert.strictEqual(pickIPv4({ address: 'fd00::1', addresses: ['fd00::1', '10.0.0.5'] }), '10.0.0.5');
  assert.strictEqual(pickIPv4({}), null);
});

test('matchesDeviceId needs both a device id and a suffix', () => {
  assert.strictEqual(matchesDeviceId(DEVICE_ID, 'ab7721'), true);
  assert.strictEqual(matchesDeviceId(DEVICE_ID.toUpperCase(), 'ab7721'), true);
  assert.strictEqual(matchesDeviceId(DEVICE_ID, '000000'), false);
  assert.strictEqual(matchesDeviceId(null, 'ab7721'), false);
  assert.strictEqual(matchesDeviceId(DEVICE_ID, null), false);
});

test('uniqueResults keeps one IPv4 entry per robot', () => {
  const results = [
    { name: '_app_wss_server_6b7721', address: 'fd00::1' },
    { name: '_app_wss_server_6b7721', address: '10.200.20.61' },
    { name: '_app_wss_server_6b7721', address: '10.200.20.61' },
    { name: 'other_service', address: '10.0.0.9' },
    { name: '_app_wss_server_aaaaaa', address: '10.0.0.7' },
  ];
  assert.deepStrictEqual(uniqueResults(results), [
    { suffix: '6b7721', ip: '10.200.20.61' },
    { suffix: 'aaaaaa', ip: '10.0.0.7' },
  ]);
});

test('buildPairEntry groups robots by model', () => {
  const none = new Set();
  const match = buildPairEntry({ ip: '10.0.0.2', port: 9002, probe: { topicPrefix: '/mkbqaprvrb', deviceId: DEVICE_ID } }, FLOW_2, none);
  assert.strictEqual(match.group, 'match');
  assert.strictEqual(match.modelName, 'Narwal Flow 2');
  assert.strictEqual(match.deviceId, DEVICE_ID);
  assert.strictEqual(match.productKey, 'mkbqaprvrb');

  const other = buildPairEntry({ ip: '10.0.0.3', port: 9002, probe: { topicPrefix: '/fjhpiem4ba', deviceId: DEVICE_ID } }, FLOW_2, none);
  assert.strictEqual(other.group, 'other');
  assert.strictEqual(other.modelName, 'Narwal Freo 20');

  const asleep = buildPairEntry({ ip: '10.0.0.4', port: 9002, error: new Error('timeout') }, FLOW_2, none);
  assert.strictEqual(asleep.group, 'unknown');
  assert.strictEqual(asleep.deviceId, null);

  const unrecognised = buildPairEntry({ ip: '10.0.0.5', port: 9002, probe: { topicPrefix: '/zzzzzzzzzz' } }, FLOW_2, none);
  assert.strictEqual(unrecognised.group, 'unknown');
});

test('buildPairEntry marks robots already added under this driver', () => {
  const entry = buildPairEntry({ ip: '10.0.0.2', port: 9002, probe: { topicPrefix: '/QxMSPG6VSO', deviceId: DEVICE_ID } }, FLOW_2, new Set([DEVICE_ID]));
  assert.strictEqual(entry.added, true);
});

test('buildPairEntry treats models without a driver as unknown, not as another model', () => {
  for (const key of ['hEA7OEshlx', 'BYWBPqSxeC', 'CGjuB6dzq7']) {
    const entry = buildPairEntry({ ip: '10.0.0.6', port: 9002, probe: { topicPrefix: `/${key}`, deviceId: DEVICE_ID } }, FLOW_2, new Set());
    assert.strictEqual(entry.group, 'unknown', key);
  }
});

test('buildPairEntry matches every Flow 2 product key', () => {
  for (const key of ['QxMSPG6VSO', 'iSuVlI1If2', 'mkbqaprvrb']) {
    const entry = buildPairEntry({ ip: '10.0.0.2', port: 9002, probe: { topicPrefix: `/${key}`, deviceId: DEVICE_ID } }, FLOW_2, new Set());
    assert.strictEqual(entry.group, 'match', key);
  }
});

test('markAdded flags robots already paired, from stored device ids, before any probe', () => {
  const found = [{ suffix: 'ab7721', ip: '10.0.0.2' }, { suffix: 'cccccc', ip: '10.0.0.3' }];
  const marked = markAdded(found, [DEVICE_ID, 'narwal_flow_2-10.0.0.9-9002', null]);
  assert.deepStrictEqual(marked.map((r) => r.added), [true, false]);
});

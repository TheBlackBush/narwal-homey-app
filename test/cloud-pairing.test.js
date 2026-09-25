'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cloudPairEntries } = require('../lib/cloud/cloudPairing');

const FLOW_2 = { id: 'narwal_flow_2', name: 'Narwal Flow 2' };
const ID_A = '0123456789abcdef0123456789ab7721';
const ID_B = 'ffffffffffffffffffffffffffcccccc';

const robots = [
  {
    deviceId: ID_A, productId: 'mkbqaprvrb', name: 'Kitchen robot', firmware: 'v1',
  },
  {
    deviceId: ID_B, productId: 'fjhpiem4ba', name: 'Upstairs', firmware: 'v2',
  },
  {
    deviceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', productId: 'hEA7OEshlx', name: 'Office', firmware: 'v3',
  },
];

test('account robots are grouped for the model being paired', () => {
  const entries = cloudPairEntries(robots, FLOW_2, [], []);

  assert.deepStrictEqual(entries.map((e) => [e.name, e.group, e.modelName]), [
    ['Kitchen robot', 'match', 'Narwal Flow 2'],
    ['Upstairs', 'other', 'Narwal Freo 20'],
    ['Office', 'unsupported', 'Freo Z Ultra'],
  ]);
});

test('a robot already added is marked by its device id', () => {
  const entries = cloudPairEntries(robots, FLOW_2, [ID_A, 'narwal_flow_2-10.0.0.9-9002'], []);

  assert.strictEqual(entries[0].added, true);
  assert.strictEqual(entries[1].added, false);
});

test('the local IP is filled in when the robot was seen on the network', () => {
  const entries = cloudPairEntries(robots, FLOW_2, [], [{ suffix: 'ab7721', ip: '10.0.0.2' }]);

  assert.strictEqual(entries[0].ip, '10.0.0.2');
  assert.strictEqual(entries[1].ip, '');
});

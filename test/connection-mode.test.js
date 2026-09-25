'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { chooseConnection } = require('../lib/cloud/connectionMode');

const account = { signedIn: true };
const DEVICE = '0123456789abcdef0123456789abcdef';

test('local is the default and needs nothing from the cloud', () => {
  assert.deepStrictEqual(chooseConnection({
    mode: undefined, account: null, deviceId: '', ip: '10.0.0.5',
  }), { mode: 'local' });
  assert.deepStrictEqual(chooseConnection({
    mode: 'local', account, deviceId: DEVICE, ip: '10.0.0.5',
  }), { mode: 'local' });
});

test('local mode without an IP address asks for one instead of connecting', () => {
  // A robot added through the cloud that the network search never saw.
  assert.match(chooseConnection({
    mode: 'local', account, deviceId: DEVICE, ip: '',
  }).error, /IP address/);
  assert.match(chooseConnection({
    mode: 'local', account, deviceId: DEVICE, ip: '  ',
  }).error, /IP address/);
});

test('cloud mode uses the signed-in account', () => {
  assert.deepStrictEqual(chooseConnection({ mode: 'cloud', account, deviceId: DEVICE }), { mode: 'cloud', cloud: { account } });
});

test('cloud mode explains what is missing instead of connecting', () => {
  assert.match(chooseConnection({ mode: 'cloud', account: null, deviceId: DEVICE }).error, /Sign in/);
  assert.match(chooseConnection({ mode: 'cloud', account: { signedIn: false }, deviceId: DEVICE }).error, /Sign in/);
  assert.match(chooseConnection({ mode: 'cloud', account, deviceId: '' }).error, /device ID/);
});

test('mock mode always stays local', () => {
  assert.deepStrictEqual(chooseConnection({
    mode: 'cloud', account, deviceId: DEVICE, mock: true,
  }), { mode: 'local' });
  assert.deepStrictEqual(chooseConnection({ mode: 'local', mock: true, ip: '' }), { mode: 'local' });
});

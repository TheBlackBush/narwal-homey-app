'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');

const { NarwalClient } = require('../lib/NarwalClient');
const { RobotState, FanSpeed } = require('../lib/constants');

function mockClient() {
  return new NarwalClient({ ip: '127.0.0.1', mock: true, pollInterval: 60000 });
}

test('client connects to the mock robot and emits initial status', async () => {
  const client = mockClient();
  client.start();
  const [status] = await once(client, 'status');
  assert.strictEqual(status.state, RobotState.DOCKED);
  assert.strictEqual(status.battery, 100);
  assert.strictEqual(status.charging, true);
  client.stop();
});

test('start/pause/resume/stop drive the mock robot state', async () => {
  const client = mockClient();
  client.start();
  await once(client, 'connected');

  await client.startClean();
  let status = await client.refreshStatus();
  assert.strictEqual(status.state, RobotState.CLEANING);

  await client.pauseClean();
  status = await client.refreshStatus();
  assert.strictEqual(status.state, RobotState.PAUSED);

  await client.resumeClean();
  status = await client.refreshStatus();
  assert.strictEqual(status.state, RobotState.CLEANING);

  await client.stopClean();
  status = await client.refreshStatus();
  assert.strictEqual(status.state, RobotState.IDLE);

  client.stop();
});

test('setFanSpeed is reflected in subsequent status', async () => {
  const client = mockClient();
  client.start();
  await once(client, 'connected');

  await client.setFanSpeed(FanSpeed.MAX);
  const status = await client.refreshStatus();
  assert.strictEqual(status.fanSpeed, FanSpeed.MAX);
  client.stop();
});

test('room discovery returns the mock rooms', async () => {
  const client = mockClient();
  client.start();
  await once(client, 'connected');

  const rooms = await client.refreshRooms();
  assert.strictEqual(rooms.length, 3);
  assert.deepStrictEqual(rooms.map((r) => r.name), ['Living Room', 'Kitchen', 'Bedroom']);
  client.stop();
});

test('map refresh parses a usable map', async () => {
  const client = mockClient();
  client.start();
  await once(client, 'connected');

  const map = await client.refreshMap();
  assert.ok(map);
  assert.strictEqual(map.rooms.length, 3);
  assert.ok(map.robot && map.dock);
  client.stop();
});

test('commands reject when not connected', async () => {
  const client = mockClient();
  await assert.rejects(() => client.startClean(), /Not connected/);
});

test('probe resolves with a status for a reachable (mock) robot', async () => {
  const status = await NarwalClient.probe({ ip: '127.0.0.1', mock: true });
  assert.ok(status);
  assert.strictEqual(status.firmware, '1.0.0-mock');
});

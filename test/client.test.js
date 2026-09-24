'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');

const { NarwalClient } = require('../lib/NarwalClient');
const C = require('../lib/constants');
const { decodeProto, parseFrame } = require('../lib/NarwalBinaryProtocol');

const { RobotState, FanSpeed } = C;

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

function binaryClientWithFakeSocket() {
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'QxMSPG6VSO', pollInterval: 60000 });
  const sent = [];
  client._ws = {
    readyState: 1, // WebSocket.OPEN
    send: (frame) => sent.push(parseFrame(frame)),
    ping: () => {},
    removeAllListeners: () => {},
    terminate: () => {},
  };
  return { client, sent };
}

test('binary client sends suction level 1 to 4 when setting fan speed', async () => {
  const { client, sent } = binaryClientWithFakeSocket();

  const pending = client.setFanSpeed(FanSpeed.QUIET);
  await new Promise((resolve) => setImmediate(resolve));
  client.stop();
  await assert.rejects(pending);

  const frame = sent.find((f) => f.shortTopic === 'clean/set_fan_level');
  assert.ok(frame, 'set_fan_level frame should be sent');
  assert.deepStrictEqual(decodeProto(frame.payload), { 1: 1 });
});

test('binary client renews the broadcast subscription on its own timer', () => {
  test.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, sent } = binaryClientWithFakeSocket();
  try {
    client._onOpen();
    test.mock.timers.tick(1000);
    sent.length = 0;

    test.mock.timers.tick(C.SUBSCRIPTION_RENEW_MS);

    const topics = sent.map((f) => f.shortTopic);
    assert.ok(topics.includes('common/active_robot_publish'), 'subscription should be renewed');
    assert.ok(!topics.includes('common/notify_app_event'), 'renewal should not be a full wake burst');
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

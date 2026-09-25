'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const net = require('node:net');

const { NarwalClient } = require('../lib/NarwalClient');
const C = require('../lib/constants');
const { NarwalBinaryProtocol, decodeProto, parseFrame } = require('../lib/NarwalBinaryProtocol');

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
  client.lastStatus = { state: RobotState.CLEANING, docked: false };

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

test('binary start refuses to fall back to the stored-plan command when no map is available', async () => {
  const { client, sent } = binaryClientWithFakeSocket();
  client.refreshMap = async () => null;

  const pending = client.startClean();
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const topics = sent.map((f) => f.shortTopic);
  client.stop();

  assert.ok(!topics.includes('clean/plan/start'), 'clean/plan/start can report success without cleaning');
  await assert.rejects(pending, /map/i);
});

function pollOnce(client) {
  client._connected = true;
  client._lastMessageAt = 0;
  client._startPolling();
  test.mock.timers.tick(client.pollIntervalMs);
}

test('binary poll of a quiet docked robot only asks for base status', () => {
  test.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, sent } = binaryClientWithFakeSocket();
  try {
    client.lastStatus = { docked: true, state: RobotState.DOCKED };
    pollOnce(client);

    const topics = sent.map((f) => f.shortTopic);
    assert.ok(topics.includes('status/get_device_base_status'), 'poll should request base status');
    assert.ok(!topics.includes('common/notify_app_event'), 'docked poll should not send a wake burst');
    assert.ok(!topics.includes('common/get_device_info'), 'docked poll should not rerun discovery');
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

test('binary poll of a silent robot off the dock still sends a wake burst', () => {
  test.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, sent } = binaryClientWithFakeSocket();
  try {
    client.lastStatus = { docked: false, state: RobotState.CLEANING };
    pollOnce(client);

    assert.ok(sent.some((f) => f.shortTopic === 'common/notify_app_event'), 'off-dock silence should wake the robot');
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

function startCleanFanLevel(frame) {
  // CleanTask (1) > item (2) > CleanParam (2) > suction (2)
  const task = decodeProto(frame.payload)['1'];
  const item = Array.isArray(task['2']) ? task['2'][0] : task['2'];
  return decodeProto(Buffer.from(item['2'].slice(2), 'hex'))['2'];
}

async function sentFramesFor(client, sent, action) {
  const pending = action();
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  client.stop();
  await pending.catch(() => {});
  return sent;
}

test('binary client saves fan speed for the next clean while docked instead of sending it', async () => {
  const { client, sent } = binaryClientWithFakeSocket();
  client.lastStatus = { state: RobotState.DOCKED, docked: true };

  await client.setFanSpeed(FanSpeed.ULTRA);

  assert.ok(!sent.some((f) => f.shortTopic === 'clean/set_fan_level'), 'docked robots reject set_fan_level');
  assert.strictEqual(client.fanSpeed, FanSpeed.ULTRA);
});

test('binary start carries the chosen suction level, including Ultra Powerful', async () => {
  const { client, sent } = binaryClientWithFakeSocket();
  client.lastStatus = { state: RobotState.DOCKED, docked: true };
  client.lastMap = { meta: { mapId: 7 }, rooms: [{ id: '1' }, { id: '2' }] };
  await client.setFanSpeed(FanSpeed.ULTRA);

  await sentFramesFor(client, sent, () => client.startClean());

  const frame = sent.find((f) => f.shortTopic === 'clean/start_clean');
  assert.ok(frame, 'start_clean frame should be sent');
  assert.strictEqual(startCleanFanLevel(frame), 5);
});

test('binary live fan change maps Ultra Powerful to the highest live level', async () => {
  const { client, sent } = binaryClientWithFakeSocket();
  client.lastStatus = { state: RobotState.CLEANING, docked: false };

  await sentFramesFor(client, sent, () => client.setFanSpeed(FanSpeed.ULTRA));

  const frame = sent.find((f) => f.shortTopic === 'clean/set_fan_level');
  assert.deepStrictEqual(decodeProto(frame.payload), { 1: 4 });
});

test('binary client treats Ultra Powerful as Super Powerful on the Freo Z10 Pro / Turbo', async () => {
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'qV6BujoYLz' });
  client.lastStatus = { state: RobotState.DOCKED, docked: true };

  await client.setFanSpeed(FanSpeed.ULTRA);

  assert.strictEqual(client.fanSpeed, FanSpeed.MAX);
  client.stop();
});

test('binary status reports keep a fan speed saved while docked until the next clean', async () => {
  const { client } = binaryClientWithFakeSocket();
  client.lastStatus = { state: RobotState.DOCKED, docked: true };
  await client.setFanSpeed(FanSpeed.QUIET);

  const docked = client._ingestBinaryStatus({ shortTopic: 'status/robot_base_status', decoded: { 3: { 1: 10 }, 26: 2 } });
  assert.strictEqual(docked.fanSpeed, FanSpeed.QUIET);

  const cleaning = client._ingestBinaryStatus({ shortTopic: 'status/robot_base_status', decoded: { 3: { 1: 4 }, 26: 3 } });
  assert.strictEqual(cleaning.fanSpeed, FanSpeed.STRONG, 'once cleaning, the robot reports the level in use');
  client.stop();
});

test('binary start and room cleans send the clean options they are given', async () => {
  for (const run of [
    (client) => client.startClean({ workMode: 2, water: 3, route: 2 }),
    (client) => client.cleanRoom(['1'], { workMode: 2, water: 3, route: 2 }),
  ]) {
    const { client, sent } = binaryClientWithFakeSocket();
    client.lastStatus = { state: RobotState.DOCKED, docked: true };
    client.lastMap = { meta: { mapId: 7 }, rooms: [{ id: '1' }] };

    await sentFramesFor(client, sent, () => run(client));

    const frame = sent.find((f) => f.shortTopic === 'clean/start_clean');
    const task = decodeProto(frame.payload)['1'];
    const item = Array.isArray(task['2']) ? task['2'][0] : task['2'];
    const param = decodeProto(Buffer.from(item['2'].slice(2), 'hex'));
    assert.strictEqual(task['5'], 2);
    assert.strictEqual(param['4'], 3);
    assert.strictEqual(param['8'], 2);
  }
});

test('binary clean option suction overrides the saved fan speed for that run only', async () => {
  const { client, sent } = binaryClientWithFakeSocket();
  client.lastStatus = { state: RobotState.DOCKED, docked: true };
  client.lastMap = { meta: { mapId: 7 }, rooms: [{ id: '1' }] };
  await client.setFanSpeed(FanSpeed.QUIET);

  await sentFramesFor(client, sent, () => client.cleanRoom(['1'], { fanSpeed: FanSpeed.ULTRA }));

  const frame = sent.find((f) => f.shortTopic === 'clean/start_clean');
  assert.strictEqual(startCleanFanLevel(frame), 5);
  assert.strictEqual(client.fanSpeed, FanSpeed.QUIET);
});

test('binary progress messages sent while docking do not flip a docked robot back to cleaning', () => {
  // Order recorded from a Flow 2 (v01.09.10.02) arriving at the dock.
  const { client } = binaryClientWithFakeSocket();
  const base = (f3, f11, f47) => client._ingestBinaryStatus({
    shortTopic: 'status/robot_base_status', decoded: { 3: f3, 11: f11, 47: f47 },
  });
  const progress = (decoded) => client._ingestBinaryStatus({ shortTopic: 'status/working_status', decoded });

  base({ 1: 2, 4: 6 }, 1, 2);
  let status = progress({ 2: 5.8001, 3: 660, 6: 3 });
  assert.strictEqual(status.state, RobotState.CLEANING, 'off the dock the robot is cleaning');

  base({ 1: 2, 4: 6 }, 3, 1);
  status = progress({ 2: 5.8001, 3: 660, 6: 3 });
  assert.strictEqual(status.state, RobotState.DOCKED);
  assert.strictEqual(status.docked, true);
  assert.strictEqual(status.currentRoomId, null);
  assert.strictEqual(status.cleanArea, 5.8, 'final metrics are still recorded');

  base({ 1: 19, 2: 1, 18: 4 }, 3, 1);
  status = progress({ 6: 3, 13: 18000 });
  assert.strictEqual(status.state, RobotState.DOCKED);
  client.stop();
});

test('binary progress message with only a room id is not evidence of cleaning', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 6: 3, 13: 18000 }, 'status/working_status');

  assert.notStrictEqual(status.state, RobotState.CLEANING);
});

// Sequences from the Home Assistant integration's state tests, which cover
// firmware that sends partial base status messages (Freo Z10 Ultra, #98).
function ingestBase(client, packets) {
  let status;
  for (const decoded of packets) status = client._ingestBinaryStatus({ shortTopic: 'status/robot_base_status', decoded });
  return status;
}

test('binary dock presence 1 or 6 counts as docked, so a finished task is not stuck on returning', () => {
  for (const presence of [1, 6]) {
    const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'DrzDKQ0MU8' });
    const status = ingestBase(client, [{ 3: { 1: 19, 3: presence } }]);
    assert.strictEqual(status.docked, true, `presence ${presence}`);
    assert.strictEqual(status.state, RobotState.DOCKED, `presence ${presence}`);
    client.stop();
  }
});

test('binary partial base status messages keep the known dock state', () => {
  const f80 = (() => {
    const b = Buffer.alloc(4); b.writeFloatLE(80); return b.readUInt32LE(0);
  })();
  const cases = [
    ['battery only', [{ 3: { 1: 19, 3: 6 } }, { 2: f80 }]],
    ['repeated task finished without dock fields', [{ 3: { 1: 19, 3: 6 } }, { 3: { 1: 19, 12: 0 } }]],
  ];
  for (const [name, packets] of cases) {
    const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'DrzDKQ0MU8' });
    const status = ingestBase(client, packets);
    assert.strictEqual(status.docked, true, name);
    assert.strictEqual(status.state, RobotState.DOCKED, name);
    client.stop();
  }
});

test('binary dock-only base status moves a returning robot to docked', () => {
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'DrzDKQ0MU8' });

  const status = ingestBase(client, [{ 3: { 1: 19, 3: 2, 10: 2 } }, { 11: 2, 47: 3 }]);

  assert.strictEqual(status.docked, true);
  assert.strictEqual(status.state, RobotState.DOCKED);
  client.stop();
});

test('binary robot leaving the dock with a stale docked code is not shown as docked', () => {
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'DrzDKQ0MU8' });

  const status = ingestBase(client, [{ 3: { 1: 10, 10: 1 }, 11: 2, 47: 3 }, { 3: { 1: 10 }, 11: 1 }]);

  assert.strictEqual(status.docked, false);
  assert.notStrictEqual(status.state, RobotState.DOCKED);
  client.stop();
});

test('probe gives up after timeoutMs when a robot accepts but never answers', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const startedAt = Date.now();
  try {
    await assert.rejects(NarwalClient.probe({ ip: '127.0.0.1', port, timeoutMs: 300 }), /timed out/i);
    assert.ok(Date.now() - startedAt < 3000, 'probe should honour timeoutMs');
  } finally {
    server.close();
  }
});

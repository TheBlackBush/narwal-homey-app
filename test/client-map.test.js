'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { NarwalClient } = require('../lib/NarwalClient');
const C = require('../lib/constants');
const { buildFrame, parseFrame, FIELD_RESPONSE } = require('../lib/NarwalBinaryProtocol');

// Minimal protobuf writer (signed ints included).
function varint(value) {
  let v = BigInt.asUintN(64, BigInt(value));
  const out = [];
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const num = (field, value) => Buffer.concat([key(field, 0), varint(value)]);
const raw = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const packed = (field, values) => raw(field, Buffer.concat(values.map(varint)));

const W = 2;
const H = 2;
function getMapReply(seqId = 10) {
  const map = Buffer.concat([
    num(1, 7), num(3, 60), num(4, W), num(5, H),
    raw(6, Buffer.concat([num(1, -1), num(2, 0), num(3, 0), num(4, 1)])),
    raw(12, Buffer.concat([num(1, 1), num(2, 6), num(8, 1)])),
    raw(12, Buffer.concat([num(1, 2), num(2, 6), num(8, 2)])),
    raw(17, zlib.deflateSync(packed(1, [0x20, 0x20, 0x0101, 0x0201]))),
    num(22, seqId),
  ]);
  return Buffer.concat([num(1, 1), raw(2, map)]);
}

function displayMap(startSeqId, currentSeqId, cells) {
  const grid = Buffer.concat([packed(1, cells.map((c) => c[0])), packed(2, cells.map((c) => c[1]))]);
  return raw(7, Buffer.concat([num(1, startSeqId), num(2, currentSeqId), raw(3, zlib.deflateSync(grid))]));
}

const PK = 'QxMSPG6VSO';
const DEV = 'dev';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function robotClient() {
  const client = new NarwalClient({
    ip: '127.0.0.1', productKey: PK, deviceId: DEV, pollInterval: 60000,
  });
  client.sent = [];
  client._ws = {
    readyState: 1,
    send: (frame) => client.sent.push(parseFrame(frame).shortTopic),
    ping() {},
    removeAllListeners() {},
    terminate() {},
    on() {},
  };
  client.receive = (short, payload, response = false) => {
    const frame = buildFrame(`/${PK}/${DEV}/${short}`, payload);
    if (response) frame[2] = FIELD_RESPONSE;
    client._onMessage(frame);
  };
  return client;
}

async function replyWithMap(client, seqId) {
  await tick();
  client.receive('map/get_map', getMapReply(seqId), true);
  await tick();
  await tick();
}

test('the map is requested once the robot first answers, and decoded with official names', async () => {
  const client = robotClient();
  const maps = [];
  client.on('map', (m) => maps.push(m));

  client.receive('status/robot_base_status', Buffer.alloc(0)); // first answer
  await tick();
  assert.ok(client.sent.includes('map/get_map'), 'map requested');
  await replyWithMap(client, 10);

  assert.strictEqual(maps.length, 1);
  assert.deepStrictEqual(maps[0].rooms.map((r) => r.name), ['Toilet1', 'Toilet2']);
  assert.strictEqual(maps[0].grid.length, W * H);
  client.stop();
});

test('live map updates apply in sequence and a gap fetches the map again, at most every 10 s', async () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const client = robotClient();
  const lives = [];
  client.on('live', (l) => lives.push(l));
  try {
    client.receive('status/robot_base_status', Buffer.alloc(0));
    await replyWithMap(client, 10);
    const requests = () => client.sent.filter((t) => t === 'map/get_map').length;
    assert.strictEqual(requests(), 1);

    client.receive('map/display_map', displayMap(11, 12, [[0, 0x0105]]));
    assert.strictEqual(lives.length, 1, 'live data emitted');
    assert.strictEqual(client.lastStaticMap.grid[0], 0x0105, 'update applied');
    assert.strictEqual(client.lastStaticMap.seqId, 12);

    test.mock.timers.tick(C.MAP_REFETCH_GUARD_MS); // the connect fetch's window is over
    client.receive('map/display_map', displayMap(20, 21, [])); // gap
    client.receive('map/display_map', displayMap(22, 23, [])); // gap again within 10 s
    await tick();
    assert.strictEqual(requests(), 2, 'one refetch for the gap');

    await replyWithMap(client, 25); // the robot answers the refetch
    test.mock.timers.tick(C.MAP_REFETCH_GUARD_MS);
    client.receive('map/display_map', displayMap(30, 31, []));
    await tick();
    assert.strictEqual(requests(), 3, 'guard window over');
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

test('a display_map never replaces the static map', async () => {
  const client = robotClient();
  const maps = [];
  client.on('map', (m) => maps.push(m));
  client.receive('status/robot_base_status', Buffer.alloc(0));
  await replyWithMap(client, 10);

  client.receive('map/display_map', Buffer.concat([raw(12, Buffer.concat([num(1, 5)]))]));

  assert.strictEqual(maps.length, 1);
  assert.deepStrictEqual(client.lastMap.rooms.map((r) => r.name), ['Toilet1', 'Toilet2']);
  client.stop();
});

test('a change in the working state fetches the map again (after the guard window)', async () => {
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const client = robotClient();
  try {
    client.receive('status/robot_base_status', Buffer.alloc(0));
    await replyWithMap(client, 10);
    const requests = () => client.sent.filter((t) => t === 'map/get_map').length;
    test.mock.timers.tick(C.MAP_REFETCH_GUARD_MS);

    client.lastStatus = { ...client.lastStatus, state: C.RobotState.DOCKED };
    client._noteStateChange(C.RobotState.DOCKED, C.RobotState.CLEANING);
    await tick();
    assert.strictEqual(requests(), 2);

    client._noteStateChange(C.RobotState.CLEANING, C.RobotState.CLEANING);
    await tick();
    assert.strictEqual(requests(), 2, 'same state: nothing to fetch');
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

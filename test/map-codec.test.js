'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const {
  decodeGetMapResponse, decodeDisplayMap, applyIncrementalUpdate, roomDisplayNames, classifyCell,
} = require('../lib/NarwalMapCodec');

// ---- A tiny protobuf writer for test messages (signed ints included) ----

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
const str = (field, s) => raw(field, Buffer.from(s, 'utf8'));
const f32 = (field, value) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return Buffer.concat([key(field, 5), b]);
};
const msg = (...parts) => Buffer.concat(parts);
const packed = (field, values) => raw(field, Buffer.concat(values.map(varint)));
const packedFloat = (field, values) => raw(field, Buffer.concat(values.map((v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b;
})));
const pose = (field, x, y, theta) => raw(field, msg(raw(1, msg(f32(1, x), f32(2, y))), f32(2, theta)));

// 4 x 3 map, raw row 0 at the bottom: a wall row, two rooms, outside cells.
const W = 4;
const H = 3;
const GRID = [
  0x20, 0x20, 0x20, 0x20, //   bottom row: wall
  0x0101, 0x0111, 0x0201, 0, // room 1, room 1 edge, room 2, outside
  0x10301, 0x0204, 0x2028, 0, // room 3 with clean level 1, room 2 cleaned, a wall with high bits, outside
];

function staticMap({ rooms, grid = GRID, compressed = true } = {}) {
  const gridMsg = packed(1, grid);
  return msg(
    num(1, 7), // map id
    num(2, 3), // map version
    num(3, 60), // resolution
    num(4, W),
    num(5, H),
    raw(6, msg(num(1, -1), num(2, 1), num(3, -2), num(4, 1))), // border: bottom -1, top 1, left -2, right 1
    pose(8, 0.5, -1, 1.5), // dock, raw coordinates
    ...rooms.map((r) => raw(12, r)),
    compressed ? raw(17, zlib.deflateSync(gridMsg)) : raw(16, gridMsg),
    num(22, 40), // seq id
    num(25, 90), // rotate angle
    num(33, 5), // edit version
    num(34, 1790000000000), // generated at
  );
}

const room = (id, type, { name, texture = 2, roomTypeId } = {}) => msg(
  num(1, id),
  num(2, type),
  name ? str(3, name) : Buffer.alloc(0),
  num(4, texture),
  roomTypeId ? num(8, roomTypeId) : Buffer.alloc(0),
);

const response = (map) => msg(num(1, 1), raw(2, map));

test('a get_map response decodes the official StaticMapPayload fields, signed border included', () => {
  const map = decodeGetMapResponse(response(staticMap({ rooms: [room(1, 3), room(2, 4)] })));

  assert.strictEqual(map.mapId, 7);
  assert.strictEqual(map.resolution, 60);
  assert.deepStrictEqual([map.width, map.height], [W, H]);
  assert.deepStrictEqual(map.border, {
    bottom: -1, top: 1, left: -2, right: 1,
  });
  assert.strictEqual(map.seqId, 40);
  assert.strictEqual(map.rotateAngle, 90);
  assert.strictEqual(map.editVersion, 5);
  assert.strictEqual(map.generatedAt, 1790000000000);
  assert.deepStrictEqual(map.grid, GRID);
});

test('the dock is converted to cells relative to the border', () => {
  const map = decodeGetMapResponse(response(staticMap({ rooms: [] })));

  // column = x - left, row from the bottom = y - bottom
  assert.deepStrictEqual(map.station, { x: 2.5, y: 0, theta: 1.5 });
});

test('the grid decodes from the uncompressed MapData field too', () => {
  const map = decodeGetMapResponse(response(staticMap({ rooms: [], compressed: false })));
  assert.deepStrictEqual(map.grid, GRID);
});

test('a grid with the wrong number of cells is an error, not a garbled map', () => {
  assert.throws(() => decodeGetMapResponse(response(staticMap({ rooms: [], grid: [1, 2, 3] }))), /cells/);
});

test('custom room names keep any script, Hebrew included', () => {
  const map = decodeGetMapResponse(response(staticMap({ rooms: [room(3, 0, { name: 'סלון' })] })));
  assert.strictEqual(map.rooms[0].name, 'סלון');
  assert.strictEqual(map.rooms[0].texture, 2);
});

test('room names follow the official rule: repeated types are all numbered, with no space', () => {
  const rooms = [
    { id: 1, type: 3 },
    { id: 7, type: 6, roomTypeId: 1 },
    { id: 8, type: 6, roomTypeId: 2 },
    { id: 9, type: 6, roomTypeId: 3 },
    { id: 3, type: 0, customName: 'Office' },
    { id: 4, type: 1 },
    { id: 5, type: 4 },
    { id: 6, type: 4 }, // no roomTypeId: numbered by position
  ];

  const names = roomDisplayNames(rooms);

  assert.deepStrictEqual(Object.fromEntries(names), {
    1: 'Living Room', 3: 'Office', 4: 'Master Bedroom', 5: 'Kitchen1', 6: 'Kitchen2', 7: 'Toilet1', 8: 'Toilet2', 9: 'Toilet3',
  });
});

test('cells are read as the official app reads them', () => {
  assert.deepStrictEqual(classifyCell(0), { kind: 'outside' });
  assert.deepStrictEqual(classifyCell(0x20), { kind: 'wall' });
  assert.deepStrictEqual(classifyCell(0x2028), { kind: 'wall' });
  assert.strictEqual(classifyCell(0x0111).roomId, 1);
  assert.strictEqual(classifyCell(0x0111).edge, true);
  assert.strictEqual(classifyCell(0x0204).cleaned, true);
  // Clean and dirt levels live above bit 16 and must not change the room id.
  assert.deepStrictEqual(classifyCell(0x210301), {
    kind: 'room', roomId: 3, edge: false, cleaned: false, cleanLevel: 1, dirtLevel: 2,
  });
});

function displayMap({
  startSeqId = 41, currentSeqId = 42, cells = [[5, 0x0105]], gzip = false,
} = {}) {
  const gridData = msg(packed(1, cells.map((c) => c[0])), packed(2, cells.map((c) => c[1])));
  const compressed = gzip ? zlib.gzipSync(gridData) : zlib.deflateSync(gridData);
  return msg(
    pose(1, 1.25, -0.5, 3.1),
    raw(2, msg(packedFloat(1, [1, 1.1, 1.2]), packedFloat(2, [-0.5, -0.4, -0.3]))),
    num(4, 2),
    pose(5, 0.5, -1, 1.5),
    num(6, 2),
    raw(7, msg(num(1, startSeqId), num(2, currentSeqId), raw(3, compressed))),
    num(10, 1790000001234),
  );
}

test('a display_map broadcast gives the robot pose, the trail and the map update', () => {
  const live = decodeDisplayMap(displayMap({ gzip: true }));

  assert.deepStrictEqual(live.robot, { x: 1.25, y: -0.5, theta: live.robot.theta });
  assert.ok(Math.abs(live.robot.theta - 3.1) < 1e-6);
  assert.strictEqual(live.trail.length, 3);
  assert.strictEqual(live.currentZoneId, 2);
  assert.strictEqual(live.mapType, 2);
  assert.strictEqual(live.poseTime, 1790000001234);
  assert.strictEqual(live.lostPosition, false);
  assert.deepStrictEqual(live.incremental, { startSeqId: 41, currentSeqId: 42, cells: [[5, 0x0105]] });
});

test('a pose of (0, 0) with no time means the robot lost its position', () => {
  const live = decodeDisplayMap(msg(pose(1, 0, 0, 0)));
  assert.strictEqual(live.lostPosition, true);
});

test('map updates apply in sequence; gaps ask for a new map and old updates are dropped', () => {
  const map = decodeGetMapResponse(response(staticMap({ rooms: [] }))); // seq 40

  assert.strictEqual(applyIncrementalUpdate(map, decodeDisplayMap(displayMap()).incremental), 'applied');
  assert.strictEqual(map.grid[5], 0x0105);
  assert.strictEqual(map.seqId, 42);

  assert.strictEqual(applyIncrementalUpdate(map, { startSeqId: 40, currentSeqId: 42, cells: [] }), 'stale');
  assert.strictEqual(applyIncrementalUpdate(map, { startSeqId: 45, currentSeqId: 46, cells: [] }), 'gap');
  assert.strictEqual(applyIncrementalUpdate(null, { startSeqId: 1, currentSeqId: 2, cells: [] }), 'gap');
});

test('truncated messages are errors, not short values', () => {
  const full = response(staticMap({ rooms: [room(1, 3)] }));
  assert.throws(() => decodeGetMapResponse(full.subarray(0, full.length - 5)), /truncated/);
});

test('the app map built from a static map uses official names, the dock in cells, and the grid', () => {
  const { MapParser } = require('../lib/MapParser'); // eslint-disable-line global-require
  const s = decodeGetMapResponse(response(staticMap({ rooms: [room(1, 6, { roomTypeId: 1 }), room(2, 6, { roomTypeId: 2 }), room(3, 0, { name: 'Office' })] })));

  const map = MapParser.fromStaticMap(s, 123, 'QxMSPG6VSO');

  assert.deepStrictEqual(map.rooms.map((r) => [r.id, r.name, r.type]), [['1', 'Toilet1', 6], ['2', 'Toilet2', 6], ['3', 'Office', 0]]);
  assert.deepStrictEqual(map.dock, { x: 2.5, y: 0, theta: 1.5 });
  assert.strictEqual(map.grid.length, W * H);
  assert.strictEqual(map.meta.mapId, 7);
  assert.strictEqual(map.meta.seqId, 40);
  assert.strictEqual(map.meta.createdAt, 1790000000000);
  assert.strictEqual(map.updatedAt, 123);
});

test('rendering reads walls and masked room ids like the official app', () => {
  const { MapParser } = require('../lib/MapParser'); // eslint-disable-line global-require
  const s = decodeGetMapResponse(response(staticMap({ rooms: [room(1, 3), room(2, 4), room(3, 5)] })));
  const render = MapParser.toRenderData(MapParser.fromStaticMap(s, 1), { cropPadding: 0 });
  const px = Buffer.from(render.pixels, 'base64');
  // Display row 0 is the top (raw row 2); the bottom display row is the wall row.
  const at = (x, y) => [...px.subarray((y * render.width + x) * 4, (y * render.width + x) * 4 + 4)];
  const wall = at(0, 2);
  const room3 = at(0, 0); // 0x10301: room 3 despite the clean-level bits
  const room1 = at(0, 1);

  assert.deepStrictEqual(at(1, 0), at(2, 1), 'both room 2 cells share a colour');
  assert.notDeepStrictEqual(room3, room1);
  assert.strictEqual(wall[3], 255);
  assert.deepStrictEqual(at(2, 0), wall, 'the 0x2028 cell is a wall');
  assert.deepStrictEqual(render.roomLabels.map((l) => l.id).sort(), ['1', '2', '3']);
});

test('a room label sits inside its room even when the centroid does not', () => {
  const { MapParser } = require('../lib/MapParser'); // eslint-disable-line global-require
  // An L-shaped room 1 (the centroid falls in room 2's corner cell).
  const grid = [
    0x0101, 0x0201, 0x0201,
    0x0101, 0x0201, 0x0201,
    0x0101, 0x0101, 0x0101,
  ];
  const map = MapParser.fromStaticMap({
    width: 3, height: 3, grid, rooms: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], station: null,
  }, 1);
  const render = MapParser.toRenderData(map, { cropPadding: 0 });
  const label = render.roomLabels.find((l) => l.id === '1');
  const cellId = (x, y) => (grid[(2 - y) * 3 + x] >> 8) & 0xff; // display row 0 is raw row 2

  assert.strictEqual(cellId(label.x, label.y), 1);
});

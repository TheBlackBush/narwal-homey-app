'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { MapParser } = require('../lib/MapParser');
const { buildMockMap } = require('../lib/MockSocket');

function encodeVarint(value) {
  const bytes = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return bytes;
}

function buildCompressedPixelMap(values) {
  const packed = Buffer.from(values.flatMap(encodeVarint));
  const wrapped = Buffer.from([0x0a, ...encodeVarint(packed.length), ...packed]);
  return `0x${zlib.deflateSync(wrapped).toString('hex')}`;
}

test('parseRooms extracts ids and names from varied field shapes', () => {
  const rooms = MapParser.parseRooms({
    rooms: [
      { id: 1, name: 'Living Room' },
      { roomId: 2, label: 'Kitchen' },
      { segmentId: 3 },
    ],
  });
  assert.strictEqual(rooms.length, 3);
  assert.deepStrictEqual(rooms[0], {
    id: '1', name: 'Living Room', color: null, outline: [],
  });
  assert.strictEqual(rooms[1].name, 'Kitchen');
  assert.strictEqual(rooms[2].name, 'Room 3');
});

test('parseRooms tolerates missing/garbage payloads', () => {
  assert.deepStrictEqual(MapParser.parseRooms(null), []);
  assert.deepStrictEqual(MapParser.parseRooms({}), []);
  assert.deepStrictEqual(MapParser.parseRooms({ rooms: 'nope' }), []);
});

test('parse returns null when there is nothing usable', () => {
  assert.strictEqual(MapParser.parse(null), null);
  assert.strictEqual(MapParser.parse({}), null);
});

test('parse extracts rooms, robot, dock, trail and obstacles', () => {
  const map = MapParser.parse(buildMockMap(), 12345);
  assert.strictEqual(map.rooms.length, 3);
  assert.deepStrictEqual(map.robot, { x: 40, y: 40 });
  assert.deepStrictEqual(map.dock, { x: 5, y: 5 });
  assert.strictEqual(map.trail.length, 3);
  assert.strictEqual(map.obstacles.length, 1);
  assert.strictEqual(map.obstacles[0].type, 'chair');
  assert.strictEqual(map.updatedAt, 12345);
});

test('computeBounds returns extents over points', () => {
  const b = MapParser.computeBounds([{ x: -5, y: 2 }, { x: 10, y: -3 }, { x: 4, y: 8 }]);
  assert.deepStrictEqual(b, {
    minX: -5, minY: -3, maxX: 10, maxY: 8,
  });
});

test('toSVG renders a placeholder when no map and a snapshot otherwise', () => {
  const empty = MapParser.toSVG(null);
  assert.match(empty, /No map available/);

  const svg = MapParser.toSVG(MapParser.parse(buildMockMap()));
  assert.match(svg, /^<svg/);
  assert.match(svg, /Living Room/);
  assert.match(svg, /polygon/);
  assert.match(svg, /<\/svg>$/);
});

test('toSVG escapes room names', () => {
  const map = MapParser.parse({
    rooms: [{ id: 1, name: '<Kids> & "Play"', outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
  });
  const svg = MapParser.toSVG(map);
  assert.match(svg, /&lt;Kids&gt; &amp; &quot;Play&quot;/);
  assert.doesNotMatch(svg, /<Kids>/);
});

test('parseNarwalMapResponse extracts rooms and map metadata from get_map response', () => {
  const map = MapParser.parseNarwalMapResponse({
    1: 1,
    2: {
      3: 60,
      4: 249,
      5: 302,
      12: [
        { 1: 3, 3: 'Bedroom', 4: 2 },
        {
          1: 7, 2: 6, 4: 2, 8: 1,
        },
      ],
      17: '0x00112233',
      32: { 1: 1 },
      33: 1021,
      34: 1781858300,
    },
  }, 123);

  assert.ok(map);
  assert.strictEqual(map.rooms.length, 2);
  assert.deepStrictEqual(map.rooms.map((room) => room.name), ['Bedroom', 'Toilet']);
  assert.strictEqual(map.rooms[1].subtype, 6);
  assert.strictEqual(map.meta.mapId, 0);
  assert.strictEqual(map.meta.width, 249);
  assert.strictEqual(map.meta.height, 302);
  assert.strictEqual(map.meta.resolution, 60);
  assert.strictEqual(map.meta.compressedMapBytes, 4);
  assert.strictEqual(map.updatedAt, 123);
});

test('parse delegates Narwal numeric map payloads to the Narwal parser', () => {
  const map = MapParser.parse({ 2: { 4: 10, 5: 20, 12: [{ 1: 1 }] } }, 456);
  assert.ok(map);
  assert.strictEqual(map.rooms[0].name, 'Room');
  assert.strictEqual(map.bounds.maxX, 10);
  assert.strictEqual(map.bounds.maxY, 20);
});

test('toSVG renders Narwal rooms without geometry as room chips', () => {
  const map = MapParser.parseNarwalMapResponse({ 2: { 4: 10, 5: 20, 12: [{ 1: 1, 3: 'Office' }] } });
  const svg = MapParser.toSVG(map);
  assert.match(svg, /Office/);
  assert.match(svg, /Map 10×20/);
});

test('Narwal built-in room names are used when custom names are blank', () => {
  const map = MapParser.parseNarwalMapResponse({
    2: {
      4: 100,
      5: 100,
      3: 60,
      12: [
        { 1: 1, 2: 3, 4: 2 },
        { 1: 2, 2: 4, 4: 2 },
        {
          1: 3, 2: 5, 4: 2, 8: 2,
        },
      ],
    },
  });

  assert.deepStrictEqual(map.rooms.map((room) => room.name), ['Living Room', 'Kitchen', 'Bathroom 2']);
});

test('Narwal room types use one shared name table for every model', () => {
  const expected = [
    'Room', 'Master Bedroom', 'Secondary Bedroom', 'Living Room', 'Kitchen', 'Bathroom',
    'Toilet', 'Balcony', 'Dining Room', 'Closet', 'Corridor', 'Study', "Kids' Room",
    'Entertainment Room', 'Storage Room', 'Other',
  ];
  const rooms = expected.map((_, subtype) => ({ 1: subtype + 1, 2: subtype, 4: 2 }));

  for (const productKey of ['', 'QoEsI5qYXO', 'QxMSPG6VSO', 'fjhpiem4ba']) {
    const map = MapParser.parseNarwalMapResponse({
      2: {
        4: 100, 5: 100, 3: 60, 12: rooms,
      },
    }, 0, productKey);
    assert.deepStrictEqual(map.rooms.map((room) => room.name), expected, productKey || 'no product key');
  }
});

test('Flow 2 room type overrides match Narwal built-in names', () => {
  const map = MapParser.parseNarwalMapResponse({
    2: {
      4: 100,
      5: 100,
      3: 60,
      12: [
        { 1: 1, 2: 1, 4: 2 },
        { 1: 5, 2: 5, 4: 2 },
        { 1: 6, 2: 10, 4: 2 },
        {
          1: 9, 2: 6, 3: 'Custom Bath', 4: 2,
        },
      ],
    },
  }, 0, 'QxMSPG6VSO');

  assert.deepStrictEqual(map.rooms.map((room) => room.name), [
    'Master Bedroom',
    'Bathroom',
    'Corridor',
    'Custom Bath',
  ]);
});

test('toRenderData decodes Narwal compressed pixels into canvas payload', () => {
  const map = MapParser.parseNarwalMapResponse({
    2: {
      3: 60,
      4: 3,
      5: 2,
      12: [
        { 1: 1, 3: 'Living Room' },
        { 1: 2, 3: 'Kitchen' },
      ],
      17: buildCompressedPixelMap([
        0,
        0x20,
        0x28,
        (1 << 8) | 0x00,
        (1 << 8) | 0x10,
        (2 << 8) | 0x00,
      ]),
    },
  }, 123);

  const decoded = MapParser.decodeNarwalPixelMap(map);
  assert.strictEqual(decoded.width, 3);
  assert.strictEqual(decoded.height, 2);
  assert.deepStrictEqual(decoded.pixels, [0, 0x20, 0x28, 256, 272, 512]);

  const renderData = MapParser.toRenderData(map, { now: 999 });
  assert.strictEqual(renderData.type, 'narwal-map');
  assert.strictEqual(renderData.format, 'rgba');
  assert.strictEqual(renderData.width, 3);
  assert.strictEqual(renderData.height, 2);
  assert.strictEqual(Buffer.from(renderData.pixels, 'base64').length, 3 * 2 * 4);
  assert.deepStrictEqual(renderData.rooms.map((room) => room.name), ['Living Room', 'Kitchen']);
  assert.deepStrictEqual(renderData.roomLabels.map((label) => label.name).sort(), ['Kitchen', 'Living Room']);
  assert.strictEqual(renderData.meta.renderedAt, 999);
});

test('the SVG map scales to its box instead of being clipped', () => {
  for (const svg of [MapParser.toSVG(null), MapParser.toSVG({
    bounds: {
      minX: 0, minY: 0, maxX: 10, maxY: 10,
    },
    rooms: [],
  })]) {
    assert.match(svg, /^<svg [^>]*viewBox="0 0 640 640"/);
  }
});

test('a room colour that is not a hex colour falls back to the palette', () => {
  const outline = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  const svg = MapParser.toSVG({
    bounds: {
      minX: 0, minY: 0, maxX: 1, maxY: 1,
    },
    rooms: [
      { name: 'A', outline, color: '#12ab34' },
      { name: 'B', outline, color: '"/><script>alert(1)</script>' },
    ],
  });
  assert.ok(svg.includes('fill="#12ab34"'));
  assert.ok(!svg.includes('<script>'));
});

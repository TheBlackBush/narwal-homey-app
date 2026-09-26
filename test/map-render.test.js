'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MapParser } = require('../lib/MapParser');

// Raw grid rows run bottom-up; the render data is top-down.
function mapFrom(rows, rooms, dock = null) {
  const height = rows.length;
  const width = rows[0].length;
  const grid = [...rows].reverse().flat();
  return MapParser.fromStaticMap({
    width, height, grid, rooms: rooms.map(([id, name]) => ({ id, name })), station: dock,
  }, 5);
}

function expand(runs) {
  const out = [];
  for (let i = 0; i < runs.length; i += 2) for (let n = 0; n < runs[i + 1]; n += 1) out.push(runs[i]);
  return out;
}

const W = 0x20; // wall
const r = (id) => (id << 8) | 0x01;

// Top row first. Rooms 1 | 2 | 3 side by side, with 4 below room 1 and 2.
const ROWS = [
  [W, W, W, W, W, W, W],
  [W, r(1), r(1), r(2), r(2), r(3), W],
  [W, r(1), r(1), r(2), r(2), r(3), W],
  [W, r(4), r(4), r(4), r(4), W, W],
  [W, W, W, W, W, W, 0],
];

test('render data v2 carries cell classes top-down, compactly', () => {
  const render = MapParser.toRenderData(mapFrom(ROWS, [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']]), { cropPadding: 0 });

  assert.strictEqual(render.type, 'narwal-map');
  assert.strictEqual(render.version, 2);
  assert.deepStrictEqual([render.width, render.height], [7, 5]);
  const cells = expand(render.cells);
  assert.strictEqual(cells.length, 35);
  const code = (id) => render.rooms.find((room) => room.id === String(id)).code;
  assert.deepStrictEqual(cells.slice(0, 7), [1, 1, 1, 1, 1, 1, 1], 'top wall row');
  assert.deepStrictEqual(cells.slice(7, 14), [1, code(1), code(1), code(2), code(2), code(3), 1]);
  assert.strictEqual(cells[34], 0, 'outside');
  assert.strictEqual(render.pixels, undefined, 'no bulky pixel payload');
});

test('neighbouring rooms get different colour sets', () => {
  const render = MapParser.toRenderData(mapFrom(ROWS, [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']]), { cropPadding: 0 });
  const color = (id) => render.rooms.find((room) => room.id === String(id)).colorIndex;

  assert.notStrictEqual(color(1), color(2));
  assert.notStrictEqual(color(2), color(3));
  assert.notStrictEqual(color(1), color(4));
  assert.notStrictEqual(color(2), color(4));
});

test('colouring starts from the room the dock is in', () => {
  // The dock sits in room 3 (raw row 3 from the bottom, column 5).
  const render = MapParser.toRenderData(mapFrom(ROWS, [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']], { x: 5, y: 3, theta: 0 }), { cropPadding: 0 });
  const room3 = render.rooms.find((room) => room.id === '3');

  assert.strictEqual(room3.colorIndex, 0);
  assert.deepStrictEqual(render.dock, { x: 5, y: 1, theta: 0 }, 'dock in display cells (top-down)');
});

test('each room has a label point inside it and its bounding box', () => {
  const render = MapParser.toRenderData(mapFrom(ROWS, [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']]), { cropPadding: 0 });
  const cells = expand(render.cells);
  for (const room of render.rooms) {
    assert.strictEqual(cells[room.label.y * render.width + room.label.x], room.code, `label of ${room.id} inside`);
    assert.ok(room.bbox.x1 >= room.bbox.x0 && room.bbox.y1 >= room.bbox.y0);
    assert.ok(room.cells > 0);
  }
  const d = render.rooms.find((room) => room.id === '4');
  assert.deepStrictEqual(d.bbox, {
    x0: 1, y0: 3, x1: 4, y1: 3,
  });
  assert.strictEqual(d.name, 'D');
});

test('a large real-size map stays small on the wire', () => {
  const rows = [];
  for (let y = 0; y < 300; y += 1) {
    const row = [];
    for (let x = 0; x < 250; x += 1) {
      if (x === 0 || y === 0 || x === 249 || y === 299) row.push(W);
      else row.push(r(1 + Math.floor(x / 50)));
    }
    rows.push(row);
  }
  const rooms = [1, 2, 3, 4, 5].map((id) => [id, `Room ${id}`]);
  const json = JSON.stringify(MapParser.toRenderData(mapFrom(rows, rooms)));

  assert.ok(json.length < 30000, `${json.length} bytes`);
});

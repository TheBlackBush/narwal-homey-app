'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LiveTrail } = require('../lib/LiveTrail');
const { MapParser } = require('../lib/MapParser');

const p = (x, y) => ({ x, y });

test('overlapping path windows join into one trail without duplicates', () => {
  const trail = new LiveTrail();
  trail.add([p(1, 1), p(2, 1), p(3, 1)]);
  trail.add([p(2, 1), p(3, 1), p(4, 1), p(5, 1)]); // the robot sends the last ~30 points each time

  assert.deepStrictEqual(trail.points, [p(1, 1), p(2, 1), p(3, 1), p(4, 1), p(5, 1)]);
});

test('a window that does not overlap is appended as it is', () => {
  const trail = new LiveTrail();
  trail.add([p(1, 1), p(2, 1)]);
  trail.add([p(9, 9), p(10, 9)]);

  assert.deepStrictEqual(trail.points, [p(1, 1), p(2, 1), p(9, 9), p(10, 9)]);
});

test('points added since a sequence number can be fetched, for small pushes', () => {
  const trail = new LiveTrail();
  trail.add([p(1, 1), p(2, 1)]);
  const seq = trail.length;
  trail.add([p(2, 1), p(3, 1)]);

  assert.deepStrictEqual(trail.since(seq), { from: 2, points: [p(3, 1)] });
  assert.deepStrictEqual(trail.since(99), { from: 0, points: trail.points }, 'unknown sequence: everything');
});

test('the trail is capped and can be reset for a new clean', () => {
  const trail = new LiveTrail({ max: 5 });
  for (let i = 0; i < 8; i += 1) trail.add([p(i, 0)]);
  assert.strictEqual(trail.points.length, 5);
  assert.deepStrictEqual(trail.points[0], p(3, 0));

  trail.reset();
  assert.strictEqual(trail.points.length, 0);
  assert.strictEqual(trail.since(0).from, 0);
});

test('live coordinates convert to the widget cells of the current render', () => {
  const border = {
    bottom: -10, top: 9, left: -5, right: 14,
  }; // a 20 x 20 map
  const meta = {
    crop: {
      x: 2, y: 3, sourceHeight: 20,
    },
  };

  // raw (0, 0) is cell (5, 10); display row = 20 - 1 - 10 = 9; minus the crop.
  assert.deepStrictEqual(MapParser.liveToDisplay({ x: 0, y: 0, theta: 1 }, border, meta), { x: 3, y: 6, theta: 1 });
  assert.deepStrictEqual(MapParser.liveToDisplay({ x: 1.26, y: -0.5 }, border, meta), { x: 4.3, y: 6.5, theta: null });
  assert.strictEqual(MapParser.liveToDisplay(null, border, meta), null);
  assert.strictEqual(MapParser.liveToDisplay(p(0, 0), null, meta), null);
});

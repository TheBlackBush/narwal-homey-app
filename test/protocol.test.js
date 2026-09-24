'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { NarwalProtocol, Command } = require('../lib/NarwalProtocol');
const { RobotState, FanSpeed } = require('../lib/constants');

test('buildRequest maps logical commands to wire strings with an id', () => {
  const p = new NarwalProtocol('v1');
  const req = p.buildGetStatus(7);
  assert.strictEqual(req.cmd, 'getStatus');
  assert.strictEqual(req.id, 7);
  assert.deepStrictEqual(req.params, {});
});

test('buildSetFanSpeed encodes the correct numeric level', () => {
  const p = new NarwalProtocol();
  assert.strictEqual(p.buildSetFanSpeed(FanSpeed.QUIET, 1).params.level, 0);
  assert.strictEqual(p.buildSetFanSpeed(FanSpeed.NORMAL, 1).params.level, 1);
  assert.strictEqual(p.buildSetFanSpeed(FanSpeed.STRONG, 1).params.level, 2);
  assert.strictEqual(p.buildSetFanSpeed(FanSpeed.MAX, 1).params.level, 3);
  assert.throws(() => p.buildSetFanSpeed('turbo', 1));
});

test('buildCleanRoom accepts ids, objects and arrays', () => {
  const p = new NarwalProtocol();
  assert.deepStrictEqual(p.buildCleanRoom('5', 1).params.rooms, ['5']);
  assert.deepStrictEqual(p.buildCleanRoom([{ id: 2 }, { id: 3 }], 1).params.rooms, [2, 3]);
  assert.throws(() => p.buildCleanRoom([], 1));
});

test('parseMessage classifies replies, events and unknown frames', () => {
  const p = new NarwalProtocol();
  const reply = p.parseMessage(JSON.stringify({
    cmd: 'getStatus', id: 3, code: 0, result: { battery: 50 },
  }));
  assert.strictEqual(reply.type, 'reply');
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.id, 3);
  assert.deepStrictEqual(reply.data, { battery: 50 });

  const errReply = p.parseMessage({ cmd: 'startClean', id: 4, code: 7 });
  assert.strictEqual(errReply.ok, false);
  assert.strictEqual(errReply.code, 7);

  const event = p.parseMessage(JSON.stringify({ event: 'status', data: { mode: 'cleaning' } }));
  assert.strictEqual(event.type, 'event');
  assert.strictEqual(event.event, 'status');

  assert.strictEqual(p.parseMessage('').type, 'unknown');
});

test('normalizeState maps textual and numeric robot states', () => {
  assert.strictEqual(NarwalProtocol.normalizeState('cleaning'), RobotState.CLEANING);
  assert.strictEqual(NarwalProtocol.normalizeState('GoHome'), RobotState.RETURNING);
  assert.strictEqual(NarwalProtocol.normalizeState('charge'), RobotState.CHARGING);
  assert.strictEqual(NarwalProtocol.normalizeState(7), RobotState.SLEEPING);
  assert.strictEqual(NarwalProtocol.normalizeState('???'), RobotState.UNKNOWN);
  assert.strictEqual(NarwalProtocol.normalizeState(null), RobotState.UNKNOWN);
});

test('normalizeStatus produces a complete normalized model with aliases', () => {
  const p = new NarwalProtocol();
  const status = p.normalizeStatus({
    workMode: 'mopping',
    batteryLevel: 64,
    fanLevel: 2,
    clean_area: 23.4,
    clean_time: 41,
    fwVersion: '2.3.1',
    error: 0,
  });
  assert.strictEqual(status.state, RobotState.CLEANING);
  assert.strictEqual(status.homeyState, 'cleaning');
  assert.strictEqual(status.battery, 64);
  assert.strictEqual(status.fanSpeed, FanSpeed.STRONG);
  assert.strictEqual(status.cleanArea, 23.4);
  assert.strictEqual(status.cleanTime, 41);
  assert.strictEqual(status.firmware, '2.3.1');
  assert.strictEqual(status.error, null);
  assert.strictEqual(status.sleeping, false);
});

test('normalizeStatus infers charging/docked from state and converts units', () => {
  const p = new NarwalProtocol();
  const charging = p.normalizeStatus({ mode: 'charging' });
  assert.strictEqual(charging.charging, true);
  assert.strictEqual(charging.docked, true);

  // Large area treated as cm^2 and converted to m^2; seconds -> minutes.
  const converted = p.normalizeStatus({ mode: 'cleaning', cleanArea: 234000, cleanTimeSec: 600 });
  assert.strictEqual(converted.cleanArea, 23.4);
  assert.strictEqual(converted.cleanTime, 10);
});

test('error codes surface as a non-null error string', () => {
  const p = new NarwalProtocol();
  const status = p.normalizeStatus({ mode: 'error', errorCode: 12 });
  assert.strictEqual(status.state, RobotState.ERROR);
  assert.strictEqual(status.error, '12');
});

test('toHomeyState covers every RobotState', () => {
  for (const state of Object.values(RobotState)) {
    assert.ok(['cleaning', 'spot_cleaning', 'docked', 'charging', 'stopped'].includes(NarwalProtocol.toHomeyState(state)));
  }
});

test('unknown command throws', () => {
  const p = new NarwalProtocol();
  assert.throws(() => p.wireCommand('does_not_exist'));
  assert.strictEqual(p.wireCommand(Command.DOCK), 'returnDock');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  NarwalBinaryProtocol,
  CommandResult,
  buildCleanPayload,
  buildStartCleanPayload,
  buildFrame,
  decodeProto,
  parseCommandResponse,
  parseFrame,
  toFloat32,
} = require('../lib/NarwalBinaryProtocol');
const {
  DIFFERENT_LOCAL_STACK_PRODUCT_KEYS,
  FanSpeed,
  HomeyVacuumState,
  KNOWN_PRODUCT_KEYS,
  PRODUCT_KEY_MODEL_NAMES,
  RobotState,
  modelNameForProductKey,
} = require('../lib/constants');

test('binary frame builder and parser round-trip a Narwal topic', () => {
  const payload = Buffer.from([0x08, 0x01]);
  const frame = buildFrame('/QxMSPG6VSO/device/common/yell', payload);
  const parsed = parseFrame(frame);

  assert.strictEqual(parsed.type, 'broadcast');
  assert.strictEqual(parsed.shortTopic, 'common/yell');
  assert.deepStrictEqual(parsed.payload, payload);
});

test('binary protocol learns product key and device id from incoming topics', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO' });
  const frame = buildFrame('/QxMSPG6VSO/0123456789abcdef0123456789abcdef/status/working_status', Buffer.from([0x18, 0x78]));
  const parsed = protocol.parse(frame);

  assert.strictEqual(parsed.shortTopic, 'status/working_status');
  assert.strictEqual(protocol.deviceId, '0123456789abcdef0123456789abcdef');
  assert.strictEqual(protocol.topicPrefix, '/QxMSPG6VSO');
});

test('binary discovery includes current compatibility product keys', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QoEsI5qYXO' });
  const topics = protocol.buildDiscoveryFrames().map((frame) => parseFrame(frame).topic);

  for (const key of ['QoEsI5qYXO', 'QxMSPG6VSO', 'iSuVlI1If2', 'mkbqaprvrb', 'DrzDKQ0MU8', 'qV6BujoYLz', 'hEA7OEshlx', 'BYWBPqSxeC', 'fjhpiem4ba', 'CGjuB6dzq7', 'CNbforyZWI']) {
    assert.ok(KNOWN_PRODUCT_KEYS.includes(key), `${key} should be in known product keys`);
    assert.ok(topics.some((topic) => topic.startsWith(`/${key}/`)), `${key} should be probed`);
  }

  assert.strictEqual(modelNameForProductKey('qV6BujoYLz'), PRODUCT_KEY_MODEL_NAMES.qV6BujoYLz);
  assert.strictEqual(modelNameForProductKey('mkbqaprvrb'), 'Narwal Flow 2');
  assert.strictEqual(modelNameForProductKey('fjhpiem4ba'), 'Narwal Freo 20');
  assert.strictEqual(modelNameForProductKey('CGjuB6dzq7'), 'Narwal JX');
  assert.ok(DIFFERENT_LOCAL_STACK_PRODUCT_KEYS.includes('LnugwMG9ss'));
});

test('binary base status normalizes Flow 2 dock and battery fields', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  const decoded = {
    2: 1118044160, // float32 82.0
    3: { 1: 10, 10: 1, 12: 1 },
    11: 2,
    26: 4,
  };

  const status = protocol.normalizeStatus(decoded, 'status/robot_base_status');

  assert.strictEqual(status.state, RobotState.DOCKED);
  assert.strictEqual(status.homeyState, HomeyVacuumState.DOCKED);
  assert.strictEqual(status.battery, 82);
  assert.strictEqual(status.docked, true);
  assert.strictEqual(status.charging, true);
  assert.strictEqual(status.fanSpeed, FanSpeed.MAX);
});

test('binary working status preserves partial cleaning metrics', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  // Field 13 is a dock timer, not area, so only the elapsed time is known here.
  const status = protocol.normalizeStatus({ 3: 1800, 13: 125000 }, 'status/working_status');

  assert.strictEqual(status.state, RobotState.CLEANING);
  assert.strictEqual(status.cleanTime, 30);
  assert.strictEqual(status.cleanArea, null);
});

test('binary upgrade status exposes current firmware', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  const status = protocol.normalizeStatus({ 7: 'v01.08.01.00' }, 'upgrade/upgrade_status');

  assert.strictEqual(status.firmware, 'v01.08.01.00');
  assert.strictEqual(status.state, RobotState.UNKNOWN);
});

test('binary start clean payload carries map id and selected rooms', () => {
  const payload = buildStartCleanPayload([5, { id: 2 }], 12345);
  const decoded = decodeProto(payload);
  assert.strictEqual(decoded['1']['1'], 12345);
  const items = Array.isArray(decoded['1']['2']) ? decoded['1']['2'] : [decoded['1']['2']];
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0]['3'], 1);
  assert.strictEqual(items[1]['3'], 2);
  assert.strictEqual(decodeProto(Buffer.from(items[0]['1'].slice(2), 'hex'))['2'], 5);
  assert.strictEqual(decodeProto(Buffer.from(items[1]['1'].slice(2), 'hex'))['2'], 2);
  assert.strictEqual(decoded['1']['5'], 4);
});

test('binary command response parser labels success and busy responses', () => {
  assert.deepStrictEqual(parseCommandResponse({ 1: CommandResult.SUCCESS }, Buffer.from([0x08, 0x01])).ok, true);

  const conflict = parseCommandResponse({ 1: CommandResult.CONFLICT });
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.label, 'conflict');

  const notReady = parseCommandResponse({ 1: CommandResult.NOT_READY });
  assert.strictEqual(notReady.ok, false);
  assert.strictEqual(notReady.label, 'not_ready');
});

test('binary working status exposes active room and field-2 area', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  const status = protocol.normalizeStatus({ 2: 1098383360, 3: 120, 6: 4 }, 'status/working_status');

  assert.strictEqual(status.state, RobotState.CLEANING);
  assert.strictEqual(status.cleanTime, 2);
  assert.strictEqual(status.cleanArea, 15.5);
  assert.strictEqual(status.currentRoomId, '4');
});

test('binary clean payload and float32 helpers decode expected primitives', () => {
  const payload = buildCleanPayload([101, { id: 202 }]);
  const decoded = decodeProto(payload);

  assert.ok(decoded['1']);
  assert.strictEqual(Math.round(toFloat32(1118044160)), 82);
});

test('binary fan speed frame sends the robot suction levels 1 to 4', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  const expected = {
    [FanSpeed.QUIET]: 1,
    [FanSpeed.NORMAL]: 2,
    [FanSpeed.STRONG]: 3,
    [FanSpeed.MAX]: 4,
  };

  for (const [fanSpeed, level] of Object.entries(expected)) {
    const parsed = parseFrame(protocol.buildSetFanSpeedFrame(fanSpeed));
    assert.strictEqual(parsed.shortTopic, 'clean/set_fan_level');
    assert.deepStrictEqual(decodeProto(parsed.payload), { 1: level }, fanSpeed);
  }
});

test('binary base status treats working statuses 3, 7 and 17 as cleaning', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  for (const workingStatus of [3, 7, 17]) {
    const status = protocol.normalizeStatus({ 3: { 1: workingStatus } }, 'status/robot_base_status');
    assert.strictEqual(status.state, RobotState.CLEANING, `working status ${workingStatus}`);
    assert.strictEqual(status.homeyState, HomeyVacuumState.CLEANING, `working status ${workingStatus}`);
  }
});

test('binary base status reports task-completed 19 as docked once the dock confirms presence', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'DrzDKQ0MU8', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 3: { 1: 19, 10: 1 } }, 'status/robot_base_status');

  assert.strictEqual(status.state, RobotState.DOCKED);
  assert.strictEqual(status.homeyState, HomeyVacuumState.DOCKED);
  assert.strictEqual(status.docked, true);
});

test('binary base status keeps task-completed 19 as returning while still off the dock', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'DrzDKQ0MU8', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 3: { 1: 19 } }, 'status/robot_base_status');

  // Without dock fields the dock state is unknown and the last known one is kept.
  assert.strictEqual(status.state, RobotState.RETURNING);
  assert.strictEqual(status.docked, null);
});

test('binary base status decodes suction level 5 as Ultra Powerful', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 3: { 1: 10 }, 26: 5 }, 'status/robot_base_status');

  assert.strictEqual(status.fanSpeed, FanSpeed.ULTRA);
});

function firstCleanParam(payload) {
  const task = decodeProto(payload)['1'];
  const item = Array.isArray(task['2']) ? task['2'][0] : task['2'];
  return { task, param: decodeProto(Buffer.from(item['2'].slice(2), 'hex')) };
}

test('binary start clean payload carries route only when one is chosen', () => {
  const withRoute = firstCleanParam(buildStartCleanPayload([3], 9, { route: 2 }));
  assert.strictEqual(withRoute.param['8'], 2);

  const without = firstCleanParam(buildStartCleanPayload([3], 9, {}));
  assert.strictEqual(without.param['8'], undefined);
});

test('binary start clean payload encodes mop-only wet cleans', () => {
  const { task, param } = firstCleanParam(buildStartCleanPayload([3], 9, {
    workMode: 2, water: 3, mopStrength: 2, passes: 2,
  }));

  assert.strictEqual(task['5'], 2, 'task type is the work mode');
  assert.strictEqual(param['1'], 3, 'CleanParam mode for mop only');
  assert.strictEqual(param['3'], 2);
  assert.strictEqual(param['4'], 3);
  assert.strictEqual(param['6'], 2, 'mop pass count');
});

// Values below were recorded from a Flow 2 on firmware v01.09.10.02.

test('binary base status: working status 2 while field 47 says off-dock is cleaning, not docked', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({
    2: 1119879168, 3: { 1: 2, 4: 6 }, 11: 1, 47: 2, 26: 2,
  }, 'status/robot_base_status');

  assert.strictEqual(status.state, RobotState.CLEANING);
  assert.strictEqual(status.docked, false);
  assert.strictEqual(status.charging, false);
});

test('binary base status: working status 2 on the dock is still docked', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 3: { 1: 2, 4: 6 }, 11: 3, 47: 1 }, 'status/robot_base_status');

  assert.strictEqual(status.state, RobotState.DOCKED);
  assert.strictEqual(status.docked, true);
});

test('binary base status: task completed with a paused flag on the dock is docked, not paused', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({
    3: { 1: 19, 2: 1, 18: 4 }, 11: 3, 47: 1,
  }, 'status/robot_base_status');

  assert.strictEqual(status.state, RobotState.DOCKED);
});

test('binary base status keeps the current room while off the dock and clears it when docked', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const cleaning = protocol.normalizeStatus({ 3: { 1: 2, 4: 6 }, 11: 1, 47: 2 }, 'status/robot_base_status');
  const docked = protocol.normalizeStatus({ 3: { 1: 14, 12: 6 }, 11: 3, 47: 1 }, 'status/robot_base_status');

  assert.strictEqual(cleaning.currentRoomId, undefined);
  assert.strictEqual(docked.currentRoomId, null);
});

test('binary working status does not treat the dock timer in field 13 as cleaning area', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  // After docking: dock task fields and field 13 = 18000, no area (2) or time (3).
  const status = protocol.normalizeStatus({
    10: 1, 11: 5, 12: 0, 13: 18000,
  }, 'status/working_status');

  assert.strictEqual(status.cleanArea, null);
  assert.notStrictEqual(status.state, RobotState.CLEANING);
});

test('binary upgrade status leaves the current room alone', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 4: 10, 7: 'v01.09.10.02', 8: 'v01.09.10.02' }, 'upgrade/upgrade_status');

  assert.strictEqual(status.currentRoomId, undefined);
});

test('binary base status: any explicit off-dock signal means not docked', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  const offDock = {
    'field 11 = 1': { 3: { 1: 2 }, 11: 1 },
    'field 47 = 2': { 3: { 1: 2 }, 47: 2 },
    'dock presence 3.3 = 2': { 3: { 1: 2, 3: 2 } },
    'dock sub-state 3.10 = 2': { 3: { 1: 2, 10: 2 } },
  };

  for (const [signal, decoded] of Object.entries(offDock)) {
    const status = protocol.normalizeStatus(decoded, 'status/robot_base_status');
    assert.strictEqual(status.docked, false, signal);
    assert.strictEqual(status.state, RobotState.CLEANING, `${signal}: working status 2 off the dock is a running task`);
  }
});

test('binary base status: a docked code with an off-dock signal is not reported as docked', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });

  const status = protocol.normalizeStatus({ 3: { 1: 10 }, 11: 1, 47: 2 }, 'status/robot_base_status');

  assert.strictEqual(status.docked, false);
  assert.notStrictEqual(status.state, RobotState.DOCKED);
});

test('binary base status regression table across firmware versions', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'device' });
  const cases = [
    // [firmware, situation, base status, expected state, expected docked]
    ['old firmware', 'docked, status 10', { 3: { 1: 10, 10: 1, 12: 1 }, 11: 2, 47: 3 }, RobotState.DOCKED, true],
    ['old firmware', 'cleaning, status 4', { 3: { 1: 4 }, 11: 1, 47: 2 }, RobotState.CLEANING, false],
    ['old firmware', 'returning', { 3: { 1: 4, 7: 1, 10: 2 }, 11: 1, 47: 2 }, RobotState.RETURNING, false],
    ['v01.07.23.00', 'docked, status 2', { 3: { 1: 2 }, 11: 3, 47: 1 }, RobotState.DOCKED, true],
    ['v01.09.04.00', 'docked, status 1', { 3: { 1: 1, 3: 6 }, 11: 2, 47: 3 }, RobotState.IDLE, true],
    ['v01.09.10.02', 'cleaning, status 2', { 3: { 1: 2, 4: 6 }, 11: 1, 47: 2 }, RobotState.CLEANING, false],
    ['v01.09.10.02', 'arriving at dock, status 2', { 3: { 1: 2, 4: 6 }, 11: 3, 47: 1 }, RobotState.DOCKED, true],
    ['v01.09.10.02', 'task completed on dock', { 3: { 1: 19, 2: 1, 18: 4 }, 11: 3, 47: 1 }, RobotState.DOCKED, true],
    ['v01.09.10.02', 'docked, dock work', { 3: { 1: 14, 12: 6 }, 11: 3, 47: 1 }, RobotState.DOCKED, true],
  ];

  for (const [firmware, situation, decoded, state, docked] of cases) {
    const status = protocol.normalizeStatus(decoded, 'status/robot_base_status');
    assert.strictEqual(status.state, state, `${firmware} ${situation}: state`);
    assert.strictEqual(status.docked, docked, `${firmware} ${situation}: docked`);
  }
});

test('a field that runs past the end of the buffer is an error, not a shorter value', () => {
  // field 1, length-delimited, claims 10 bytes but only 3 follow
  assert.throws(() => decodeProto(Buffer.from([0x0a, 0x0a, 0x61, 0x62, 0x63])), /truncated/);
  // fixed 32-bit field with 2 of 4 bytes
  assert.throws(() => decodeProto(Buffer.from([0x0d, 0x01, 0x02])), /truncated|range/i);
});

test('garbage frames never throw out of the parser', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: 'QxMSPG6VSO', deviceId: 'dev' });
  const good = buildFrame('/QxMSPG6VSO/dev/status/robot_base_status', Buffer.from([0x0a, 0x0a, 0x61]));
  const inputs = [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from([0x01, 0x02, 0x03]), good.subarray(0, 5), good, Buffer.alloc(300, 0x7f)];
  for (const input of inputs) {
    assert.doesNotThrow(() => protocol.parse(input), input.toString('hex'));
  }
});

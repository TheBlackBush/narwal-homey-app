'use strict';

const C = require('./constants');

const FIELD_TOPIC = 0x22;
const FIELD_RESPONSE = 0x2a;

const CommandResult = {
  SUCCESS: 1,
  NOT_APPLICABLE: 2,
  CONFLICT: 3,
  NOT_READY: 4,
};

const COMMAND_TOPICS = {
  LOCATE: 'common/yell',
  START_PLAN: 'clean/plan/start',
  START_CLEAN: 'clean/start_clean',
  PAUSE: 'task/pause',
  RESUME: 'task/resume',
  FORCE_END: 'task/force_end',
  RECALL: 'supply/recall',
  SET_FAN_LEVEL: 'clean/set_fan_level',
};

// CleanParam suction: 0 is unspecified, 1 Quiet up to 5 Ultra Powerful.
const FAN_LEVEL = {
  [C.FanSpeed.QUIET]: 1,
  [C.FanSpeed.NORMAL]: 2,
  [C.FanSpeed.STRONG]: 3,
  [C.FanSpeed.MAX]: 4,
  [C.FanSpeed.ULTRA]: 5,
};

// clean/set_fan_level takes SweepFanLevel, which has the same values but no 5.
const LIVE_FAN_LEVEL_MAX = 4;

function liveFanLevel(fanSpeed) {
  const level = FAN_LEVEL[fanSpeed];
  return level === undefined ? undefined : Math.min(level, LIVE_FAN_LEVEL_MAX);
}

// Conservative legacy whole-house clean payload: wet mop, strong/max suction,
// single pass. Kept only as a saved-plan fallback when no active map is known.
const DEFAULT_CLEAN_PAYLOAD = Buffer.from('0a0e12002a0a0a060803100218012a00', 'hex');

const BROADCAST_TOPICS = [
  'status/robot_base_status',
  'status/working_status',
  'upgrade/upgrade_status',
  'status/download_status',
  'map/display_map',
  'status/time_line_status',
  'status/point_navi_plan_traj',
  'developer/planning_debug_info',
];

const WORKING_STATE = {
  UNKNOWN: 0,
  STANDBY: 1,
  DOCKED_V2: 2,
  CLEANING_V2: 3,
  CLEANING: 4,
  CLEANING_ALT: 5,
  REMAPPING: 7,
  DOCKED: 10,
  CHARGED: 14,
  CUSTOM_CLEANING: 17,
  TASK_COMPLETED: 19,
  ERROR: 99,
};

function encodeVarint(value) {
  let n = Number(value);
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

function encodeFieldKey(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeFieldKey(field, 0), encodeVarint(value)]);
}

function encodeBytesField(field, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeFieldKey(field, 2), encodeVarint(buf.length), buf]);
}

function encodeStringField(field, value) {
  return encodeBytesField(field, Buffer.from(String(value), 'utf8'));
}

function encodeMessage(fields) {
  return Buffer.concat(fields.filter(Boolean));
}

function buildTopicSubscription(duration = 600) {
  return Buffer.concat(BROADCAST_TOPICS.map((topic) => {
    const inner = Buffer.concat([
      encodeStringField(1, topic),
      encodeVarintField(2, duration),
    ]);
    return encodeBytesField(1, inner);
  }));
}

function buildCleanPayload(roomIds = null, {
  suction = 3,
  mopHumidity = 2,
  passes = 1,
  cleanMode = 3,
} = {}) {
  const ids = (Array.isArray(roomIds) ? roomIds : [roomIds])
    .map((id) => Number(typeof id === 'object' && id ? id.id : id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return DEFAULT_CLEAN_PAYLOAD;

  const roomEntries = ids.map((roomId, index) => encodeMessage([
    encodeBytesField(1, encodeMessage([
      encodeVarintField(1, 1),
      encodeVarintField(2, roomId),
    ])),
    encodeBytesField(2, encodeMessage([
      encodeVarintField(1, suction),
      encodeVarintField(2, cleanMode),
      encodeVarintField(3, passes),
      encodeVarintField(7, mopHumidity),
    ])),
    encodeVarintField(3, index + 1),
  ]));

  return encodeBytesField(1, encodeMessage([
    encodeVarintField(1, 1),
    ...roomEntries.map((entry) => encodeBytesField(2, entry)),
    encodeBytesField(3, Buffer.alloc(0)),
    encodeVarintField(5, 6),
  ]));
}

const WorkMode = {
  VACUUM: 1,
  MOP: 2,
  VACUUM_THEN_MOP: 3,
  VACUUM_AND_MOP: 4,
};

const WORK_MODE_PARAM = {
  [WorkMode.VACUUM]: { mode: 2, passFields: [5] },
  [WorkMode.MOP]: { mode: 3, passFields: [6] },
  [WorkMode.VACUUM_THEN_MOP]: { mode: 5, passFields: [5, 6] },
  [WorkMode.VACUUM_AND_MOP]: { mode: 4, passFields: [7] },
};

function cleanParamPayload({
  workMode = WorkMode.VACUUM_AND_MOP,
  fan = 2,
  water = 2,
  mopStrength = 1,
  passes = 1,
  route = null,
} = {}) {
  const mode = WORK_MODE_PARAM[workMode] || WORK_MODE_PARAM[WorkMode.VACUUM_AND_MOP];
  return encodeMessage([
    encodeVarintField(1, mode.mode),
    encodeVarintField(2, fan),
    encodeVarintField(3, mopStrength),
    encodeVarintField(4, water),
    ...mode.passFields.map((field) => encodeVarintField(field, passes)),
    // Route (1 standard, 2 meticulous) is optional; omit it to keep the robot's choice.
    route ? encodeVarintField(8, route) : null,
  ]);
}

function buildStartCleanPayload(roomIds, mapId, options = {}) {
  const ids = (Array.isArray(roomIds) ? roomIds : [roomIds])
    .map((id) => Number(typeof id === 'object' && id ? id.id : id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const numericMapId = Number(mapId) || 0;
  if (!ids.length) throw new Error('No rooms supplied for clean/start_clean');
  if (!numericMapId) throw new Error('No active map id available for clean/start_clean');

  const workMode = Number(options.workMode) || WorkMode.VACUUM_AND_MOP;
  const params = cleanParamPayload({ ...options, workMode });
  const items = ids.map((roomId, index) => encodeMessage([
    encodeBytesField(1, encodeMessage([
      encodeVarintField(1, 1),
      encodeVarintField(2, roomId),
    ])),
    encodeBytesField(2, params),
    encodeVarintField(3, index + 1),
  ]));

  return encodeBytesField(1, encodeMessage([
    encodeVarintField(1, numericMapId),
    ...items.map((item) => encodeBytesField(2, item)),
    encodeBytesField(3, Buffer.alloc(0)),
    encodeVarintField(5, workMode),
  ]));
}

function parseCommandResponse(decoded = {}, payload = Buffer.alloc(0)) {
  const raw = decoded['1'];
  let resultCode;
  if (typeof raw === 'number') resultCode = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw)) resultCode = Number(raw);
  else resultCode = CommandResult.SUCCESS;

  const ok = resultCode === CommandResult.SUCCESS;
  const label = {
    [CommandResult.SUCCESS]: 'success',
    [CommandResult.NOT_APPLICABLE]: 'not_applicable',
    [CommandResult.CONFLICT]: 'conflict',
    [CommandResult.NOT_READY]: 'not_ready',
  }[resultCode] || `code_${resultCode}`;

  return {
    ok,
    resultCode,
    label,
    data: decoded,
    rawPayload: Buffer.from(payload),
  };
}

function buildFrame(topic, payload = Buffer.alloc(0)) {
  const topicBuf = Buffer.from(topic, 'utf8');
  if (!topicBuf.length) throw new Error('Narwal topic cannot be empty');
  if (topicBuf.length > 255) throw new Error(`Narwal topic too long (${topicBuf.length} bytes)`);
  return Buffer.concat([
    Buffer.from([0x01, (topicBuf.length + 2) & 0xff, FIELD_TOPIC, topicBuf.length]),
    topicBuf,
    payload,
  ]);
}

function parseFrame(data) {
  const buf = Buffer.from(data);
  if (buf.length < 4 || buf[0] !== 0x01 || (buf[2] !== FIELD_TOPIC && buf[2] !== FIELD_RESPONSE)) return null;
  const topicLength = buf[3];
  const topicEnd = 4 + topicLength;
  if (buf.length < topicEnd) return null;
  const topic = buf.slice(4, topicEnd).toString('utf8');
  return {
    type: buf[2] === FIELD_RESPONSE ? 'response' : 'broadcast',
    fieldTag: buf[2],
    topic,
    shortTopic: shortTopic(topic),
    payload: buf.slice(topicEnd),
    raw: buf,
  };
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    result += (byte & 0x7f) * (2 ** shift);
    i += 1;
    if ((byte & 0x80) === 0) return { value: result, offset: i };
    shift += 7;
    if (shift > 56) break;
  }
  throw new Error('unterminated varint');
}

function looksText(buf) {
  if (!buf.length) return false;
  let printable = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable += 1;
  }
  return printable / buf.length > 0.85;
}

function decodeProto(buf, depth = 0) {
  const out = {};
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    let value;
    if (wire === 0) {
      const v = readVarint(buf, offset);
      offset = v.offset;
      value = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      const bytes = buf.slice(offset, offset + len.value);
      offset += len.value;
      if (looksText(bytes)) value = bytes.toString('utf8').replace(/\0+$/g, '');
      else if (depth < 2) {
        try {
          value = decodeProto(bytes, depth + 1);
        } catch (_) {
          value = `0x${bytes.toString('hex')}`;
        }
      } else value = `0x${bytes.toString('hex')}`;
    } else if (wire === 5) {
      value = buf.readUInt32LE(offset);
      offset += 4;
    } else if (wire === 1) {
      value = Number(buf.readBigUInt64LE(offset));
      offset += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    const keyName = String(field);
    if (out[keyName] === undefined) out[keyName] = value;
    else if (Array.isArray(out[keyName])) out[keyName].push(value);
    else out[keyName] = [out[keyName], value];
  }
  return out;
}

function shortTopic(topic) {
  const parts = topic.split('/');
  return parts.length >= 4 ? parts.slice(3).join('/') : topic;
}

function topicIdentity(topic) {
  const parts = String(topic || '').split('/');
  if (parts.length >= 4) {
    return {
      productKey: parts[1] || '',
      topicPrefix: parts[1] ? `/${parts[1]}` : '',
      deviceId: parts[2] || '',
    };
  }
  return { productKey: '', topicPrefix: '', deviceId: '' };
}

function toFloat32(value) {
  if (typeof value === 'number' && !Number.isInteger(value)) return value;
  if (!Number.isFinite(Number(value))) return null;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Number(value) >>> 0, 0);
  return buf.readFloatLE(0);
}

function firstObject(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === 'object') || null;
  return value && typeof value === 'object' ? value : null;
}

function mapRobotState(workingStatus, flags = {}) {
  if (flags.paused) return C.RobotState.PAUSED;
  if (flags.returning) return C.RobotState.RETURNING;
  switch (Number(workingStatus)) {
    case WORKING_STATE.STANDBY: return C.RobotState.IDLE;
    case WORKING_STATE.DOCKED_V2:
    case WORKING_STATE.DOCKED:
    case WORKING_STATE.CHARGED:
      return C.RobotState.DOCKED;
    case WORKING_STATE.CLEANING_V2:
    case WORKING_STATE.CLEANING:
    case WORKING_STATE.CLEANING_ALT:
    case WORKING_STATE.REMAPPING:
    case WORKING_STATE.CUSTOM_CLEANING:
      return C.RobotState.CLEANING;
    case WORKING_STATE.TASK_COMPLETED:
      return C.RobotState.RETURNING;
    case WORKING_STATE.ERROR:
      return C.RobotState.ERROR;
    default:
      return C.RobotState.UNKNOWN;
  }
}

class NarwalBinaryProtocol {
  constructor({ productKey = 'QxMSPG6VSO', deviceId = '' } = {}) {
    this.topicPrefix = productKey.startsWith('/') ? productKey : `/${productKey}`;
    this.deviceId = deviceId || '';
  }

  fullTopic(short) {
    return `${this.topicPrefix}/${this.deviceId}/${short}`;
  }

  updateIdentityFromTopic(topic) {
    const ident = topicIdentity(topic);
    if (ident.topicPrefix) this.topicPrefix = ident.topicPrefix;
    if (ident.deviceId) this.deviceId = ident.deviceId;
    return ident;
  }

  buildWakeFrames() {
    return [
      buildFrame(this.fullTopic('common/notify_app_event'), encodeVarintField(1, 1)),
      ...this.buildSubscriptionFrames(),
      buildFrame(this.fullTopic('status/app_status_heartbeat'), encodeVarintField(1, 1)),
      buildFrame(this.fullTopic('status/get_device_base_status'), Buffer.alloc(0)),
    ];
  }

  buildSubscriptionFrames() {
    return [
      buildFrame(this.fullTopic('common/active_robot_publish'), buildTopicSubscription(600)),
      buildFrame(this.fullTopic('common/active_robot_publish'), encodeVarintField(1, 600)),
    ];
  }

  buildDiscoveryFrames(productKeys = []) {
    const keys = productKeys.length ? productKeys : C.KNOWN_PRODUCT_KEYS;
    return [
      buildFrame('//common/get_device_info'),
      ...keys.map((key) => buildFrame(`/${key}/${this.deviceId}/common/get_device_info`)),
    ];
  }

  buildCommandFrame(shortTopic, payload = Buffer.alloc(0)) {
    return buildFrame(this.fullTopic(shortTopic), payload);
  }

  buildLocateFrame() {
    return this.buildCommandFrame(COMMAND_TOPICS.LOCATE);
  }

  buildStartPlanFrame() {
    return this.buildCommandFrame(COMMAND_TOPICS.START_PLAN, buildCleanPayload());
  }

  buildStartCleanFrame(roomIds, mapId, options = {}) {
    return this.buildCommandFrame(COMMAND_TOPICS.START_CLEAN, buildStartCleanPayload(roomIds, mapId, options));
  }

  buildPauseFrame() {
    return this.buildCommandFrame(COMMAND_TOPICS.PAUSE);
  }

  buildResumeFrame() {
    return this.buildCommandFrame(COMMAND_TOPICS.RESUME);
  }

  buildStopFrame() {
    return this.buildCommandFrame(COMMAND_TOPICS.FORCE_END);
  }

  buildDockFrame() {
    return this.buildCommandFrame(COMMAND_TOPICS.RECALL);
  }

  buildSetFanSpeedFrame(fanSpeed) {
    const level = liveFanLevel(fanSpeed);
    if (level === undefined) throw new Error(`Invalid fan speed: ${fanSpeed}`);
    return this.buildCommandFrame(COMMAND_TOPICS.SET_FAN_LEVEL, encodeVarintField(1, level));
  }

  parse(raw) {
    const msg = parseFrame(raw);
    if (!msg) return null;
    this.updateIdentityFromTopic(msg.topic);
    let decoded = {};
    try {
      decoded = decodeProto(msg.payload);
    } catch (err) {
      decoded = { decode_error: err.message };
    }
    return { ...msg, decoded };
  }

  normalizeStatus(decoded = {}, shortTopic = 'status/robot_base_status') {
    if (shortTopic === 'status/working_status') return this.normalizeWorkingStatus(decoded);
    if (shortTopic === 'upgrade/upgrade_status') return this.normalizeUpgradeStatus(decoded);
    return this.normalizeBaseStatus(decoded);
  }

  normalizeBaseStatus(decoded = {}) {
    const field3 = firstObject(decoded['3']);
    const workingStatus = field3 && field3['1'] !== undefined ? Number(field3['1']) : null;
    const paused = Boolean(field3 && field3['2']);
    const returning = Boolean(field3 && field3['7'] === 1 && field3['10'] === 2);
    let state = mapRobotState(workingStatus, { paused, returning });
    const batteryFloat = decoded['2'] === undefined ? null : toFloat32(decoded['2']);
    const battery = batteryFloat === null ? null : Math.max(0, Math.min(100, Math.round(batteryFloat)));
    const dockField11 = Number(decoded['11'] || 0);
    const dockField47 = Number(decoded['47'] || 0);
    const dockSubState = Number((field3 && field3['10']) || 0);
    const dockActivity = Number((field3 && field3['12']) || 0);
    // Task completed (19) can persist after the robot is back on the dock.
    if (workingStatus === WORKING_STATE.TASK_COMPLETED && !returning
      && (dockSubState === 1 || dockField11 >= 2 || dockField47 === 1 || dockField47 === 3)) {
      state = C.RobotState.DOCKED;
    }
    const docked = state === C.RobotState.DOCKED || (
      state !== C.RobotState.CLEANING
      && (dockSubState === 1 || dockActivity > 0 || dockField11 >= 2 || dockField47 === 1 || dockField47 === 3)
    );
    const charging = docked && battery !== null ? battery < 100 : (docked || null);
    const fanLevel = decoded['26'] === undefined ? null : Number(decoded['26']);
    const fanSpeed = fanLevel === null ? null : ({
      0: C.FanSpeed.QUIET,
      1: C.FanSpeed.QUIET,
      2: C.FanSpeed.NORMAL,
      3: C.FanSpeed.STRONG,
      4: C.FanSpeed.MAX,
      5: C.FanSpeed.ULTRA,
    }[fanLevel] || null);

    let homeyState = C.HomeyVacuumState.STOPPED;
    if (state === C.RobotState.CLEANING) homeyState = C.HomeyVacuumState.CLEANING;
    else if (docked) homeyState = C.HomeyVacuumState.DOCKED;
    else if (state === C.RobotState.CHARGING) homeyState = C.HomeyVacuumState.CHARGING;

    return {
      raw: decoded,
      rawMode: workingStatus,
      state,
      homeyState,
      battery,
      charging,
      docked,
      fanSpeed,
      cleanArea: null,
      cleanTime: null,
      firmware: null,
      error: null,
      sleeping: false,
      deviceId: this.deviceId || null,
      topicPrefix: this.topicPrefix,
      currentRoomId: null,
    };
  }

  normalizeWorkingStatus(decoded = {}) {
    const areaFromField2 = decoded['2'] === undefined ? null : toFloat32(decoded['2']);
    const areaFromField13 = decoded['13'] === undefined ? null : Number(decoded['13']) / 10000;
    const areaRaw = areaFromField2 !== null ? areaFromField2 : areaFromField13;
    const area = areaRaw === null || !Number.isFinite(areaRaw) ? null : Math.round(areaRaw * 10) / 10;
    const time = decoded['3'] === undefined ? null : Math.round(Number(decoded['3']) / 60);
    const currentRoomId = decoded['6'] === undefined || Number(decoded['6']) <= 0 ? null : String(decoded['6']);
    const active = (area || 0) > 0 || (time || 0) > 0 || currentRoomId !== null;
    return {
      raw: decoded,
      rawMode: null,
      state: active ? C.RobotState.CLEANING : C.RobotState.UNKNOWN,
      homeyState: active ? C.HomeyVacuumState.CLEANING : C.HomeyVacuumState.STOPPED,
      battery: null,
      charging: null,
      docked: null,
      fanSpeed: null,
      cleanArea: area,
      cleanTime: time,
      firmware: null,
      error: null,
      sleeping: false,
      deviceId: this.deviceId || null,
      topicPrefix: this.topicPrefix,
      currentRoomId,
    };
  }

  normalizeUpgradeStatus(decoded = {}) {
    const current = decoded['7'] === undefined ? null : String(decoded['7']).replace(/\0+$/g, '').trim();
    const target = decoded['8'] === undefined ? null : String(decoded['8']).replace(/\0+$/g, '').trim();
    return {
      raw: decoded,
      rawMode: null,
      state: C.RobotState.UNKNOWN,
      homeyState: C.HomeyVacuumState.STOPPED,
      battery: null,
      charging: null,
      docked: null,
      fanSpeed: null,
      cleanArea: null,
      cleanTime: null,
      firmware: current || target || null,
      error: null,
      sleeping: false,
      deviceId: this.deviceId || null,
      topicPrefix: this.topicPrefix,
      currentRoomId: null,
    };
  }
}

module.exports = {
  NarwalBinaryProtocol,
  FIELD_TOPIC,
  FIELD_RESPONSE,
  CommandResult,
  COMMAND_TOPICS,
  BROADCAST_TOPICS,
  WORKING_STATE,
  FAN_LEVEL,
  liveFanLevel,
  encodeVarint,
  encodeVarintField,
  encodeStringField,
  buildTopicSubscription,
  buildCleanPayload,
  buildStartCleanPayload,
  WorkMode,
  buildFrame,
  parseFrame,
  parseCommandResponse,
  decodeProto,
  shortTopic,
  topicIdentity,
  toFloat32,
};

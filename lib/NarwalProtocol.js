'use strict';

const {
  RobotState,
  HomeyVacuumState,
  FanSpeed,
} = require('./constants');

/**
 * NarwalProtocol
 *
 * Pure, dependency-free translation layer between the robot's local WebSocket
 * messages and the app's normalized internal model. It contains NO networking
 * and NO Homey references so it can be unit tested in isolation and reused for
 * additional models.
 *
 * The robot speaks JSON over the local WebSocket. Two message shapes are used:
 *
 *   Request:   { "cmd": "<command>", "id": <number>, "params": { ... } }
 *   Reply:     { "cmd": "<command>", "id": <number>, "result": { ... }, "code": 0 }
 *   Push/event:{ "event": "<name>", "data": { ... } }
 *
 * Field names vary slightly between firmware versions, so every reader below is
 * defensive and accepts a small set of aliases. Keep all such knowledge here.
 */

// Logical command names. The wire string is resolved via COMMAND_MAP so we can
// remap per protocol version without changing call sites.
const Command = {
  GET_STATUS: 'get_status',
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'stop',
  DOCK: 'dock',
  LOCATE: 'locate',
  SET_FAN_SPEED: 'set_fan_speed',
  CLEAN_ROOM: 'clean_room',
  GET_MAP: 'get_map',
  GET_ROOMS: 'get_rooms',
};

// Logical command -> wire command for protocol "v1".
const COMMAND_MAP = {
  v1: {
    [Command.GET_STATUS]: 'getStatus',
    [Command.START]: 'startClean',
    [Command.PAUSE]: 'pauseClean',
    [Command.RESUME]: 'resumeClean',
    [Command.STOP]: 'stopClean',
    [Command.DOCK]: 'returnDock',
    [Command.LOCATE]: 'findRobot',
    [Command.SET_FAN_SPEED]: 'setFanLevel',
    [Command.CLEAN_ROOM]: 'startRoomClean',
    [Command.GET_MAP]: 'getMap',
    [Command.GET_ROOMS]: 'getRooms',
  },
};

// Internal fan speed <-> numeric level of the JSON protocol (mock robot).
const FAN_SPEED_TO_LEVEL = {
  [FanSpeed.QUIET]: 0,
  [FanSpeed.NORMAL]: 1,
  [FanSpeed.STRONG]: 2,
  [FanSpeed.MAX]: 3,
  [FanSpeed.ULTRA]: 4,
};
const LEVEL_TO_FAN_SPEED = {
  0: FanSpeed.QUIET,
  1: FanSpeed.NORMAL,
  2: FanSpeed.STRONG,
  3: FanSpeed.MAX,
  4: FanSpeed.ULTRA,
};

/**
 * Raw robot mode/state strings (and a few numeric codes) mapped onto our
 * normalized RobotState. Unknown values fall through to RobotState.UNKNOWN and
 * are logged by the client so we can extend this table.
 */
const RAW_STATE_MAP = {
  // textual variants
  idle: RobotState.IDLE,
  standby: RobotState.IDLE,
  ready: RobotState.IDLE,
  cleaning: RobotState.CLEANING,
  sweeping: RobotState.CLEANING,
  mopping: RobotState.CLEANING,
  working: RobotState.CLEANING,
  paused: RobotState.PAUSED,
  pause: RobotState.PAUSED,
  suspend: RobotState.PAUSED,
  returning: RobotState.RETURNING,
  back: RobotState.RETURNING,
  gohome: RobotState.RETURNING,
  go_home: RobotState.RETURNING,
  docked: RobotState.DOCKED,
  dock: RobotState.DOCKED,
  home: RobotState.DOCKED,
  charging: RobotState.CHARGING,
  charge: RobotState.CHARGING,
  drying: RobotState.DRYING,
  dry: RobotState.DRYING,
  washing: RobotState.WASHING,
  wash: RobotState.WASHING,
  selfclean: RobotState.WASHING,
  error: RobotState.ERROR,
  fault: RobotState.ERROR,
  sleep: RobotState.SLEEPING,
  sleeping: RobotState.SLEEPING,
  standby_sleep: RobotState.SLEEPING,
  // numeric variants (best-effort, firmware dependent)
  0: RobotState.IDLE,
  1: RobotState.CLEANING,
  2: RobotState.PAUSED,
  3: RobotState.RETURNING,
  4: RobotState.CHARGING,
  5: RobotState.DOCKED,
  6: RobotState.ERROR,
  7: RobotState.SLEEPING,
};

// RobotState -> Homey standard vacuumcleaner_state value.
const STATE_TO_HOMEY = {
  [RobotState.IDLE]: HomeyVacuumState.STOPPED,
  [RobotState.CLEANING]: HomeyVacuumState.CLEANING,
  [RobotState.PAUSED]: HomeyVacuumState.STOPPED,
  [RobotState.RETURNING]: HomeyVacuumState.DOCKED,
  [RobotState.DOCKED]: HomeyVacuumState.DOCKED,
  [RobotState.CHARGING]: HomeyVacuumState.CHARGING,
  [RobotState.DRYING]: HomeyVacuumState.DOCKED,
  [RobotState.WASHING]: HomeyVacuumState.DOCKED,
  [RobotState.ERROR]: HomeyVacuumState.STOPPED,
  [RobotState.SLEEPING]: HomeyVacuumState.STOPPED,
  [RobotState.UNKNOWN]: HomeyVacuumState.STOPPED,
};

/** First defined value among the provided keys of an object. */
function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class NarwalProtocol {
  /** @param {string} protocolVersion key into COMMAND_MAP (defaults to v1). */
  constructor(protocolVersion = 'v1') {
    this.version = COMMAND_MAP[protocolVersion] ? protocolVersion : 'v1';
  }

  /** Resolve a logical command to its wire string for this protocol version. */
  wireCommand(command) {
    const wire = COMMAND_MAP[this.version][command];
    if (!wire) throw new Error(`Unknown command: ${command}`);
    return wire;
  }

  /**
   * Build a request frame for the wire. The caller supplies a unique numeric id
   * so replies can be correlated.
   */
  buildRequest(command, params = {}, id = 0) {
    return {
      cmd: this.wireCommand(command),
      id,
      params: params || {},
    };
  }

  /** Convenience builders for the supported commands. */
  buildGetStatus(id) {
    return this.buildRequest(Command.GET_STATUS, {}, id);
  }

  buildStart(id) {
    return this.buildRequest(Command.START, {}, id);
  }

  buildPause(id) {
    return this.buildRequest(Command.PAUSE, {}, id);
  }

  buildResume(id) {
    return this.buildRequest(Command.RESUME, {}, id);
  }

  buildStop(id) {
    return this.buildRequest(Command.STOP, {}, id);
  }

  buildDock(id) {
    return this.buildRequest(Command.DOCK, {}, id);
  }

  buildLocate(id) {
    return this.buildRequest(Command.LOCATE, {}, id);
  }

  buildSetFanSpeed(fanSpeed, id) {
    const level = FAN_SPEED_TO_LEVEL[fanSpeed];
    if (level === undefined) throw new Error(`Invalid fan speed: ${fanSpeed}`);
    return this.buildRequest(Command.SET_FAN_SPEED, { level }, id);
  }

  buildCleanRoom(roomIds, id) {
    const rooms = (Array.isArray(roomIds) ? roomIds : [roomIds])
      .map((r) => (typeof r === 'object' ? r.id : r))
      .filter((r) => r !== undefined && r !== null);
    if (rooms.length === 0) throw new Error('No rooms supplied for room clean');
    return this.buildRequest(Command.CLEAN_ROOM, { rooms }, id);
  }

  buildGetMap(id) {
    return this.buildRequest(Command.GET_MAP, {}, id);
  }

  buildGetRooms(id) {
    return this.buildRequest(Command.GET_ROOMS, {}, id);
  }

  /**
   * Parse an inbound frame (string or object) into a tagged shape:
   *   { type: 'reply',  id, command, ok, code, data }
   *   { type: 'event',  event, data }
   *   { type: 'unknown', raw }
   * Throws only on truly unparseable input.
   */
  parseMessage(raw) {
    let msg = raw;
    if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
      const text = raw.toString('utf8').trim();
      if (!text) return { type: 'unknown', raw: '' };
      msg = JSON.parse(text);
    }
    if (!msg || typeof msg !== 'object') return { type: 'unknown', raw };

    if (msg.event !== undefined) {
      return { type: 'event', event: String(msg.event), data: msg.data || {} };
    }

    if (msg.cmd !== undefined || msg.id !== undefined) {
      const code = toNumber(pick(msg, ['code', 'ret', 'status'], 0), 0);
      return {
        type: 'reply',
        id: toNumber(msg.id, null),
        command: msg.cmd !== undefined ? String(msg.cmd) : null,
        ok: code === 0,
        code,
        data: pick(msg, ['result', 'data', 'payload'], {}),
      };
    }

    return { type: 'unknown', raw: msg };
  }

  /** Map a normalized RobotState to Homey's vacuumcleaner_state value. */
  static toHomeyState(robotState) {
    return STATE_TO_HOMEY[robotState] || HomeyVacuumState.STOPPED;
  }

  /** Map a raw robot mode (string/number) to a normalized RobotState. */
  static normalizeState(rawMode) {
    if (rawMode === undefined || rawMode === null) return RobotState.UNKNOWN;
    const key = String(rawMode).toLowerCase().trim();
    return RAW_STATE_MAP[key] || RobotState.UNKNOWN;
  }

  static fanSpeedFromLevel(level) {
    return LEVEL_TO_FAN_SPEED[toNumber(level, -1)] || null;
  }

  /**
   * Normalize an arbitrary status payload into the app's internal model.
   * Always returns a complete object; missing fields become null so callers can
   * decide whether to update a capability.
   */
  normalizeStatus(payload = {}) {
    const data = payload && typeof payload === 'object' ? payload : {};

    const rawMode = pick(data, ['mode', 'state', 'status', 'workMode', 'work_mode', 'cleanState']);
    const state = NarwalProtocol.normalizeState(rawMode);

    const battery = toNumber(pick(data, ['battery', 'batteryLevel', 'battery_level', 'electricity', 'power']), null);

    let charging = pick(data, ['charging', 'isCharging', 'is_charging', 'charge']);
    if (charging === undefined) charging = state === RobotState.CHARGING ? true : null;
    else charging = Boolean(charging);

    let docked = pick(data, ['docked', 'isDocked', 'is_docked', 'onDock', 'on_dock', 'atHome']);
    if (docked === undefined) {
      docked = (state === RobotState.DOCKED || state === RobotState.CHARGING) ? true : null;
    } else docked = Boolean(docked);

    const fanLevel = pick(data, ['fanLevel', 'fan_level', 'level', 'suction', 'fanSpeed', 'fan_speed']);
    const fanSpeed = fanLevel === undefined ? null : NarwalProtocol.fanSpeedFromLevel(fanLevel);

    // Area in m^2; some firmwares report cm^2, so heuristically convert big values.
    let area = toNumber(pick(data, ['cleanArea', 'clean_area', 'area', 'cleaningArea']), null);
    if (area !== null && area > 1000) area = Math.round((area / 10000) * 10) / 10;

    // Time in minutes; convert seconds when an explicit seconds field is used.
    let time = toNumber(pick(data, ['cleanTime', 'clean_time', 'time', 'cleaningTime']), null);
    const timeSec = toNumber(pick(data, ['cleanTimeSec', 'clean_time_sec', 'durationSec']), null);
    if (time === null && timeSec !== null) time = Math.round(timeSec / 60);

    const firmware = pick(data, ['firmware', 'fwVersion', 'fw_version', 'version', 'softVersion']);
    const errorCode = pick(data, ['error', 'errorCode', 'error_code', 'fault']);
    const error = errorCode && Number(errorCode) !== 0 ? String(errorCode) : null;

    return {
      raw: data,
      rawMode: rawMode === undefined ? null : rawMode,
      state,
      homeyState: NarwalProtocol.toHomeyState(state),
      battery,
      charging,
      docked,
      fanSpeed,
      cleanArea: area,
      cleanTime: time,
      firmware: firmware === undefined ? null : String(firmware),
      error,
      sleeping: state === RobotState.SLEEPING,
    };
  }
}

module.exports = {
  NarwalProtocol,
  Command,
  FAN_SPEED_TO_LEVEL,
  LEVEL_TO_FAN_SPEED,
  RAW_STATE_MAP,
};

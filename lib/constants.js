'use strict';

/**
 * Shared constants for the Narwal local integration.
 *
 * All values that describe the on-the-wire local protocol live here or in
 * NarwalProtocol.js so that firmware-specific tweaks stay in one place and the
 * rest of the app keeps working against a stable, normalized model.
 */

// Default local WebSocket port exposed by supported robots.
const DEFAULT_PORT = 9002;

// Connection / resilience tuning.
const CONNECT_TIMEOUT_MS = 15000; // handshake + first reply budget
const COMMAND_TIMEOUT_MS = 10000; // per request/response budget
const SLOW_COMMAND_TIMEOUT_MS = 15000; // force_end can take longer while robot stops physically
const HEARTBEAT_INTERVAL_MS = 20000; // websocket ping cadence
const HEARTBEAT_TIMEOUT_MS = 45000; // no traffic for this long => reconnect
const POLL_INTERVAL_MS = 60000; // status polling fallback cadence
const SUBSCRIPTION_RENEW_MS = 240000; // broadcast subscription lasts 600 s; renew well inside it

// Narwal robots use a WebSocket++ server that accepts permessage-deflate but
// may stop sending application frames when compression is negotiated. Keep it
// disabled for all real robot connections.
const WEBSOCKET_OPTIONS = {
  perMessageDeflate: false,
};

// Exponential backoff for reconnects.
const RECONNECT_BASE_MS = 2000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER_MS = 1500;
const CONNECTION_STABLE_MS = 30000; // connected this long => reset the backoff
const MAX_QUEUED_RESPONSES = 20; // replies kept while no command waits

/**
 * Normalized, robot-agnostic state model. Raw robot status codes are translated
 * into exactly one of these by NarwalProtocol.normalizeStatus().
 */
const RobotState = {
  IDLE: 'idle',
  CLEANING: 'cleaning',
  PAUSED: 'paused',
  RETURNING: 'returning',
  DOCKED: 'docked',
  CHARGING: 'charging',
  DRYING: 'drying',
  WASHING: 'washing',
  ERROR: 'error',
  SLEEPING: 'sleeping',
  UNKNOWN: 'unknown',
};

/**
 * Homey's standard `vacuumcleaner_state` enum. We map our internal RobotState
 * onto these so the standard tile and Flow ecosystem work out of the box.
 */
const HomeyVacuumState = {
  CLEANING: 'cleaning',
  SPOT_CLEANING: 'spot_cleaning',
  DOCKED: 'docked',
  CHARGING: 'charging',
  STOPPED: 'stopped',
};

// Fan speed identifiers used across capabilities, Flow cards and the protocol.
// Labels follow the official app: Quiet, Standard, Strong, Super Powerful,
// Ultra Powerful. The ids predate those labels and stay for existing Flows.
const FanSpeed = {
  QUIET: 'quiet',
  NORMAL: 'normal',
  STRONG: 'strong',
  MAX: 'max',
  ULTRA: 'ultra',
};

const FAN_SPEED_VALUES = [FanSpeed.QUIET, FanSpeed.NORMAL, FanSpeed.STRONG, FanSpeed.MAX, FanSpeed.ULTRA];

// Models whose official app tops out at Super Powerful.
const NO_ULTRA_FAN_PRODUCT_KEYS = [
  'qV6BujoYLz', // Freo Z10 Pro / Turbo
];

function normalizeFanSpeed(fanSpeed, productKey = '') {
  const key = String(productKey || '').replace(/^\//, '');
  if (fanSpeed === FanSpeed.ULTRA && NO_ULTRA_FAN_PRODUCT_KEYS.includes(key)) return FanSpeed.MAX;
  return fanSpeed;
}

const CommandResult = {
  SUCCESS: 1,
  NOT_APPLICABLE: 2,
  CONFLICT: 3,
  NOT_READY: 4,
};

const COMMAND_RESULT_MESSAGES = {
  [CommandResult.NOT_APPLICABLE]: 'Robot cannot run that command in its current state.',
  [CommandResult.CONFLICT]: 'Robot is busy with another task.',
  [CommandResult.NOT_READY]: 'Robot is not ready for that command yet.',
};

const BinaryCommandTopic = {
  START_PLAN: 'clean/plan/start',
  START_CLEAN: 'clean/start_clean',
  PAUSE: 'task/pause',
  RESUME: 'task/resume',
  FORCE_END: 'task/force_end',
  CANCEL: 'task/cancel',
  RECALL: 'supply/recall',
  YELL: 'common/yell',
  SET_FAN_LEVEL: 'clean/set_fan_level',
  GET_BASE_STATUS: 'status/get_device_base_status',
  GET_MAP: 'map/get_map',
  GET_ALL_REDUCED_MAPS: 'map/get_all_reduced_maps',
};

const KNOWN_PRODUCT_KEYS = [
  'QoEsI5qYXO', // Narwal Flow / AX12
  'QxMSPG6VSO', // Narwal Flow 2
  'iSuVlI1If2', // Narwal Flow 2 alternate key
  'mkbqaprvrb', // Narwal Flow 2 alternate key
  'DrzDKQ0MU8', // Freo Z10 Ultra
  'qV6BujoYLz', // Freo Z10 Pro / Turbo family
  'hEA7OEshlx', // Freo Z Ultra family
  'BYWBPqSxeC', // Freo Z Ultra alternate discovery key
  'fjhpiem4ba', // Freo 20 family
  'CGjuB6dzq7', // JX family
  'CNbforyZWI', // Freo X10 Pro
  // Known from app metadata / discovery research; not exposed as Homey drivers
  // until someone validates the local protocol behavior on real hardware.
  'LnugwMG9ss', // Freo X Ultra family, known to use a different local stack
  '5OMbqk58Sc', // Freo X Ultra family
  'tPQJmoIbEC', // AX6 family
  'HgArZ7KuJL', // AX7 family
  'Uuug39n0fD', // AX8 family
  'E9Q8aDzUbp', // AX17 family
  'jI5rHi4mKa', // AX24 family
  'UuTSLsMce4', // AX25 family
  '88OLXLpkjT', // BX4 family
  '3rIGshGNAj', // BX4 / Y1 alternate family
  '7sSZZ4XfTI', // CX2 family
  'OlkUn3oUCu', // CX3 family
  'mvlduyye85', // X30 family
  'pcbfh2ldvx', // X31 family
  'EHf6cRNRGT', // J4 / J4 Pure family
  '6NjIDYxBXb', // J4 Lite family
  'cUlfJN5JYP', // Unknown Narwal family
];

const PRODUCT_KEY_MODEL_NAMES = {
  QoEsI5qYXO: 'Narwal Flow / AX12',
  QxMSPG6VSO: 'Narwal Flow 2',
  iSuVlI1If2: 'Narwal Flow 2',
  mkbqaprvrb: 'Narwal Flow 2',
  DrzDKQ0MU8: 'Freo Z10 Ultra',
  qV6BujoYLz: 'Freo Z10 Pro / Turbo',
  CNbforyZWI: 'Freo X10 Pro',
  hEA7OEshlx: 'Freo Z Ultra',
  BYWBPqSxeC: 'Freo Z Ultra',
  fjhpiem4ba: 'Narwal Freo 20',
  CGjuB6dzq7: 'Narwal JX',
};

const LIMITED_BROADCAST_PRODUCT_KEYS = [
  'hEA7OEshlx',
];

const DIFFERENT_LOCAL_STACK_PRODUCT_KEYS = [
  'LnugwMG9ss',
  '5OMbqk58Sc',
];

function modelNameForProductKey(productKey) {
  return PRODUCT_KEY_MODEL_NAMES[String(productKey || '').replace(/^\//, '')] || null;
}

/**
 * Supported models (expose the local WebSocket API on the default port).
 * `id` is stored in the device store; `protocol` lets us branch later if a
 * model needs different payloads without touching the rest of the app.
 */
const SUPPORTED_MODELS = [
  {
    id: 'narwal_flow_ax12', name: 'Narwal Flow / AX12', protocol: 'v1', productKey: 'QoEsI5qYXO',
  },
  {
    id: 'narwal_flow_2', name: 'Narwal Flow 2', protocol: 'v1', productKey: 'QxMSPG6VSO',
  },
  {
    id: 'freo_z10_ultra', name: 'Freo Z10 Ultra', protocol: 'v1', productKey: 'DrzDKQ0MU8',
  },
  {
    id: 'freo_z10_pro_turbo', name: 'Freo Z10 Pro / Turbo', protocol: 'v1', productKey: 'qV6BujoYLz',
  },
  {
    id: 'freo_x10_pro', name: 'Freo X10 Pro', protocol: 'v1', productKey: 'CNbforyZWI',
  },
  {
    id: 'freo_20', name: 'Narwal Freo 20', protocol: 'v1', productKey: 'fjhpiem4ba',
  },
];

/**
 * Models that are known to be unsupported or unverified because they are
 * cloud-only or appear to use a different protocol. Documented so the UI and
 * README can warn users instead of failing silently.
 */
const UNSUPPORTED_MODELS = [
  'Freo X Ultra',
  'Freo X Plus',
  'J-series models except local-WebSocket JX-family models',
];

module.exports = {
  DEFAULT_PORT,
  CONNECT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  SLOW_COMMAND_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  SUBSCRIPTION_RENEW_MS,
  WEBSOCKET_OPTIONS,
  RECONNECT_BASE_MS,
  RECONNECT_FACTOR,
  RECONNECT_MAX_MS,
  RECONNECT_JITTER_MS,
  CONNECTION_STABLE_MS,
  MAX_QUEUED_RESPONSES,
  RobotState,
  HomeyVacuumState,
  FanSpeed,
  FAN_SPEED_VALUES,
  NO_ULTRA_FAN_PRODUCT_KEYS,
  normalizeFanSpeed,
  CommandResult,
  COMMAND_RESULT_MESSAGES,
  BinaryCommandTopic,
  KNOWN_PRODUCT_KEYS,
  PRODUCT_KEY_MODEL_NAMES,
  LIMITED_BROADCAST_PRODUCT_KEYS,
  DIFFERENT_LOCAL_STACK_PRODUCT_KEYS,
  modelNameForProductKey,
  SUPPORTED_MODELS,
  UNSUPPORTED_MODELS,
};

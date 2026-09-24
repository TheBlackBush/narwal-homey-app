'use strict';

const { WorkMode } = require('./NarwalBinaryProtocol');
const { FAN_SPEED_VALUES } = require('./constants');

/**
 * Turns the device's clean settings, optionally overridden by Flow card
 * arguments, into the options buildStartCleanPayload() understands. Pure and
 * Homey-free so it can be unit tested.
 */

// Flow card value meaning "use the device setting".
const DEVICE_SETTING = 'device';

const WORK_MODES = {
  vacuum_and_mop: WorkMode.VACUUM_AND_MOP,
  vacuum: WorkMode.VACUUM,
  mop: WorkMode.MOP,
  vacuum_then_mop: WorkMode.VACUUM_THEN_MOP,
};
const WATER_LEVELS = { dry: 1, normal: 2, wet: 3 };
const MOP_STRENGTHS = { normal: 1, high: 2 };
const PASSES = { 1: 1, 2: 2, 3: 3 };
// 'robot' leaves the route out so the robot keeps its own choice.
const ROUTES = { robot: null, standard: 1, meticulous: 2 };

const DEFAULTS = {
  workMode: 'vacuum_and_mop',
  water: 'normal',
  mopStrength: 'normal',
  passes: '1',
  route: 'robot',
};

function pick(table, override, setting, fallback) {
  for (const value of [override, setting]) {
    if (value !== undefined && value !== null && value !== DEVICE_SETTING
      && Object.prototype.hasOwnProperty.call(table, value)) {
      return table[value];
    }
  }
  return table[fallback];
}

function resolveCleanOptions(settings = {}, overrides = {}) {
  const options = {
    workMode: pick(WORK_MODES, overrides.work_mode, settings.clean_work_mode, DEFAULTS.workMode),
    water: pick(WATER_LEVELS, overrides.water, settings.clean_water, DEFAULTS.water),
    mopStrength: pick(MOP_STRENGTHS, overrides.mop_strength, settings.clean_mop_strength, DEFAULTS.mopStrength),
    passes: pick(PASSES, overrides.passes, settings.clean_passes, DEFAULTS.passes),
  };
  const route = pick(ROUTES, overrides.route, settings.clean_route, DEFAULTS.route);
  if (route !== null) options.route = route;
  if (FAN_SPEED_VALUES.includes(overrides.suction)) options.fanSpeed = overrides.suction;
  return options;
}

const SETTING_TABLES = {
  clean_work_mode: [WORK_MODES, DEFAULTS.workMode],
  clean_water: [WATER_LEVELS, DEFAULTS.water],
  clean_mop_strength: [MOP_STRENGTHS, DEFAULTS.mopStrength],
  clean_passes: [PASSES, DEFAULTS.passes],
  clean_route: [ROUTES, DEFAULTS.route],
};

/**
 * Settings added by an app update are not stored on devices paired earlier,
 * so the Homey app shows "-" for them. Returns every clean setting with its
 * current value when valid, otherwise the default, ready for setSettings().
 */
function cleanSettingsToPersist(settings = {}) {
  const result = {};
  for (const [id, [table, fallback]] of Object.entries(SETTING_TABLES)) {
    const value = settings[id];
    result[id] = value !== undefined && Object.prototype.hasOwnProperty.call(table, value) ? String(value) : fallback;
  }
  return result;
}

module.exports = { resolveCleanOptions, cleanSettingsToPersist, DEVICE_SETTING };

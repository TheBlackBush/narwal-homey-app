'use strict';

const { modelNameForProductKey, SUPPORTED_MODELS } = require('../constants');
const { matchesDeviceId } = require('../Discovery');

const DRIVER_MODEL_NAMES = new Set(SUPPORTED_MODELS.map((model) => model.name));

/**
 * Sorts the Narwal account's robots for one model's pairing screen:
 * 'match' (this model), 'other' (another model with a driver) or
 * 'unsupported'. Adds whether the robot is already paired and its local IP
 * when mDNS has seen it (the device id ends with the advertised suffix).
 */
function cloudPairEntries(robots = [], model, existingIds = [], localRobots = []) {
  return robots.map((robot) => {
    const modelName = modelNameForProductKey(robot.productId);
    let group = 'unsupported';
    if (modelName === model.name) group = 'match';
    else if (DRIVER_MODEL_NAMES.has(modelName)) group = 'other';
    const local = localRobots.find((entry) => matchesDeviceId(robot.deviceId, entry.suffix));
    return {
      deviceId: robot.deviceId,
      productId: robot.productId,
      name: robot.name,
      modelName: modelName || 'Unknown model',
      group,
      added: existingIds.includes(robot.deviceId),
      ip: local ? local.ip : '',
    };
  });
}

module.exports = { cloudPairEntries };

'use strict';

const { modelNameForProductKey, SUPPORTED_MODELS } = require('./constants');

const DRIVER_MODEL_NAMES = new Set(SUPPORTED_MODELS.map((model) => model.name));

/**
 * Pure helpers for mDNS discovery. Robots advertise
 * `_app_wss_server_<6 hex>._narwal_sweeper._tcp` with host `NARWAL_<6 hex>`;
 * the 6 hex characters are the end of the robot's 32-character device id.
 */

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const SUFFIX_RE = /(?:_app_wss_server_|narwal_)([0-9a-f]{6})(?![0-9a-f])/i;

function suffixFromName(name) {
  const match = SUFFIX_RE.exec(String(name || ''));
  return match ? match[1].toLowerCase() : null;
}

function resultSuffix(result = {}) {
  return suffixFromName(result.name) || suffixFromName(result.host);
}

// Robots also advertise IPv6; only IPv4 is used as a connection host.
function pickIPv4(result = {}) {
  const candidates = [result.address, ...(Array.isArray(result.addresses) ? result.addresses : [])];
  return candidates.find((address) => IPV4_RE.test(String(address || ''))) || null;
}

function matchesDeviceId(deviceId, suffix) {
  if (!deviceId || !suffix) return false;
  return String(deviceId).toLowerCase().endsWith(String(suffix).toLowerCase());
}

function uniqueResults(results = []) {
  const bySuffix = new Map();
  for (const result of results) {
    const suffix = resultSuffix(result);
    const ip = pickIPv4(result);
    if (suffix && ip && !bySuffix.has(suffix)) bySuffix.set(suffix, { suffix, ip });
  }
  return [...bySuffix.values()];
}

// Paired robots are recognised from their stored device id before any probe,
// so they are not probed again while their device holds a live connection.
function markAdded(found = [], existingIds = []) {
  return found.map((robot) => ({
    ...robot,
    added: existingIds.some((id) => matchesDeviceId(id, robot.suffix)),
  }));
}

function buildPairEntry({
  ip, port, suffix = null, probe = null, error = null,
}, model, existingIds = new Set()) {
  const productKey = probe && probe.topicPrefix ? String(probe.topicPrefix).replace(/^\//, '') : null;
  const deviceId = probe && probe.deviceId ? String(probe.deviceId) : null;
  const modelName = productKey ? modelNameForProductKey(productKey) : null;
  let group = 'unknown';
  // "other" only points to models that have a driver; the rest are unknown.
  if (!error && modelName === model.name) group = 'match';
  else if (!error && DRIVER_MODEL_NAMES.has(modelName)) group = 'other';
  return {
    ip,
    port,
    suffix,
    group,
    modelName,
    deviceId,
    productKey,
    added: Boolean(deviceId && existingIds.has(deviceId)),
  };
}

module.exports = {
  suffixFromName,
  resultSuffix,
  pickIPv4,
  matchesDeviceId,
  uniqueResults,
  markAdded,
  buildPairEntry,
};

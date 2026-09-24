'use strict';

const { resultSuffix, pickIPv4, matchesDeviceId } = require('./Discovery');

/**
 * Routes mDNS discovery results to paired devices so they follow IP changes.
 * Homey's strategy emits 'result' only for new results; a known result emits
 * 'addressChanged' itself. Discovery is optional, so nothing here throws.
 */
class DiscoveryWatcher {
  constructor({
    strategy, getDevices, log = () => {}, error = () => {},
  }) {
    this.strategy = strategy || null;
    this.getDevices = getDevices;
    this.log = log;
    this.error = error;
    this._tracked = new WeakSet();
  }

  start() {
    if (!this.strategy) return;
    this.strategy.on('result', (result) => {
      this._track(result);
      this._route(result, this.getDevices());
    });
    for (const result of this._results()) this._track(result);
  }

  // Devices start after the app, so each checks the robots already found.
  checkDevice(device) {
    for (const result of this._results()) this._route(result, [device]);
  }

  _results() {
    if (!this.strategy) return [];
    try {
      return Object.values(this.strategy.getDiscoveryResults() || {});
    } catch (err) {
      this.log(`mDNS discovery unavailable: ${err.message}`);
      return [];
    }
  }

  _track(result) {
    if (!result || typeof result.on !== 'function' || this._tracked.has(result)) return;
    this._tracked.add(result);
    result.on('addressChanged', () => this._route(result, this.getDevices()));
  }

  _route(result, devices) {
    const suffix = resultSuffix(result);
    const ip = pickIPv4(result);
    if (!suffix || !ip) return;
    for (const device of devices) {
      if (matchesDeviceId(device.getStoreValue('deviceId'), suffix)) {
        device.onDiscoveredAddress(ip).catch((err) => this.error('IP update failed:', err.message));
      }
    }
  }
}

module.exports = { DiscoveryWatcher };

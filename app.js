'use strict';

const Homey = require('homey');
const { DiscoveryWatcher } = require('./lib/DiscoveryWatcher');
const { CloudAccountManager } = require('./lib/cloud/CloudAccountManager');

/**
 * Narwal app entry point.
 *
 * The app itself is intentionally thin: all robot communication lives in the
 * device/driver layer and the reusable client in lib/. This keeps the app
 * resilient — a failure talking to one robot can never crash the app process.
 */
class NarwalApp extends Homey.App {
  async onInit() {
    this._narwalDevices = new Set();
    this.log('Narwal app initialized');

    // Surface unexpected async failures in the log instead of crashing.
    process.on('unhandledRejection', (reason) => {
      this.error('Unhandled rejection:', reason);
    });

    // Follow robots that move to a new IP. Discovery is optional: robots that
    // never appear in mDNS keep their saved IP.
    let strategy = null;
    try {
      strategy = this.homey.discovery.getStrategy('narwal');
    } catch (err) {
      this.log(`mDNS discovery unavailable: ${err.message}`);
    }
    this._discoveryWatcher = new DiscoveryWatcher({
      strategy,
      getDevices: () => [...this._narwalDevices],
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });
    this._discoveryWatcher.start();

    // Optional Narwal account (cloud connection). Devices set to use the
    // cloud reconnect when the user signs in or out.
    this.cloud = new CloudAccountManager({ settings: this.homey.settings });
    this.cloud.on('changed', (event) => {
      // Reconnect when the mode changes, or when the account changes in cloud mode.
      if (!event.modeChanged && event.mode !== 'cloud') return;
      for (const device of this._narwalDevices) {
        if (typeof device.onConnectionChanged === 'function') device.onConnectionChanged();
      }
    });
  }

  getCloudStatus() {
    return this.cloud.status();
  }

  getConnectionMode() {
    return this.cloud ? this.cloud.getMode() : 'local';
  }

  setConnectionMode({ mode } = {}) {
    this.cloud.setMode(mode);
    return this.cloud.status();
  }

  async cloudLoginWithPassword({
    email, password, country, adult,
  } = {}) {
    await this.cloud.loginWithPassword({
      email, password, country, adult,
    });
    return this.cloud.status();
  }

  async cloudRequestEmailCode({ email, country, adult } = {}) {
    await this.cloud.requestEmailCode({ email, country, adult });
    return { sent: true };
  }

  async cloudLoginWithEmailCode({
    email, code, country, adult,
  } = {}) {
    await this.cloud.loginWithEmailCode({
      email, code, country, adult,
    });
    return this.cloud.status();
  }

  cloudLogout() {
    this.cloud.logout();
    return this.cloud.status();
  }

  registerNarwalDevice(device) {
    this._narwalDevices.add(device);
  }

  // Called by a device once its client has started.
  checkDiscoveredAddress(device) {
    if (this._discoveryWatcher) this._discoveryWatcher.checkDevice(device);
  }

  unregisterNarwalDevice(device) {
    this._narwalDevices.delete(device);
  }

  _getNarwalDevice(deviceId) {
    const devices = [...this._narwalDevices];
    if (!deviceId) return devices[0] || null;
    return devices.find((device) => device.getId() === deviceId) || null;
  }

  _getDeviceAvailable(device) {
    return typeof device.getAvailable === 'function' ? device.getAvailable() : true;
  }

  getDevicesData() {
    return [...this._narwalDevices].map((device) => {
      const settings = device.getSettings();
      const rooms = device.getStoreValue('rooms') || [];
      return {
        id: device.getId(),
        name: device.getName(),
        driverId: device.driver && device.driver.id ? device.driver.id : null,
        available: this._getDeviceAvailable(device),
        ip: settings.ip || '',
        port: settings.port || 9002,
        state: device.getCapabilityValue('narwal_status') || device.getCapabilityValue('vacuumcleaner_state') || 'Unknown',
        battery: device.getCapabilityValue('measure_battery'),
        connected: device.getCapabilityValue('narwal_connected') === true,
        docked: device.getCapabilityValue('narwal_docked') === true,
        charging: device.getCapabilityValue('narwal_charging') === true,
        area: device.getCapabilityValue('narwal_clean_area'),
        time: device.getCapabilityValue('narwal_clean_time'),
        firmware: device.getCapabilityValue('narwal_firmware') || '',
        lastUpdate: device.getStoreValue('last_status_at') || '',
        lastError: device.getCapabilityValue('narwal_last_error') || '',
        currentRoom: device.getCapabilityValue('narwal_current_room') || '',
        rooms: rooms.map((room) => ({
          id: room.id,
          name: room.name,
          subtype: room.subtype || 0,
          category: room.category || 0,
          instanceIndex: room.instanceIndex || 0,
        })),
        defaultRooms: typeof device.getDefaultRoomsData === 'function' ? device.getDefaultRoomsData() : null,
        commandHistory: typeof device.getCommandHistory === 'function' ? device.getCommandHistory() : [],
      };
    });
  }

  getWidgetDeviceData(deviceId) {
    const device = this._getNarwalDevice(deviceId);
    if (!device) throw new Error('No Narwal vacuum selected.');

    const data = this.getDevicesData().find((item) => item.id === device.getId());
    // Object.assign keeps this compatible with Homey's configured Node syntax target.
    // eslint-disable-next-line prefer-object-spread
    return Object.assign({}, data, {
      hasMap: typeof device.hasMap === 'function' ? device.hasMap() : false,
      mapUpdatedAt: device.getStoreValue('map_updated_at') || null,
    });
  }

  getWidgetMap(deviceId) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.getMapData !== 'function') {
      throw new Error('No Narwal vacuum selected.');
    }
    return device.getMapData();
  }

  getWidgetRooms(deviceId) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.getRoomsData !== 'function') throw new Error('No Narwal vacuum selected.');
    return {
      rooms: device.getRoomsData(),
      roomsUpdatedAt: device.getStoreValue('rooms_updated_at') || null,
    };
  }

  getWidgetDefaultRooms(deviceId) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.getDefaultRoomsData !== 'function') throw new Error('No Narwal vacuum selected.');
    return device.getDefaultRoomsData();
  }

  async setWidgetDefaultRooms(deviceId, roomIds, enable = null) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.setDefaultRoomIds !== 'function') throw new Error('No Narwal vacuum selected.');
    return device.setDefaultRoomIds(roomIds, { enable });
  }

  async cleanWidgetRooms(deviceId, roomIds) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.cleanRooms !== 'function') throw new Error('No Narwal vacuum selected.');
    await device.cleanRooms(roomIds);
    return { ok: true };
  }

  async refreshWidgetMap(deviceId) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.refreshRoomsAndMap !== 'function') throw new Error('No Narwal vacuum selected.');
    const rooms = await device.refreshRoomsAndMap();
    return {
      rooms,
      hasMap: typeof device.hasMap === 'function' ? device.hasMap() : false,
      mapUpdatedAt: device.getStoreValue('map_updated_at') || null,
    };
  }

  async refreshSettingsRoomsMap(deviceId) {
    const device = this._getNarwalDevice(deviceId);
    if (!device || typeof device.refreshRoomsAndMap !== 'function') throw new Error('No Narwal vacuum selected.');
    const rooms = await device.refreshRoomsAndMap();
    return {
      ok: true,
      deviceId: device.getId(),
      rooms,
      roomsUpdatedAt: device.getStoreValue('rooms_updated_at') || null,
      mapUpdatedAt: device.getStoreValue('map_updated_at') || null,
    };
  }
}

module.exports = NarwalApp;

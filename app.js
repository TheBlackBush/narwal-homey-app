'use strict';

const Homey = require('homey');
const { resultSuffix, pickIPv4, matchesDeviceId } = require('./lib/Discovery');

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
    try {
      this._discoveryStrategy = this.homey.discovery.getStrategy('narwal');
      this._discoveryStrategy.on('result', (result) => this._onDiscoveryResult(result));
    } catch (err) {
      this.log(`mDNS discovery unavailable: ${err.message}`);
    }
  }

  _onDiscoveryResult(result, devices = this._narwalDevices) {
    const suffix = resultSuffix(result);
    const ip = pickIPv4(result);
    if (!suffix || !ip) return;
    for (const device of devices) {
      if (matchesDeviceId(device.getStoreValue('deviceId'), suffix)) {
        device.onDiscoveredAddress(ip).catch((err) => this.error('IP update failed:', err.message));
      }
    }
  }

  // Devices start after the app, so check robots already found when each
  // device registers, not only on new discovery results.
  _checkDiscoveredAddress(device) {
    if (!this._discoveryStrategy) return;
    const results = Object.values(this._discoveryStrategy.getDiscoveryResults() || {});
    for (const result of results) this._onDiscoveryResult(result, [device]);
  }

  registerNarwalDevice(device) {
    this._narwalDevices.add(device);
    this._checkDiscoveredAddress(device);
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

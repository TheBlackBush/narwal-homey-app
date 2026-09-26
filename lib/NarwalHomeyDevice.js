'use strict';

const Homey = require('homey');
const { NarwalClient } = require('./NarwalClient');
const { chooseConnection } = require('./cloud/connectionMode');
const { MapParser } = require('./MapParser');
const { resolveCleanOptions, cleanSettingsToPersist } = require('./CleanOptions');
const { RobotState, FanSpeed } = require('./constants');

// Special targets offered by the "Clean with settings" Flow card.
const CLEAN_TARGET_WHOLE_HOME = '__whole_home__';
const CLEAN_TARGET_DEFAULT_ROOMS = '__default_rooms__';

const STATUS_LABELS = {
  [RobotState.IDLE]: 'Idle',
  [RobotState.CLEANING]: 'Cleaning',
  [RobotState.PAUSED]: 'Paused',
  [RobotState.RETURNING]: 'Returning to dock',
  [RobotState.DOCKED]: 'Docked',
  [RobotState.CHARGING]: 'Charging',
  [RobotState.DRYING]: 'Drying mop',
  [RobotState.WASHING]: 'Washing mop',
  [RobotState.ERROR]: 'Error',
  [RobotState.SLEEPING]: 'Sleeping',
  [RobotState.UNKNOWN]: 'Unknown',
};

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `
${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`.trim();
}

function normalizeRooms(rooms = []) {
  return (Array.isArray(rooms) ? rooms : [])
    .map((room, index) => {
      const id = room && room.id !== undefined ? String(room.id) : String(index + 1);
      const fallback = `Room ${id}`;
      const name = room && room.name ? String(room.name).trim() : fallback;
      return {
        id,
        name: name || fallback,
        // Rooms saved before 1.3.0 used subtype / instanceIndex.
        type: Number(room && (room.type ?? room.subtype)) || 0,
        texture: Number(room && room.texture) || 0,
        roomTypeId: Number(room && (room.roomTypeId ?? room.instanceIndex)) || 0,
      };
    })
    .filter((room) => room.id);
}

function parseRoomIds(value) {
  if (Array.isArray(value)) return value.map((id) => String(id).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const EMPTY_ROOMS_LABEL = 'No rooms cached yet. Open App Settings and press Refresh rooms / map.';

function formatRoomsSummary(rooms = []) {
  const normalized = normalizeRooms(rooms);
  if (!normalized.length) return EMPTY_ROOMS_LABEL;
  return normalized.map((room) => `${room.id}: ${room.name}`).join('\n');
}

/**
 * NarwalDevice
 *
 * Bridges a single robot (via NarwalClient) to Homey capabilities and Flow
 * cards. It holds no protocol knowledge of its own; it translates normalized
 * status into capability values and fires Flow triggers on meaningful changes.
 */
class NarwalDevice extends Homey.Device {
  async onInit() {
    this.log(`Narwal device "${this.getName()}" initializing`);

    // Baselines for change-detection triggers.
    this._prev = {
      state: null,
      docked: null,
      charging: null,
      battery: null,
    };

    this.homey.app.registerNarwalDevice(this);
    await this._ensureRuntimeCapabilities();
    await this._persistCleanSettings().catch((err) => this.error('clean settings migration failed:', err));
    await this._syncRoomsSettings().catch((err) => this.log(`room settings sync skipped: ${err.message}`));
    this._registerCapabilityListeners();
    this._startClient();
    // After the client exists, so a new IP restarts it instead of racing it.
    this.homey.app.checkDiscoveredAddress(this);
  }

  // Runs once per device: write the Cleaning mode settings added in 1.1.0 so
  // the Homey app shows their values on devices paired before that release.
  async _persistCleanSettings() {
    if (this.getStoreValue('clean_settings_persisted')) return;
    await this.setSettings(cleanSettingsToPersist(this.getSettings()));
    await this.setStoreValue('clean_settings_persisted', true);
  }

  // ---- Client lifecycle --------------------------------------------------

  _settings() {
    const s = this.getSettings();
    return {
      ip: String(s.ip || '').trim(),
      port: Number(s.port) || 9002,
      model: s.model || this.getStoreValue('model') || 'narwal_flow_2',
      pollInterval: (Number(s.poll_interval) || 60) * 1000,
      mock: Boolean(s.dev_mock) || process.env.NARWAL_MOCK === '1',
      protocol: this.getStoreValue('protocol') || 'v1',
      productKey: this.getStoreValue('productKey') || 'QxMSPG6VSO',
      deviceId: this.getStoreValue('deviceId') || '',
      connectionMode: this.homey.app && typeof this.homey.app.getConnectionMode === 'function' ? this.homey.app.getConnectionMode() : 'local',
    };
  }

  _startClient() {
    this._stopClient();
    const cfg = this._settings();
    const cloudManager = this.homey.app && this.homey.app.cloud;
    const cloudAccount = cloudManager ? cloudManager.getAccount() : null;
    const connection = chooseConnection({
      mode: cfg.connectionMode, account: cloudAccount, deviceId: cfg.deviceId, ip: cfg.ip, mock: cfg.mock,
    });
    if (connection.error) {
      this.log(`Not connecting: ${connection.error}`);
      this.setUnavailable(connection.error).catch(() => {});
      return;
    }
    this._client = new NarwalClient({
      cloud: connection.cloud,
      ip: cfg.ip,
      port: cfg.port,
      protocol: cfg.protocol,
      pollInterval: cfg.pollInterval,
      mock: cfg.mock,
      productKey: cfg.productKey,
      deviceId: cfg.deviceId,
      fanSpeed: this.getCapabilityValue('narwal_fan_speed'),
    });

    this._client.on('log', (msg) => this.log(msg));
    this._client.on('error', (err) => this._onClientError(err));
    this._client.on('status', (status) => this._onStatus(status).catch((e) => this.error(e)));
    this._client.on('map', (map) => this._onMap(map).catch((e) => this.error(e)));
    this._client.on('rooms', (rooms) => this._onRooms(rooms));
    this._client.on('connected', () => this._onConnected());
    this._client.on('disconnected', () => this._onDisconnected());
    this._client.on('sleeping', () => this.log('Robot appears to be asleep; will keep retrying.'));

    this._client.start();
    if (connection.cloud) this._checkCloudAccount().catch((err) => this.error(err));
  }

  // Cloud mode only: is this robot on the signed-in account? Reports counts
  // and a yes/no, never IDs, so it can be shown on the settings page.
  async _checkCloudAccount() {
    const account = this.homey.app && this.homey.app.cloud ? this.homey.app.cloud.getAccount() : null;
    if (!account || !account.signedIn) return null;
    const cfg = this._settings();
    try {
      const robots = await account.listRobots();
      this._cloudCheck = {
        onAccount: robots.some((robot) => robot.deviceId === cfg.deviceId),
        accountRobots: robots.length,
        sameModelRobots: robots.filter((robot) => robot.productId === cfg.productKey).length,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      this._cloudCheck = { error: err.message, checkedAt: new Date().toISOString() };
    }
    if (this._cloudCheck.onAccount === false) this.log('This robot\'s ID is not on the Narwal account');
    return this._cloudCheck;
  }

  /** Connection diagnostics for the settings page. No IDs or payloads. */
  getDiagnostics() {
    return {
      client: this._client && typeof this._client.diagnostics === 'function' ? this._client.diagnostics() : null,
      cloudAccount: this._cloudCheck || null,
      cloudSession: this._cloudSessionDiagnostics(),
    };
  }

  _cloudSessionDiagnostics() {
    const account = this.homey.app && this.homey.app.cloud ? this.homey.app.cloud.getAccount() : null;
    return account && typeof account.diagnostics === 'function' ? account.diagnostics() : null;
  }

  _stopClient() {
    if (this._restartTimer) {
      this.homey.clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._client) {
      this._client.stop();
      this._client.removeAllListeners();
      this._client = null;
    }
  }

  // One pending restart at a time; defer so new settings are persisted first.
  _restartClient() {
    this._stopClient();
    this._restartTimer = this.homey.setTimeout(() => {
      this._restartTimer = null;
      this._startClient();
    }, 500);
  }

  async onSettings({ changedKeys, newSettings }) {
    const settings = newSettings || this.getSettings();
    if (changedKeys.some((k) => ['default_room_ids', 'use_default_rooms_for_start'].includes(k))) {
      await this._validateDefaultRoomSettings(settings);
      const ids = parseRoomIds(settings.default_room_ids);
      if (ids.length && changedKeys.includes('default_room_ids') && !changedKeys.includes('use_default_rooms_for_start')
        && settings.use_default_rooms_for_start !== true) {
        await this.setSettings({ use_default_rooms_for_start: true }).catch((err) => {
          this.log(`auto-enable default rooms skipped: ${err.message}`);
        });
      }
    }

    // Any connection-affecting change rebuilds the client.
    const relevant = ['ip', 'port', 'poll_interval', 'dev_mock'];
    if (changedKeys.some((k) => relevant.includes(k))) {
      this.log(`Settings changed (${changedKeys.join(', ')}); reconnecting`);
      this._restartClient();
    }
  }

  // The app's connection mode or Narwal account changed in the app settings.
  onConnectionChanged() {
    this._restartClient();
  }

  // The robot reappeared in mDNS; follow it when its IP changed.
  async onDiscoveredAddress(ip) {
    const settings = this.getSettings();
    if (settings.dev_mock || !ip || ip === String(settings.ip || '').trim() || ip === this._followingIp) return false;
    this._followingIp = ip;
    try {
      this.log(`Robot found at a new address (${ip}); reconnecting`);
      await this.setSettings({ ip });
      this._restartClient();
      return true;
    } finally {
      this._followingIp = null;
    }
  }

  async onDeleted() {
    this.log('Device deleted; stopping client');
    this.homey.app.unregisterNarwalDevice(this);
    this._stopClient();
  }

  async onUninit() {
    this.homey.app.unregisterNarwalDevice(this);
    this._stopClient();
  }

  // ---- Capability registration ------------------------------------------

  async _ensureRuntimeCapabilities() {
    const capabilities = [
      'narwal_connected',
      'narwal_status',
      'narwal_last_error',
      'narwal_current_room',
    ];
    for (const capabilityId of capabilities) {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch((err) => this.error(`add ${capabilityId}:`, err.message));
      }
    }
    await this._setCapabilityValueIfChanged('narwal_connected', false);
    await this._setCapabilityValueIfChanged('narwal_status', 'Starting');
    await this._setCapabilityValueIfChanged('narwal_last_error', 'None');

    const removedCapabilities = ['narwal_last_update', 'button.refresh_status', 'button.refresh_rooms_map'];
    for (const capabilityId of removedCapabilities) {
      if (this.hasCapability(capabilityId)) {
        await this.removeCapability(capabilityId).catch((err) => this.error(`remove ${capabilityId}:`, err.message));
      }
    }
  }

  async _setCapabilityValueIfChanged(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    if (this.getCapabilityValue(capabilityId) === value) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => this.error(`set ${capabilityId}:`, err.message));
  }

  _registerCapabilityListeners() {
    // Standard vacuum tile.
    this.registerCapabilityListener('vacuumcleaner_state', async (value) => {
      switch (value) {
        case 'cleaning':
        case 'spot_cleaning':
          return this.startCleaning();
        case 'docked':
        case 'charging':
          return this.returnToDock();
        case 'stopped':
        default:
          return this.stopCleaning();
      }
    });

    this.registerCapabilityListener('narwal_fan_speed', async (value) => this.setFanSpeed(value));

    this.registerCapabilityListener('button.start', async () => this.startCleaning());
    this.registerCapabilityListener('button.pause', async () => this.pauseCleaning());
    this.registerCapabilityListener('button.resume', async () => this.resumeCleaning());
    this.registerCapabilityListener('button.stop', async () => this.stopCleaning());
    this.registerCapabilityListener('button.dock', async () => this.returnToDock());
    this.registerCapabilityListener('button.locate', async () => this.locate());
  }

  // ---- Event handlers ----------------------------------------------------

  async _onStatus(status) {
    // Take the previous state and record the new one before any await, so a
    // status arriving meanwhile compares against this one and does not fire
    // the same triggers again.
    const prev = this._prev;
    this._prev = {
      state: status.state,
      docked: status.docked,
      charging: status.charging,
      battery: status.battery,
    };
    await this._applyStatusToCapabilities(status);
    await this._fireStatusTriggers(status, prev);
  }

  async _applyStatusToCapabilities(status) {
    const set = (cap, val) => {
      if (val === null || val === undefined) return Promise.resolve();
      if (!this.hasCapability(cap)) return Promise.resolve();
      return this.setCapabilityValue(cap, val).catch((e) => this.error(`set ${cap}:`, e.message));
    };

    const label = STATUS_LABELS[status.state] || 'Unknown';
    const lastUpdate = formatTimestamp();
    await this.setStoreValue('last_status_at', lastUpdate).catch(() => {});

    await Promise.all([
      set('vacuumcleaner_state', status.homeyState),
      set('narwal_status', label),
      set('measure_battery', status.battery),
      set('narwal_charging', status.charging),
      set('narwal_docked', status.docked),
      set('narwal_clean_area', status.cleanArea),
      set('narwal_clean_time', status.cleanTime),
      set('narwal_firmware', status.firmware),
      set('narwal_current_room', this._roomNameForId(status.currentRoomId) || ''),
      status.fanSpeed ? set('narwal_fan_speed', status.fanSpeed) : Promise.resolve(),
    ]);

    if (status.error) {
      await this._setCapabilityValueIfChanged('narwal_last_error', `Robot error ${status.error}`);
      this.setWarning(this.homey.__('warnings.robot_error') || `Robot reported error ${status.error}`).catch(() => {});
    } else {
      await this._setCapabilityValueIfChanged('narwal_last_error', 'None');
      this.unsetWarning().catch(() => {});
    }
  }

  async _fireStatusTriggers(status, prev = this._prev) {
    const first = prev.state === null;

    // Cleaning lifecycle.
    if (status.state === RobotState.CLEANING && prev.state !== RobotState.CLEANING) {
      if (prev.state === RobotState.PAUSED) await this._trigger('resumed');
      else await this._trigger('started_cleaning');
    }
    if (status.state === RobotState.PAUSED && prev.state !== RobotState.PAUSED) {
      await this._trigger('paused');
    }
    if (status.state === RobotState.IDLE
      && (prev.state === RobotState.CLEANING || prev.state === RobotState.PAUSED)) {
      await this._trigger('stopped');
    }

    // Docking lifecycle.
    const nowHome = status.state === RobotState.DOCKED || status.state === RobotState.CHARGING;
    if (nowHome && prev.state === RobotState.RETURNING) {
      await this._trigger('returned_to_dock');
    }
    if (!first && status.docked === true && prev.docked === false) await this._trigger('docked');
    if (!first && status.docked === false && prev.docked === true) await this._trigger('undocked');

    // Cleaning completed: arriving home after an active session with work done.
    const wasActive = prev.state === RobotState.CLEANING
      || prev.state === RobotState.PAUSED
      || prev.state === RobotState.RETURNING;
    if (!first && nowHome && wasActive && (status.cleanArea || 0) > 0) {
      await this._trigger('cleaning_completed', {
        area: status.cleanArea || 0,
        duration: status.cleanTime || 0,
      });
    }

    // Battery / charging.
    if (!first && status.battery !== null && status.battery !== prev.battery) {
      await this._trigger('battery_level_changed', { battery: status.battery });
    }
    if (!first && status.charging !== null && status.charging !== prev.charging) {
      await this._trigger('charging_state_changed', { charging: status.charging });
    }
  }

  async _onMap(map) {
    // A map without rooms (e.g. only the robot position) is not a new room
    // list; saving it would wipe the rooms Flow cards and room checks use.
    if (map.rooms && map.rooms.length) await this._saveRooms(map.rooms);
    await this.setStoreValue('map_updated_at', map.updatedAt).catch(() => {});
    const safeMeta = map.meta ? { ...map.meta } : null;
    if (safeMeta) delete safeMeta.compressedMap;
    await this.setStoreValue('map_meta', safeMeta).catch(() => {});
    this._renderMap(map).catch((e) => this.log(`map render skipped: ${e.message}`));
  }

  _onRooms(rooms) {
    this._saveRooms(rooms).catch((err) => this.log(`rooms store skipped: ${err.message}`));
    this.log(`Discovered ${rooms.length} room(s)`);
  }

  async _onClientError(err) {
    const message = err && err.message ? err.message : String(err || 'Unknown error');
    this.error(message);
    await this._setCapabilityValueIfChanged('narwal_last_error', message);
  }

  async _onConnected() {
    await this._setCapabilityValueIfChanged('narwal_connected', true);
    // The status text was set to Disconnected on the outage; the next status
    // from the robot refines it.
    if (this.getCapabilityValue('narwal_status') === 'Disconnected') {
      await this._setCapabilityValueIfChanged('narwal_status', 'Connected');
    }
    await this._setCapabilityValueIfChanged('narwal_last_error', 'None');
    await this.setAvailable().catch(() => {});
    await this._trigger('connection_restored');
  }

  async _onDisconnected() {
    await this._setCapabilityValueIfChanged('narwal_connected', false);
    await this._setCapabilityValueIfChanged('narwal_status', 'Disconnected');
    await this._setCapabilityValueIfChanged('narwal_last_error', this.homey.__('errors.disconnected') || 'Lost connection to the robot');
    await this.setUnavailable(this.homey.__('errors.disconnected') || 'Lost connection to the robot').catch(() => {});
    await this._trigger('connection_lost');
  }

  /** Best-effort, non-blocking map snapshot via a device camera image. */
  async _renderMap(map) {
    const renderData = MapParser.toRenderData(map);
    const svg = MapParser.toSVG(map);
    this._mapRenderData = renderData;
    this._mapSvg = svg;
    if (renderData) {
      await this.setStoreValue('map_render_data', renderData).catch((err) => this.log(`map render data store skipped: ${err.message}`));
    }
    await this.setStoreValue('map_svg', svg).catch((err) => this.log(`map svg store skipped: ${err.message}`));
    if (!this._mapImageReady) {
      // Renders can overlap; they share one image instead of each creating one.
      this._mapImageReady = this._createMapImage().catch((err) => {
        this._mapImageReady = null;
        throw err;
      });
      await this._mapImageReady;
    } else {
      const image = await this._mapImageReady;
      await image.update();
    }
  }

  async _createMapImage() {
    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => {
      stream.write(Buffer.from(this._mapSvg || '', 'utf8'));
      stream.end();
    });
    await this.setCameraImage('map', 'Map', image);
    this._mapImage = image;
    return image;
  }

  hasMap() {
    return Boolean(this._mapRenderData || this.getStoreValue('map_render_data') || this._mapSvg || this.getStoreValue('map_svg'));
  }

  getMapData() {
    return this._mapRenderData || this.getStoreValue('map_render_data') || {
      type: 'svg-fallback',
      svg: this.getMapSvg(),
      updatedAt: this.getStoreValue('map_updated_at') || null,
    };
  }

  getMapSvg() {
    return this._mapSvg || this.getStoreValue('map_svg') || MapParser.toSVG(null);
  }

  getRoomsData() {
    return normalizeRooms(this.getStoreValue('rooms') || []);
  }

  _roomNameForId(roomId) {
    if (roomId === null || roomId === undefined || roomId === '') return '';
    const room = this.getRoomsData().find((candidate) => String(candidate.id) === String(roomId));
    return room ? room.name : `Room ${roomId}`;
  }

  getDefaultRoomIds(settings = this.getSettings()) {
    return parseRoomIds(settings.default_room_ids);
  }

  getDefaultRoomsData() {
    const rooms = this.getRoomsData();
    const ids = this.getDefaultRoomIds();
    const selected = new Set(ids);
    return {
      useDefaultRoomsForStart: this.getSettings().use_default_rooms_for_start === true,
      roomIds: ids,
      rooms,
      selectedRooms: rooms.filter((room) => selected.has(String(room.id))),
      roomsUpdatedAt: this.getStoreValue('rooms_updated_at') || null,
    };
  }

  async setDefaultRoomIds(roomIds, { enable = null } = {}) {
    const ids = parseRoomIds(roomIds);
    this._validateRoomIds(ids);
    const patch = { default_room_ids: ids.join(',') };
    if (enable !== null) patch.use_default_rooms_for_start = Boolean(enable);
    else if (ids.length) patch.use_default_rooms_for_start = true;
    await this.setSettings(patch);
    await this.setStoreValue('default_room_ids', ids).catch(() => {});
    return this.getDefaultRoomsData();
  }

  async _saveRooms(rooms) {
    const normalized = normalizeRooms(rooms);
    await this.setStoreValue('rooms', normalized);
    await this.setStoreValue('rooms_updated_at', Date.now()).catch(() => {});
    await this._syncRoomsSettings(normalized);
    return normalized;
  }

  async _syncRoomsSettings(rooms = this.getRoomsData()) {
    if (typeof this.setSettings !== 'function') return;
    await this.setSettings({ cached_rooms_summary: formatRoomsSummary(rooms) }).catch((err) => {
      this.log(`room settings summary update skipped: ${err.message}`);
    });
  }

  _validateRoomIds(ids, rooms = this.getRoomsData()) {
    const roomIds = new Set(rooms.map((room) => String(room.id)));
    if (!roomIds.size || !ids.length) return;
    const invalid = ids.filter((id) => !roomIds.has(String(id)));
    if (invalid.length) throw new Error(`Unknown room IDs: ${invalid.join(', ')}. Refresh rooms/map first.`);
  }

  async _validateDefaultRoomSettings(settings = this.getSettings()) {
    const ids = parseRoomIds(settings.default_room_ids);
    this._validateRoomIds(ids);
    await this.setStoreValue('default_room_ids', ids).catch(() => {});
  }

  async _trigger(cardId, tokens = {}) {
    try {
      await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, tokens);
    } catch (err) {
      this.error(`trigger ${cardId} failed:`, err.message);
    }
  }

  async _recordCommand(type, details = {}) {
    const history = Array.isArray(this.getStoreValue('command_history'))
      ? this.getStoreValue('command_history')
      : [];
    const entry = {
      at: new Date().toISOString(),
      type,
      details,
    };
    const next = [entry, ...history].slice(0, 20);
    await this.setStoreValue('command_history', next).catch(() => {});
    this.log(`[command] ${type}: ${JSON.stringify(details)}`);
  }

  getCommandHistory() {
    return Array.isArray(this.getStoreValue('command_history')) ? this.getStoreValue('command_history') : [];
  }

  // ---- Commands invoked by capabilities & Flow cards ---------------------

  _requireClient() {
    if (!this._client || !this._client.connected) {
      throw new Error('Robot is not connected. Check power, network and that the official app is closed.');
    }
    return this._client;
  }

  async startCleaning() {
    const settings = this.getSettings();
    const ids = this.getDefaultRoomIds(settings);
    if (settings.use_default_rooms_for_start === true && ids.length) {
      await this._recordCommand('start_cleaning_defaults', { roomIds: ids });
      await this.cleanRooms(ids, { source: 'start_cleaning' });
      return;
    }
    await this._recordCommand('start_cleaning_whole_home', {
      reason: ids.length ? 'default_rooms_disabled' : 'no_default_rooms',
      configuredRoomIds: ids,
    });
    await this._requireClient().startClean(resolveCleanOptions(settings));
  }

  /** "Clean with settings" Flow card: card values override device settings for this run. */
  async cleanWithSettings(args = {}) {
    const target = args.rooms && typeof args.rooms === 'object' ? args.rooms.id : args.rooms;
    const options = resolveCleanOptions(this.getSettings(), args);
    if (target === CLEAN_TARGET_WHOLE_HOME) {
      await this._recordCommand('clean_with_settings', { target: 'whole_home', options });
      await this._requireClient().startClean(options);
      return;
    }
    if (target === CLEAN_TARGET_DEFAULT_ROOMS) {
      const ids = this.getDefaultRoomIds();
      if (!ids.length) throw new Error('No default rooms selected. Configure default rooms in Advanced settings or the map widget.');
      await this.cleanRooms(ids, { source: 'clean_with_settings', options });
      return;
    }
    await this.cleanRooms([target], { source: 'clean_with_settings', options });
  }

  async cleanDefaultRooms() {
    const ids = this.getDefaultRoomIds();
    if (!ids.length) throw new Error('No default rooms selected. Configure default rooms in Advanced settings or the map widget.');
    await this._recordCommand('clean_default_rooms', { roomIds: ids });
    await this.cleanRooms(ids, { source: 'clean_default_rooms' });
  }

  async pauseCleaning() {
    await this._requireClient().pauseClean();
  }

  async resumeCleaning() {
    await this._requireClient().resumeClean();
  }

  async stopCleaning() {
    await this._requireClient().stopClean();
  }

  async returnToDock() {
    await this._requireClient().returnToDock();
  }

  async locate() {
    await this._requireClient().locate();
  }

  async setFanSpeed(fanSpeed) {
    if (!Object.values(FanSpeed).includes(fanSpeed)) {
      throw new Error(`Unknown fan speed: ${fanSpeed}`);
    }
    const client = this._requireClient();
    await client.setFanSpeed(fanSpeed);
    await this.setCapabilityValue('narwal_fan_speed', client.fanSpeed || fanSpeed).catch(() => {});
  }

  async refreshStatus() {
    return this._requireClient().refreshStatus();
  }

  async refreshRoomsAndMap() {
    const client = this._requireClient();
    const map = await client.refreshMap({ force: true }).catch(() => null);
    const rooms = map && map.rooms ? normalizeRooms(map.rooms) : await client.refreshRooms().catch(() => []);
    if (!rooms || rooms.length === 0) {
      throw new Error('No rooms available yet. Run a full map-building clean from the official app first.');
    }
    // A new map is already handled through the client's 'map' event.
    if (!map) await this._saveRooms(rooms);
    return rooms;
  }

  async cleanRooms(roomIds, { source = 'clean_rooms', options = null } = {}) {
    const ids = parseRoomIds(roomIds);
    if (!ids.length) throw new Error('No rooms selected.');
    this._validateRoomIds(ids);
    await this._recordCommand('clean_rooms', { source, roomIds: ids });
    await this._requireClient().cleanRoom(ids, options || resolveCleanOptions(this.getSettings()));
  }

  async cleanRoom(roomArg) {
    const roomId = roomArg && typeof roomArg === 'object' ? roomArg.id : roomArg;
    await this.cleanRooms([roomId], { source: 'clean_room' });
  }

  /** Autocomplete source for the "clean selected room" Flow card. */
  async getRoomAutocomplete(query) {
    let rooms = this.getRoomsData();
    // Try a live refresh if we have nothing cached.
    if ((!rooms || rooms.length === 0) && this._client && this._client.connected) {
      rooms = await this._client.refreshRooms().catch(() => []);
    }
    if (!rooms || rooms.length === 0) {
      throw new Error('No rooms cached yet. Refresh rooms/map first.');
    }
    const q = String(query || '').toLowerCase();
    return rooms
      .filter((r) => !q || String(r.name).toLowerCase().includes(q))
      .map((r) => ({ id: String(r.id), name: r.name }));
  }

  /** Autocomplete for "Clean with settings": whole home, default rooms, then each room. */
  async getCleanTargetAutocomplete(query) {
    const q = String(query || '').toLowerCase();
    const targets = [
      { id: CLEAN_TARGET_WHOLE_HOME, name: 'Whole home' },
      { id: CLEAN_TARGET_DEFAULT_ROOMS, name: 'Default rooms' },
      ...this.getRoomsData().map((r) => ({ id: String(r.id), name: r.name })),
    ];
    return targets.filter((t) => !q || t.name.toLowerCase().includes(q));
  }

  // ---- Condition helpers -------------------------------------------------

  isConnected() {
    return Boolean(this._client && this._client.connected);
  }

  isCleaning() {
    return this.getCapabilityValue('vacuumcleaner_state') === 'cleaning';
  }

  isDocked() {
    return this.getCapabilityValue('narwal_docked') === true;
  }

  isCharging() {
    return this.getCapabilityValue('narwal_charging') === true;
  }
}

module.exports = NarwalDevice;

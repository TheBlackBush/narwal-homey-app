'use strict';

const Homey = require('homey');
const { NarwalClient } = require('./NarwalClient');
const { SUPPORTED_MODELS, DEFAULT_PORT, modelNameForProductKey } = require('./constants');
const { uniqueResults, markAdded, buildPairEntry } = require('./Discovery');

const DISCOVERY_PROBE_TIMEOUT_MS = 8000;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function modelById(id) {
  return SUPPORTED_MODELS.find((x) => x.id === id) || SUPPORTED_MODELS.find((x) => x.id === 'narwal_flow_2');
}

class NarwalHomeyDriver extends Homey.Driver {
  get modelId() {
    return this.constructor.MODEL_ID || 'narwal_flow_2';
  }

  get model() {
    return modelById(this.modelId);
  }

  get defaultIp() {
    return this.constructor.DEFAULT_IP || '';
  }

  get defaultDeviceId() {
    return this.constructor.DEFAULT_DEVICE_ID || '';
  }

  _createPairDevice({
    ip, port, useMock = false, status = null,
  }) {
    const { model } = this;
    const discoveredProductKey = status && status.topicPrefix ? String(status.topicPrefix).replace(/^\//, '') : '';
    const discoveredName = modelNameForProductKey(discoveredProductKey);
    return {
      name: discoveredName || model.name,
      data: {
        id: useMock ? `narwal-mock-${model.id}` : ((status && status.deviceId) || `${model.id}-${ip}-${port}`),
      },
      store: {
        model: model.id,
        protocol: model.protocol,
        productKey: discoveredProductKey || model.productKey,
        deviceId: status && status.deviceId ? status.deviceId : (this.defaultDeviceId || null),
      },
      settings: {
        ip,
        port,
        poll_interval: 60,
        use_default_rooms_for_start: true,
        default_room_ids: '',

        cached_rooms_summary: 'No rooms cached yet. Open App Settings and press Refresh rooms / map.',
        dev_mock: useMock,
      },
    };
  }

  _defaultPairDevice() {
    if (!this.defaultIp) return null;
    return this._createPairDevice({ ip: this.defaultIp, port: DEFAULT_PORT });
  }

  async onInit() {
    this.log(`${this.model.name} driver initialized`);
    this._registerFlowOnce();
  }

  _registerFlowOnce() {
    if (this.homey.__narwalFlowRegistered) return;
    this.homey.__narwalFlowRegistered = true;

    const action = (id, fn) => this.homey.flow.getActionCard(id).registerRunListener(fn);
    const condition = (id, fn) => this.homey.flow.getConditionCard(id).registerRunListener(fn);

    action('start_cleaning', async (args) => args.device.startCleaning());
    action('pause_cleaning', async (args) => args.device.pauseCleaning());
    action('resume_cleaning', async (args) => args.device.resumeCleaning());
    action('stop_cleaning', async (args) => args.device.stopCleaning());
    action('return_to_dock', async (args) => args.device.returnToDock());
    action('locate_robot', async (args) => args.device.locate());
    action('set_fan_speed', async (args) => args.device.setFanSpeed(args.fan_speed));
    action('refresh_status', async (args) => args.device.refreshStatus());
    action('refresh_rooms_map', async (args) => args.device.refreshRoomsAndMap());
    action('clean_room', async (args) => args.device.cleanRoom(args.room));
    action('clean_default_rooms', async (args) => args.device.cleanDefaultRooms());
    action('clean_with_settings', async (args) => args.device.cleanWithSettings(args));

    this.homey.flow.getActionCard('clean_room')
      .registerArgumentAutocompleteListener('room', async (query, args) => args.device.getRoomAutocomplete(query));
    this.homey.flow.getActionCard('clean_with_settings')
      .registerArgumentAutocompleteListener('rooms', async (query, args) => args.device.getCleanTargetAutocomplete(query));

    condition('is_cleaning', async (args) => args.device.isCleaning());
    condition('is_docked', async (args) => args.device.isDocked());
    condition('is_charging', async (args) => args.device.isCharging());
    condition('is_connected', async (args) => args.device.isConnected());
    condition('battery_above', async (args) => {
      const battery = args.device.getCapabilityValue('measure_battery');
      return typeof battery === 'number' && battery > args.percent;
    });
  }

  // Found robots for the pairing view. Discovery must never block pairing, so
  // any failure returns an empty list and the manual form stays usable.
  async _discoverRobots() {
    let results = [];
    try {
      results = Object.values(this.homey.discovery.getStrategy('narwal').getDiscoveryResults() || {});
    } catch (err) {
      this.log(`[pair] discovery unavailable: ${err.message}`);
      return [];
    }
    const devices = this.getDevices();
    const existingIds = new Set(devices.flatMap((device) => [String(device.getData().id), device.getStoreValue('deviceId')]).filter(Boolean));
    const found = markAdded(uniqueResults(results), [...existingIds]);
    const probed = await Promise.all(found.map(({ suffix, ip, added }) => (added
      ? Promise.resolve({ suffix, ip, added })
      : NarwalClient.probe({ ip, port: DEFAULT_PORT, timeoutMs: DISCOVERY_PROBE_TIMEOUT_MS })
        .then((probe) => ({ suffix, ip, probe }), (error) => ({ suffix, ip, error })))));
    return probed.map(({
      suffix, ip, probe, error, added,
    }) => {
      if (added) {
        return {
          ip, port: DEFAULT_PORT, suffix, group: 'match', modelName: this.model.name, deviceId: null, productKey: null, added: true,
        };
      }
      const entry = buildPairEntry({
        ip, port: DEFAULT_PORT, suffix, probe, error,
      }, this.model, existingIds);
      if (entry.group === 'match' && !entry.added) {
        entry.device = this._createPairDevice({ ip, port: DEFAULT_PORT, status: probe });
      }
      return entry;
    });
  }

  async onPair(session) {
    let pendingDevice = null;

    session.setHandler('validate', async (input = {}) => {
      const ip = String(input.ip || '').trim();
      const port = Number(input.port) || DEFAULT_PORT;
      const useMock = Boolean(input.dev_mock);
      const { model } = this;

      if (!useMock && !IPV4_RE.test(ip)) {
        throw new Error('Please enter a valid IPv4 address (e.g. 192.168.1.50).');
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Port must be between 1 and 65535.');
      }

      this.log(`[pair] validating ${model.name} at ${ip}:${port}${useMock ? ' [mock]' : ''}`);

      let status;
      try {
        status = await NarwalClient.probe({
          ip,
          port,
          protocol: model.protocol,
          productKey: model.productKey,
          mock: useMock,
        });
      } catch (err) {
        this.error('[pair] validation failed:', err.message);
        throw new Error(err.message);
      }

      pendingDevice = this._createPairDevice({
        ip, port, useMock, status,
      });

      return {
        name: pendingDevice.name,
        firmware: status && status.firmware ? status.firmware : 'unknown',
        battery: status && typeof status.battery === 'number' ? status.battery : null,
        device: pendingDevice,
      };
    });

    session.setHandler('discover', async () => ({ robots: await this._discoverRobots() }));

    session.setHandler('list_devices', async () => {
      const fallback = pendingDevice || this._defaultPairDevice();
      this.log(`[pair] list_devices for ${this.model.name}: ${fallback ? fallback.data.id : 'empty'}`);
      return fallback ? [fallback] : [];
    });
  }
}

module.exports = { NarwalHomeyDriver };

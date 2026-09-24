'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

const { NarwalProtocol } = require('./NarwalProtocol');
const {
  FAN_LEVEL,
  NarwalBinaryProtocol,
  buildStartCleanPayload,
  encodeVarintField,
  liveFanLevel,
  parseCommandResponse,
} = require('./NarwalBinaryProtocol');
const { MapParser } = require('./MapParser');
const { MockSocket } = require('./MockSocket');
const C = require('./constants');

/**
 * NarwalClient
 *
 * Reusable, resilient transport + command layer for a single robot. It owns the
 * WebSocket lifecycle and never throws into the caller's event loop — every
 * failure becomes either a rejected command promise or an emitted event.
 *
 * Events:
 *   'connected'           when the socket opens and the first status is fetched
 *   'disconnected'        when the socket closes/errors (reconnect is scheduled)
 *   'status'  (state)     normalized status model (see NarwalProtocol)
 *   'map'     (map)       parsed map (see MapParser)
 *   'rooms'   (rooms[])   discovered rooms
 *   'sleeping'            robot appears to be in deep sleep / unreachable
 *   'log'     (msg)       structured log line for the host to forward
 *   'error'   (err)       non-fatal error
 *
 * It is deliberately Homey-agnostic: timers use globals so it can be unit
 * tested, and the host (device.js) forwards 'log'/'error' to Homey logging.
 */
class NarwalClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.ip            robot IP address
   * @param {number} [opts.port]        local WebSocket port (default 9002)
   * @param {string} [opts.protocol]    protocol version key (default v1)
   * @param {number} [opts.pollInterval] status poll fallback in ms
   * @param {boolean} [opts.mock]       use the in-memory mock robot (dev mode)
   */
  constructor(opts = {}) {
    super();
    this.ip = opts.ip;
    this.port = Number(opts.port) || C.DEFAULT_PORT;
    this.protocolVersion = opts.protocol || 'v1';
    this.pollIntervalMs = Number(opts.pollInterval) || C.POLL_INTERVAL_MS;
    this.mock = Boolean(opts.mock);

    this.protocol = new NarwalProtocol(this.protocolVersion);
    this.binaryProtocol = new NarwalBinaryProtocol({ productKey: opts.productKey || 'QxMSPG6VSO', deviceId: opts.deviceId || '' });
    this.binaryMode = !this.mock;
    // Suction used for the next start; a choice made while docked waits here
    // because docked robots reject clean/set_fan_level.
    this.fanSpeed = C.FAN_SPEED_VALUES.includes(opts.fanSpeed)
      ? C.normalizeFanSpeed(opts.fanSpeed, this.binaryProtocol.topicPrefix)
      : null;
    this._pendingFanSpeed = null;

    this._ws = null;
    this._connected = false;
    this._closing = false;
    this._reqId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._statusWaiters = [];
    this._mapWaiters = [];
    this._binaryResponses = [];
    this._binaryResponseWaiters = [];
    this._binaryCommandChain = Promise.resolve();

    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._subscriptionTimer = null;
    this._pollTimer = null;
    this._lastMessageAt = 0;

    this.lastStatus = null;
    this.rooms = [];
    this.lastMap = null;
  }

  get url() {
    return `ws://${this.ip}:${this.port}`;
  }

  get connected() {
    return this._connected;
  }

  _log(msg) {
    this.emit('log', `[narwal] ${msg}`);
  }

  /** Open the connection and start resilience timers. Idempotent. */
  start() {
    this._closing = false;
    this._connect();
    this._startPolling();
  }

  /** Permanently stop the client and release all timers/sockets. */
  stop() {
    this._closing = true;
    this._clearTimer('_reconnectTimer');
    this._clearTimer('_heartbeatTimer');
    this._clearTimer('_subscriptionTimer');
    this._clearTimer('_pollTimer');
    this._failAllPending(new Error('Client stopped'));
    this._teardownSocket();
    this._connected = false;
  }

  _clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      clearInterval(this[name]);
      this[name] = null;
    }
  }

  _teardownSocket() {
    if (!this._ws) return;
    try {
      this._ws.removeAllListeners();
      if (this.mock) this._ws.close();
      else this._ws.terminate();
    } catch (_) { /* ignore */ }
    this._ws = null;
  }

  _connect() {
    if (this._closing) return;
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this._log(`connecting to ${this.url}${this.mock ? ' (mock)' : ''}`);

    try {
      this._ws = this.mock
        ? new MockSocket({ protocol: this.protocol })
        : new WebSocket(this.url, { handshakeTimeout: C.CONNECT_TIMEOUT_MS, ...C.WEBSOCKET_OPTIONS });
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect('connect-throw');
      return;
    }

    this._ws.on('open', () => this._onOpen());
    this._ws.on('message', (raw) => this._onMessage(raw));
    this._ws.on('pong', () => {
      this._lastMessageAt = Date.now();
    });
    this._ws.on('close', (code) => this._onClose(code));
    this._ws.on('error', (err) => this._onError(err));
  }

  async _onOpen() {
    this._connected = true;
    this._reconnectAttempt = 0;
    this._lastMessageAt = Date.now();
    this._log('connected');
    this._startHeartbeat();

    if (this.binaryMode) {
      this._startSubscriptionRenewal();
      this._sendBinaryDiscovery();
      setTimeout(() => {
        if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) {
          this._sendBinaryWakeBurst();
        }
      }, 500);
      this.emit('connected');
      return;
    }

    // Fetch an initial status + room list so the device populates immediately.
    try {
      await this.refreshStatus();
      this.emit('connected');
    } catch (err) {
      // A robot in deep sleep may accept the socket but not reply.
      this._log(`initial status failed: ${err.message}`);
      this.emit('sleeping');
    }
    // Rooms are best-effort and must not block 'connected'.
    this.refreshRooms().catch(() => {});
  }

  _onMessage(raw) {
    this._lastMessageAt = Date.now();
    if (this.binaryMode) {
      this._onBinaryMessage(raw);
      return;
    }

    let parsed;
    try {
      parsed = this.protocol.parseMessage(raw);
    } catch (err) {
      this._log(`unparseable frame: ${err.message}`);
      return;
    }

    if (parsed.type === 'reply') {
      this._resolvePending(parsed);
      return;
    }
    if (parsed.type === 'event') {
      this._handleEvent(parsed);
    }
  }

  _sendBinaryFrames(frames) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    for (const frame of frames) {
      try {
        this._ws.send(frame);
      } catch (err) {
        this._log(`binary send failed: ${err.message}`);
      }
    }
  }

  _sendBinaryDiscovery() {
    this._sendBinaryFrames(this.binaryProtocol.buildDiscoveryFrames(C.KNOWN_PRODUCT_KEYS));
  }

  _sendBinaryWakeBurst() {
    this._sendBinaryFrames(this.binaryProtocol.buildWakeFrames());
  }

  _onBinaryMessage(raw) {
    const msg = this.binaryProtocol.parse(raw);
    if (!msg) {
      this._log(`unparseable binary frame (${Buffer.byteLength(raw)} bytes)`);
      return;
    }

    if (msg.type === 'response') {
      this._enqueueBinaryResponse(msg);
      if (msg.decoded && msg.decoded['2'] && typeof msg.decoded['2'] === 'object'
        && !MapParser.parseNarwalMapResponse(msg.decoded, Date.now(), this._productKey())) {
        const statusMsg = { ...msg, shortTopic: 'status/robot_base_status', decoded: msg.decoded['2'] };
        const status = this._ingestBinaryStatus(statusMsg);
        this._resolveStatusWaiters(null, status);
      }
      return;
    }

    if (msg.shortTopic === 'status/robot_base_status' || msg.shortTopic === 'status/working_status') {
      const status = this._ingestBinaryStatus(msg);
      this._resolveStatusWaiters(null, status);
      return;
    }

    if (msg.shortTopic === 'upgrade/upgrade_status') {
      this._ingestBinaryStatus(msg);
      return;
    }

    if (msg.shortTopic.includes('map')) {
      this._log(`binary event: ${msg.shortTopic} (${msg.payload.length} bytes)`);
      const map = this._ingestMap(msg.decoded);
      if (map) this._resolveMapWaiters(null, map);
      return;
    }

    this._log(`binary event: ${msg.shortTopic}`);
  }

  _ingestBinaryStatus(msg) {
    const previous = this.lastStatus || {};
    const partial = this.binaryProtocol.normalizeStatus(msg.decoded, msg.shortTopic);
    // While docking the robot keeps sending the finished clean's progress.
    // Base status is authoritative for the dock, so keep the metrics but not
    // the cleaning state or room.
    if (msg.shortTopic === 'status/working_status' && previous.docked === true) {
      partial.state = C.RobotState.UNKNOWN;
      partial.currentRoomId = null;
    }
    const merged = {
      ...previous,
      ...partial,
      raw: partial.raw,
      battery: partial.battery ?? previous.battery ?? null,
      charging: partial.charging ?? previous.charging ?? null,
      docked: partial.docked ?? previous.docked ?? null,
      fanSpeed: partial.fanSpeed ?? previous.fanSpeed ?? null,
      cleanArea: partial.cleanArea ?? previous.cleanArea ?? null,
      cleanTime: partial.cleanTime ?? previous.cleanTime ?? null,
      firmware: partial.firmware ?? previous.firmware ?? null,
      currentRoomId: partial.currentRoomId !== undefined ? partial.currentRoomId : (previous.currentRoomId ?? null),
      state: partial.state === C.RobotState.UNKNOWN ? (previous.state || partial.state) : partial.state,
      homeyState: partial.state === C.RobotState.UNKNOWN ? (previous.homeyState || partial.homeyState) : partial.homeyState,
    };
    if (merged.state === C.RobotState.CLEANING) this._pendingFanSpeed = null;
    if (this._pendingFanSpeed) merged.fanSpeed = this._pendingFanSpeed;
    else if (partial.fanSpeed) this.fanSpeed = partial.fanSpeed;
    this.lastStatus = merged;
    this.emit('status', merged);
    return merged;
  }

  _waitForNextStatus(timeoutMs = C.CONNECT_TIMEOUT_MS) {
    if (this.lastStatus) return Promise.resolve(this.lastStatus);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._statusWaiters = this._statusWaiters.filter((entry) => entry.timer !== timer);
        reject(new Error('Status timed out (robot may be asleep)'));
      }, timeoutMs);
      this._statusWaiters.push({ resolve, reject, timer });
    });
  }

  _resolveStatusWaiters(err, status) {
    const waiters = this._statusWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (err) waiter.reject(err);
      else waiter.resolve(status);
    }
  }

  _waitForNextMap(timeoutMs = C.CONNECT_TIMEOUT_MS) {
    if (this.lastMap) return Promise.resolve(this.lastMap);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._mapWaiters = this._mapWaiters.filter((entry) => entry.timer !== timer);
        reject(new Error('Map timed out. The robot may not have published local map data yet.'));
      }, timeoutMs);
      this._mapWaiters.push({ resolve, reject, timer });
    });
  }

  _resolveMapWaiters(err, map) {
    const waiters = this._mapWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (err) waiter.reject(err);
      else waiter.resolve(map);
    }
  }

  _enqueueBinaryResponse(msg) {
    const waiter = this._binaryResponseWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    this._binaryResponses.push(msg);
  }

  _drainBinaryResponses() {
    const drained = this._binaryResponses.length;
    this._binaryResponses.splice(0);
    if (drained) this._log(`drained ${drained} stale binary response(s)`);
  }

  _rejectBinaryResponseWaiters(err) {
    const waiters = this._binaryResponseWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  _waitForBinaryResponse(timeoutMs = C.COMMAND_TIMEOUT_MS) {
    const queued = this._binaryResponses.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._binaryResponseWaiters = this._binaryResponseWaiters.filter((entry) => entry.timer !== timer);
        reject(new Error('Command timed out (robot may be asleep or busy)'));
      }, timeoutMs);
      this._binaryResponseWaiters.push({ resolve, reject, timer });
    });
  }

  _binaryResultError(resultCode, shortTopic) {
    const message = C.COMMAND_RESULT_MESSAGES[resultCode] || `Robot rejected command (code ${resultCode})`;
    return new Error(`${message} [${shortTopic}]`);
  }

  _sendBinaryCommand(shortTopic, payload = Buffer.alloc(0), timeoutMs = C.COMMAND_TIMEOUT_MS, acceptResponse = null) {
    const run = async () => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        throw new Error('Not connected to robot');
      }

      this._drainBinaryResponses();
      const frame = this.binaryProtocol.buildCommandFrame(shortTopic, payload);
      this._ws.send(frame);
      const startedAt = Date.now();
      while (true) {
        const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
        const msg = await this._waitForBinaryResponse(remaining);
        const response = {
          ...parseCommandResponse(msg.decoded || {}, msg.payload),
          topic: msg.shortTopic,
        };
        if (!acceptResponse || acceptResponse(response, msg)) {
          if (!response.ok) throw this._binaryResultError(response.resultCode, shortTopic);
          return response;
        }
        this._log(`ignored unrelated binary response while waiting for ${shortTopic}`);
        if (Date.now() - startedAt >= timeoutMs) throw new Error('Command timed out (robot may be asleep or busy)');
      }
    };

    const chained = this._binaryCommandChain.catch(() => {}).then(run);
    this._binaryCommandChain = chained;
    return chained;
  }

  _resolvePending(reply) {
    const entry = reply.id !== null ? this._pending.get(reply.id) : null;
    if (!entry) {
      // Unsolicited reply (e.g. broadcast status) — treat like an event.
      if (reply.command && /status/i.test(reply.command)) this._ingestStatus(reply.data);
      return;
    }
    this._pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.data);
    else entry.reject(new Error(`Robot rejected command (code ${reply.code})`));
  }

  _handleEvent(parsed) {
    const name = parsed.event.toLowerCase();
    if (name.includes('status') || name.includes('state')) {
      this._ingestStatus(parsed.data);
    } else if (name.includes('map')) {
      this._ingestMap(parsed.data);
    } else {
      this._log(`event: ${parsed.event}`);
    }
  }

  _ingestStatus(payload) {
    const status = this.protocol.normalizeStatus(payload);
    this.lastStatus = status;
    this.emit('status', status);
    return status;
  }

  _productKey() {
    return String(this.binaryProtocol.topicPrefix || '').replace(/^\//, '') || '';
  }

  _ingestMap(payload) {
    const map = MapParser.parse(payload, Date.now(), { productKey: this._productKey() });
    if (map) {
      this.lastMap = map;
      this.emit('map', map);
      if (map.rooms.length) {
        this.rooms = map.rooms.map(({ id, name }) => ({ id, name }));
        this.emit('rooms', this.rooms);
      }
    }
    return map;
  }

  _onClose(code) {
    if (this._connected) this._log(`socket closed (code ${code})`);
    this._connected = false;
    this._clearTimer('_heartbeatTimer');
    this._clearTimer('_subscriptionTimer');
    this._teardownSocket();
    this._failAllPending(new Error('Connection closed'));
    this.emit('disconnected');
    this._scheduleReconnect('close');
  }

  _onError(err) {
    this._log(`socket error: ${err.message}`);
    this.emit('error', err);
    // 'close' usually follows; force teardown for errors that don't close.
    if (this._ws && this._ws.readyState !== WebSocket.OPEN) {
      this._onClose(-1);
    }
  }

  _scheduleReconnect(reason) {
    if (this._closing || this._reconnectTimer) return;
    this._reconnectAttempt += 1;
    const backoff = Math.min(
      C.RECONNECT_BASE_MS * (C.RECONNECT_FACTOR ** (this._reconnectAttempt - 1)),
      C.RECONNECT_MAX_MS,
    );
    const jitter = Math.floor(Math.random() * C.RECONNECT_JITTER_MS);
    const delay = Math.floor(backoff + jitter);
    this._log(`reconnect in ${delay}ms (attempt ${this._reconnectAttempt}, reason=${reason})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _startHeartbeat() {
    this._clearTimer('_heartbeatTimer');
    this._heartbeatTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this._lastMessageAt;
      if (idle > C.HEARTBEAT_TIMEOUT_MS) {
        this._log(`heartbeat timeout (${Math.round(idle / 1000)}s idle), reconnecting`);
        this._onClose(-2);
        return;
      }
      try {
        if (typeof this._ws.ping === 'function') this._ws.ping();
      } catch (_) { /* ignore */ }
    }, C.HEARTBEAT_INTERVAL_MS);
  }

  // The robot drops working_status and display_map broadcasts once the
  // 600 s subscription lapses, so renew it regardless of the robot's state.
  _startSubscriptionRenewal() {
    this._clearTimer('_subscriptionTimer');
    this._subscriptionTimer = setInterval(() => {
      this._sendBinaryFrames(this.binaryProtocol.buildSubscriptionFrames());
    }, C.SUBSCRIPTION_RENEW_MS);
  }

  _startPolling() {
    this._clearTimer('_pollTimer');
    this._pollTimer = setInterval(() => {
      // Only poll as a fallback: when live updates haven't arrived recently.
      const idle = Date.now() - this._lastMessageAt;
      if (this._connected && idle >= this.pollIntervalMs) {
        this._pollStatus().catch((err) => this._log(`poll failed: ${err.message}`));
      }
    }, this.pollIntervalMs);
  }

  // A docked robot goes quiet for up to two minutes between broadcast
  // windows. That is normal, so ask for base status without a wake burst.
  _pollStatus() {
    if (this.binaryMode && this.lastStatus && this.lastStatus.docked === true) {
      this._sendBinaryFrames([this.binaryProtocol.buildCommandFrame(C.BinaryCommandTopic.GET_BASE_STATUS)]);
      return this._waitForNextStatus();
    }
    return this.refreshStatus();
  }

  _failAllPending(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
    this._resolveStatusWaiters(err);
    this._rejectBinaryResponseWaiters(err);
  }

  /**
   * Send a command and await its reply. Rejects on timeout or robot error.
   * @param {function} build receives an id, returns the request frame
   */
  _send(build) {
    return new Promise((resolve, reject) => {
      if (this.binaryMode) {
        reject(new Error('Binary Narwal commands are not implemented yet'));
        return;
      }
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to robot'));
        return;
      }
      this._reqId = (this._reqId + 1) % 2147483647;
      const id = this._reqId;
      const frame = build(id);

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Command timed out (robot may be asleep)'));
      }, C.COMMAND_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });

      try {
        this._ws.send(JSON.stringify(frame));
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ---- Public command API ------------------------------------------------

  async refreshStatus() {
    if (this.binaryMode) {
      this._sendBinaryDiscovery();
      this._sendBinaryWakeBurst();
      return this._waitForNextStatus();
    }
    const data = await this._send((id) => this.protocol.buildGetStatus(id));
    return this._ingestStatus(data);
  }

  async refreshRooms() {
    if (this.binaryMode) {
      const map = await this.refreshMap();
      return map && map.rooms ? map.rooms.map(({ id, name }) => ({ id, name })) : this.rooms;
    }
    const data = await this._send((id) => this.protocol.buildGetRooms(id));
    const rooms = MapParser.parseRooms(data).map(({ id, name }) => ({ id, name }));
    if (rooms.length) {
      this.rooms = rooms;
      this.emit('rooms', rooms);
    }
    return rooms;
  }

  async refreshMap({ force = false } = {}) {
    if (this.binaryMode) {
      if (this.lastMap && !force) return this.lastMap;
      this._sendBinaryDiscovery();
      this._sendBinaryWakeBurst();
      const response = await this._sendBinaryCommand(
        C.BinaryCommandTopic.GET_MAP,
        Buffer.alloc(0),
        C.SLOW_COMMAND_TIMEOUT_MS,
        (candidate) => Boolean(MapParser.parseNarwalMapResponse(candidate.data, Date.now(), this._productKey())),
      );
      return this._ingestMap(response.data);
    }
    const data = await this._send((id) => this.protocol.buildGetMap(id));
    return this._ingestMap(data);
  }

  async _getCleanableMap({ force = false } = {}) {
    let map = this.lastMap;
    if (!map || force || !(map.meta && map.meta.mapId) || !map.rooms || !map.rooms.length) {
      map = await this.refreshMap({ force }).catch(() => map || null);
    }
    return map;
  }

  async start_(options = {}) {
    if (this.binaryMode) {
      const map = await this._getCleanableMap();
      const ids = map && map.rooms ? map.rooms.map((room) => room.id).filter(Boolean) : [];
      // clean/plan/start re-runs the robot's stored plan and can report
      // success without cleaning, so whole-home starts need the room list.
      if (!map || !(map.meta && map.meta.mapId) || !ids.length) {
        throw new Error('No map with rooms available yet. Refresh rooms / map and try again.');
      }
      return this._sendBinaryCommand(
        C.BinaryCommandTopic.START_CLEAN,
        buildStartCleanPayload(ids, map.meta.mapId, this._cleanOptions(options)),
        C.SLOW_COMMAND_TIMEOUT_MS,
      );
    }
    return this._send((id) => this.protocol.buildStart(id));
  }

  /** @param {object} options clean options from resolveCleanOptions() */
  startClean(options = {}) {
    return this.start_(options);
  }

  pauseClean() {
    if (this.binaryMode) return this._sendBinaryCommand(C.BinaryCommandTopic.PAUSE);
    return this._send((id) => this.protocol.buildPause(id));
  }

  resumeClean() {
    if (this.binaryMode) return this._sendBinaryCommand(C.BinaryCommandTopic.RESUME);
    return this._send((id) => this.protocol.buildResume(id));
  }

  stopClean() {
    if (this.binaryMode) return this._sendBinaryCommand(C.BinaryCommandTopic.FORCE_END, Buffer.alloc(0), 15000);
    return this._send((id) => this.protocol.buildStop(id));
  }

  returnToDock() {
    if (this.binaryMode) return this._sendBinaryCommand(C.BinaryCommandTopic.RECALL);
    return this._send((id) => this.protocol.buildDock(id));
  }

  locate() {
    if (this.binaryMode) return this._sendBinaryCommand(C.BinaryCommandTopic.YELL);
    return this._send((id) => this.protocol.buildLocate(id));
  }

  setFanSpeed(fanSpeed) {
    if (!C.FAN_SPEED_VALUES.includes(fanSpeed)) return Promise.reject(new Error(`Unknown fan speed: ${fanSpeed}`));
    if (this.binaryMode) {
      const speed = C.normalizeFanSpeed(fanSpeed, this.binaryProtocol.topicPrefix);
      this.fanSpeed = speed;
      const state = this.lastStatus && this.lastStatus.state;
      if (state !== C.RobotState.CLEANING && state !== C.RobotState.PAUSED) {
        this._pendingFanSpeed = speed;
        return Promise.resolve(null);
      }
      this._pendingFanSpeed = null;
      return this._sendBinaryCommand(C.BinaryCommandTopic.SET_FAN_LEVEL, encodeVarintField(1, liveFanLevel(speed)));
    }
    return this._send((id) => this.protocol.buildSetFanSpeed(fanSpeed, id));
  }

  _cleanOptions({ fanSpeed, ...options } = {}) {
    const speed = fanSpeed ? C.normalizeFanSpeed(fanSpeed, this.binaryProtocol.topicPrefix) : this.fanSpeed;
    const fan = FAN_LEVEL[speed];
    return fan === undefined ? options : { ...options, fan };
  }

  async cleanRoom(roomIds, options = {}) {
    if (this.binaryMode) {
      const map = await this._getCleanableMap();
      if (!map || !(map.meta && map.meta.mapId)) {
        throw new Error('No active map id available. Refresh rooms/map before room cleaning.');
      }
      return this._sendBinaryCommand(
        C.BinaryCommandTopic.START_CLEAN,
        buildStartCleanPayload(roomIds, map.meta.mapId, this._cleanOptions(options)),
        C.SLOW_COMMAND_TIMEOUT_MS,
      );
    }
    return this._send((id) => this.protocol.buildCleanRoom(roomIds, id));
  }

  /**
   * One-shot connectivity probe used during pairing. Opens a socket, fetches a
   * status, then closes. Resolves with the normalized status or rejects with a
   * user-friendly error. Never leaves a socket open.
   */
  static probe({
    ip, port = C.DEFAULT_PORT, protocol = 'v1', productKey = 'QxMSPG6VSO', mock = false,
  } = {}) {
    return new Promise((resolve, reject) => {
      const proto = new NarwalProtocol(protocol);
      const binary = new NarwalBinaryProtocol({ productKey });
      let settled = false;
      let ws;

      const finish = (err, status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          if (ws) {
            ws.removeAllListeners();
            if (mock) ws.close();
            else ws.terminate();
          }
        } catch (_) { /* ignore */ }
        if (err) reject(err);
        else resolve(status);
      };

      const timeout = setTimeout(
        () => finish(new Error('Connection timed out. Check the IP address, that the robot is awake, and that no other app holds the connection.')),
        C.CONNECT_TIMEOUT_MS,
      );

      try {
        ws = mock ? new MockSocket({ protocol: proto }) : new WebSocket(`ws://${ip}:${port}`, { handshakeTimeout: C.CONNECT_TIMEOUT_MS, ...C.WEBSOCKET_OPTIONS });
      } catch (err) {
        finish(new Error(`Invalid connection settings: ${err.message}`));
        return;
      }

      let reqId = 1;
      ws.on('open', () => {
        try {
          if (mock) {
            ws.send(JSON.stringify(proto.buildGetStatus(reqId)));
          } else {
            for (const frame of binary.buildDiscoveryFrames(C.KNOWN_PRODUCT_KEYS)) ws.send(frame);
            setTimeout(() => {
              if (settled || !ws || ws.readyState !== WebSocket.OPEN) return;
              for (const frame of binary.buildWakeFrames()) ws.send(frame);
            }, 500);
          }
        } catch (err) {
          finish(err);
        }
      });
      ws.on('message', (raw) => {
        try {
          if (!mock) {
            const msg = binary.parse(raw);
            if (msg && (msg.shortTopic === 'status/robot_base_status' || msg.shortTopic === 'status/working_status')) {
              finish(null, binary.normalizeStatus(msg.decoded, msg.shortTopic));
            } else if (msg && msg.type === 'response' && msg.decoded && msg.decoded['2'] && typeof msg.decoded['2'] === 'object') {
              finish(null, binary.normalizeStatus(msg.decoded['2'], 'status/robot_base_status'));
            }
            return;
          }
          const parsed = proto.parseMessage(raw);
          if (parsed.type === 'reply' || (parsed.type === 'event' && /status|state/i.test(parsed.event))) {
            finish(null, proto.normalizeStatus(parsed.data));
          }
        } catch (_) { /* keep waiting */ }
      });
      ws.on('error', (err) => finish(new Error(`Could not reach the robot: ${err.message}`)));
      ws.on('close', () => finish(new Error('Robot closed the connection before replying. It may be asleep or busy with the official app.')));
      reqId += 1;
    });
  }
}

module.exports = { NarwalClient };

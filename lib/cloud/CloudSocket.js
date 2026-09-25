'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { BROADCAST_TOPICS, parseFrame } = require('../NarwalBinaryProtocol');
const {
  buildCloudPayload, splitCloudPayload, buildCorrelationData, toLocalFrame, isDeviceTopic,
} = require('./cloudFrame');

/**
 * A WebSocket-shaped connection to one robot over the Narwal cloud (MQTT 5).
 *
 * NarwalClient drives it like the local `ws` socket: frames it sends are
 * published as cloud requests, and cloud messages come back as local frames.
 * Commands, parsing, wake and state logic are shared with the local path.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
const AUTH_FAILURES = new Set([134, 135]); // bad user name or password, not authorized

class CloudSocket extends EventEmitter {
  constructor({
    account, productId, deviceId, connect = null, log = () => {},
  }) {
    super();
    this.readyState = CONNECTING;
    this._account = account;
    this._productId = productId;
    this._deviceId = deviceId;
    this._base = `/${productId}/${deviceId}`;
    this._connect = connect || require('mqtt').connect; // eslint-disable-line global-require
    this._log = log;
    this._client = null;
    this._subscribed = new Set();
    this._queue = Promise.resolve();
    setImmediate(() => this._start());
  }

  async _start() {
    let url;
    try {
      url = await this._account.brokerUrl();
    } catch (err) {
      this._fail(err);
      return;
    }
    if (this.readyState === CLOSED) return;
    const client = this._connect(url, {
      protocolVersion: 5,
      username: this._account.uuid,
      password: this._account.accessToken,
      clientId: `app_${this._account.uuid}_${crypto.randomUUID()}`,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: 15000,
    });
    this._client = client;
    client.on('connect', () => this._onConnect());
    client.on('message', (topic, payload) => this._onMessage(topic, payload));
    client.on('close', () => this._onClose());
    client.on('error', (err) => this._onError(err));
  }

  _onConnect() {
    const topics = BROADCAST_TOPICS.map((topic) => `${this._base}/${topic}`);
    this._client.subscribe(topics, { qos: 1 }, () => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.emit('open');
    });
  }

  _onMessage(topic, payload) {
    if (!isDeviceTopic(topic, this._productId, this._deviceId)) return;
    const { body } = splitCloudPayload(payload);
    this.emit('message', toLocalFrame(topic, body));
  }

  _onError(err) {
    if (AUTH_FAILURES.has(err && err.code)) {
      // The next connection (NarwalClient reconnects) uses the new token.
      this._account.refresh().catch((refreshErr) => this._log(`cloud token refresh failed: ${refreshErr.message}`));
    }
    this.emit('error', err);
  }

  _onClose() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close', 1006);
  }

  _fail(err) {
    this.emit('error', err);
    this._onClose();
  }

  // Same contract as ws.send(frame): accepts a local frame, returns at once.
  // Frames are published in order; each response topic is subscribed first.
  send(frame) {
    const msg = parseFrame(frame);
    if (!msg || !isDeviceTopic(msg.topic, this._productId, this._deviceId)) return;
    this._queue = this._queue
      .then(() => this._publish(msg.topic, msg.payload))
      .catch((err) => this._log(`cloud publish failed: ${err.message}`));
  }

  async _publish(topic, body) {
    if (this.readyState !== OPEN) return;
    const responseTopic = `${topic}/response`;
    if (!this._subscribed.has(responseTopic)) {
      await new Promise((resolve) => this._client.subscribe(responseTopic, { qos: 1 }, () => resolve()));
      this._subscribed.add(responseTopic);
    }
    await new Promise((resolve) => this._client.publish(topic, buildCloudPayload(this._account.uuid, body), {
      qos: 1,
      properties: { responseTopic, correlationData: buildCorrelationData(crypto.randomUUID()) },
    }, () => resolve()));
  }

  // MQTT has its own keep-alive; report the socket alive while it is open.
  ping() {
    if (this.readyState === OPEN) setImmediate(() => this.emit('pong'));
  }

  terminate() {
    this.readyState = CLOSED;
    if (this._client) this._client.end(true);
  }

  close() {
    this.terminate();
  }
}

module.exports = {
  CloudSocket, CONNECTING, OPEN, CLOSED,
};

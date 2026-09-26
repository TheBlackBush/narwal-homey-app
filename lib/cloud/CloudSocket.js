'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { BROADCAST_TOPICS, parseFrame, buildFrame } = require('../NarwalBinaryProtocol');
const { BinaryCommandTopic } = require('../constants');
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
const SUBSCRIBE_TIMEOUT_MS = 10000;

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
    this._stats = {
      subscribed: 0, refused: 0, published: 0, received: 0, lastTopics: [],
    };
    setImmediate(() => this._start());
  }

  async _start() {
    let url;
    try {
      url = await this._account.brokerUrl();
    } catch (err) {
      // Torn down while looking up the broker: nobody listens any more.
      if (this.readyState !== CLOSED) this._fail(err);
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
    // Without the broadcasts the robot's state never arrives, so a refused or
    // unconfirmed subscription fails the connection and NarwalClient retries.
    this._subscribe(topics).then(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.emit('open');
    }, (err) => {
      if (this.readyState !== CLOSED) this._fail(err);
    });
  }

  // Resolves once the broker grants every topic; rejects on an error, a
  // refused topic (reason code 128 or higher) or no answer in time.
  _subscribe(topics) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The Narwal cloud did not confirm the subscription.')), SUBSCRIBE_TIMEOUT_MS);
      this._client.subscribe(topics, { qos: 1 }, (err, granted) => {
        clearTimeout(timer);
        const refusedCount = (granted || []).filter((grant) => grant && grant.qos >= 128).length;
        this._stats.refused += refusedCount;
        const requested = Array.isArray(granted) ? granted.length : [].concat(topics).length;
        this._stats.subscribed += requested - refusedCount;
        if (err || refusedCount) reject(err || new Error('The Narwal cloud refused the subscription.'));
        else resolve();
      });
    });
  }

  _onMessage(topic, payload) {
    if (!isDeviceTopic(topic, this._productId, this._deviceId)) return;
    this._stats.received += 1;
    const short = String(topic).slice(this._base.length + 1);
    this._stats.lastTopics = [...this._stats.lastTopics.filter((t) => t !== short), short].slice(-5);
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
    if (this._client) this._client.end(true);
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
      // Publish even when the subscription fails: the command then times out
      // on its own instead of blocking every later frame.
      try {
        await this._subscribe(responseTopic);
        this._subscribed.add(responseTopic);
      } catch (err) {
        this._log(`response subscription failed: ${err.message}`);
      }
      if (this.readyState !== OPEN) return;
    }
    // Narwal's broker does not always acknowledge; waiting for it would stall
    // every later frame, so publish and move on.
    this._stats.published += 1;
    this._client.publish(topic, buildCloudPayload(this._account.uuid, body), {
      qos: 1,
      properties: { responseTopic, correlationData: buildCorrelationData(crypto.randomUUID()) },
    });
  }

  /** Counters for diagnostics: topics are short (no product or device id). */
  stats() {
    return { ...this._stats, lastTopics: [...this._stats.lastTopics] };
  }

  // MQTT keep-alive only proves the broker is reachable, not the robot. A
  // ping asks the robot for its base status; its reply counts as traffic, so
  // a robot that has gone offline trips NarwalClient's idle timeout.
  ping() {
    if (this.readyState !== OPEN) return;
    this.send(buildFrame(`${this._base}/${BinaryCommandTopic.GET_BASE_STATUS}`, Buffer.alloc(0)));
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
  CloudSocket, CONNECTING, OPEN, CLOSED, SUBSCRIBE_TIMEOUT_MS,
};

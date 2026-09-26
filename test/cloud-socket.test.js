'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  CloudSocket, OPEN, CLOSED, SUBSCRIBE_TIMEOUT_MS,
} = require('../lib/cloud/CloudSocket');
const { buildCloudPayload, splitCloudPayload } = require('../lib/cloud/cloudFrame');
const { NarwalBinaryProtocol, buildFrame, decodeProto } = require('../lib/NarwalBinaryProtocol');

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRODUCT = 'QxMSPG6VSO';
const DEVICE = '0123456789abcdef0123456789abcdef';
const BASE = `/${PRODUCT}/${DEVICE}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeAccount(overrides = {}) {
  return {
    uuid: UUID,
    accessToken: 'access-1',
    refreshed: 0,
    brokerUrl: async () => 'mqtts://broker.example:8883',
    async refresh() {
      this.refreshed += 1; this.accessToken = 'access-2';
    },
    ...overrides,
  };
}

function fakeMqtt() {
  const state = { options: null, url: null, client: null };
  const connect = (url, options) => {
    const client = new EventEmitter();
    client.subscribed = [];
    client.published = [];
    client.ended = false;
    client.subscribe = (topics, opts, cb) => {
      client.subscribed.push(...[].concat(topics)); setImmediate(() => cb && cb(null));
    };
    client.publish = (topic, payload, opts, cb) => {
      client.published.push({ topic, payload, opts }); if (cb) setImmediate(() => cb(null));
    };
    client.end = (force, cb) => {
      client.ended = true; if (cb) cb();
    };
    Object.assign(state, { url, options, client });
    return client;
  };
  return { connect, state };
}

async function openSocket(account = fakeAccount()) {
  const mqtt = fakeMqtt();
  const socket = new CloudSocket({
    account, productId: PRODUCT, deviceId: DEVICE, connect: mqtt.connect,
  });
  const opened = new Promise((resolve) => socket.once('open', resolve));
  await tick();
  mqtt.state.client.emit('connect', { reasonCode: 0 });
  await opened;
  return { socket, mqtt, client: mqtt.state.client };
}

test('connects to the account broker with the account uuid and access token', async () => {
  const { socket, mqtt } = await openSocket();

  assert.strictEqual(mqtt.state.url, 'mqtts://broker.example:8883');
  assert.strictEqual(mqtt.state.options.protocolVersion, 5);
  assert.strictEqual(mqtt.state.options.username, UUID);
  assert.strictEqual(mqtt.state.options.password, 'access-1');
  assert.match(mqtt.state.options.clientId, new RegExp(`^app_${UUID}_`));
  assert.strictEqual(socket.readyState, OPEN);
});

test('subscribes to the robot broadcasts explicitly (the broker ignores wildcards)', async () => {
  const { client } = await openSocket();

  assert.ok(client.subscribed.includes(`${BASE}/status/robot_base_status`));
  assert.ok(client.subscribed.includes(`${BASE}/status/working_status`));
  assert.ok(!client.subscribed.some((t) => t.includes('#') || t.includes('+')));
});

test('sends local frames as cloud requests with a response topic, subscribed first', async () => {
  const { socket, client } = await openSocket();

  socket.send(buildFrame(`${BASE}/common/yell`, Buffer.from([0x08, 0x01])));
  await tick(); await tick();

  const sent = client.published[0];
  assert.strictEqual(sent.topic, `${BASE}/common/yell`);
  assert.ok(client.subscribed.indexOf(`${BASE}/common/yell/response`) >= 0, 'response topic subscribed');
  assert.strictEqual(sent.opts.properties.responseTopic, `${BASE}/common/yell/response`);
  assert.ok(Buffer.isBuffer(sent.opts.properties.correlationData));
  const { header, body } = splitCloudPayload(sent.payload);
  assert.deepStrictEqual(decodeProto(header), { 1: UUID, 2: UUID });
  assert.deepStrictEqual(body, Buffer.from([0x08, 0x01]));
});

test('keeps the order of frames sent back to back', async () => {
  const { socket, client } = await openSocket();

  socket.send(buildFrame(`${BASE}/common/notify_app_event`, Buffer.alloc(0)));
  socket.send(buildFrame(`${BASE}/common/active_robot_publish`, Buffer.alloc(0)));
  socket.send(buildFrame(`${BASE}/status/get_device_base_status`, Buffer.alloc(0)));
  for (let i = 0; i < 6; i += 1) await tick();

  assert.deepStrictEqual(client.published.map((p) => p.topic.split('/').slice(3).join('/')), [
    'common/notify_app_event', 'common/active_robot_publish', 'status/get_device_base_status',
  ]);
});

test('does not publish frames for other robots or product keys', async () => {
  const { socket, client } = await openSocket();

  socket.send(buildFrame('//common/get_device_info', Buffer.alloc(0)));
  socket.send(buildFrame(`/QoEsI5qYXO/${DEVICE}/common/get_device_info`, Buffer.alloc(0)));
  for (let i = 0; i < 4; i += 1) await tick();

  assert.strictEqual(client.published.length, 0);
});

test('delivers cloud messages as local frames the protocol parser reads', async () => {
  const { socket, client } = await openSocket();
  const protocol = new NarwalBinaryProtocol({ productKey: PRODUCT, deviceId: DEVICE });
  const received = [];
  socket.on('message', (frame) => received.push(protocol.parse(frame)));

  client.emit('message', `${BASE}/status/robot_base_status`, buildCloudPayload(UUID, Buffer.from([0x1a, 0x02, 0x08, 0x0a])));
  client.emit('message', `${BASE}/common/yell/response`, buildCloudPayload(UUID, Buffer.from([0x08, 0x01])));

  assert.strictEqual(received[0].type, 'broadcast');
  assert.strictEqual(received[0].shortTopic, 'status/robot_base_status');
  assert.deepStrictEqual(received[0].decoded, { 3: { 1: 10 } });
  assert.strictEqual(received[1].type, 'response');
  assert.strictEqual(received[1].shortTopic, 'common/yell');
});

test('a ping asks the robot for its status instead of answering for it', async () => {
  const { socket, client } = await openSocket();
  let pongs = 0;
  socket.on('pong', () => {
    pongs += 1;
  });

  socket.ping();
  for (let i = 0; i < 4; i += 1) await tick();

  // Only a reply from the robot proves it is online.
  assert.strictEqual(pongs, 0);
  assert.ok(client.published.some((p) => p.topic === `${BASE}/status/get_device_base_status`));
});

test('reports close once', async () => {
  const { socket, client } = await openSocket();
  let closes = 0;
  socket.on('close', () => {
    closes += 1;
  });

  client.emit('close');
  client.emit('close');

  assert.strictEqual(closes, 1);
  assert.strictEqual(socket.readyState, CLOSED);
});

function socketWithSubscribe(subscribe) {
  const mqtt = fakeMqtt();
  const socket = new CloudSocket({
    account: fakeAccount(),
    productId: PRODUCT,
    deviceId: DEVICE,
    connect: (url, options) => {
      const client = mqtt.connect(url, options);
      client.subscribe = subscribe;
      return client;
    },
  });
  const events = [];
  socket.on('open', () => events.push('open'));
  socket.on('error', () => events.push('error'));
  socket.on('close', () => events.push('close'));
  return { socket, mqtt, events };
}

test('a broadcast subscription the broker refuses closes the socket', async () => {
  const { mqtt, events } = socketWithSubscribe((topics, opts, cb) => setImmediate(() => cb(new Error('Not authorized'))));
  await tick();
  mqtt.state.client.emit('connect', { reasonCode: 0 });
  await tick(); await tick();

  assert.deepStrictEqual(events, ['error', 'close']);
  assert.strictEqual(mqtt.state.client.ended, true);
});

test('a broadcast subscription the broker never confirms closes the socket in time', async () => {
  const { mqtt, events } = socketWithSubscribe(() => {});
  await tick();
  test.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    mqtt.state.client.emit('connect', { reasonCode: 0 });
    test.mock.timers.tick(SUBSCRIBE_TIMEOUT_MS);
    await tick();

    assert.deepStrictEqual(events, ['error', 'close']);
  } finally {
    test.mock.timers.reset();
  }
});

test('an unconfirmed response subscription does not block later frames', async () => {
  const { socket, client } = await openSocket();
  client.subscribe = (topics, opts, cb) => {
    client.subscribed.push(...[].concat(topics)); // never confirmed
  };
  test.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    socket.send(buildFrame(`${BASE}/common/yell`, Buffer.alloc(0)));
    socket.send(buildFrame(`${BASE}/task/pause`, Buffer.alloc(0)));
    for (let i = 0; i < 4; i += 1) {
      test.mock.timers.tick(SUBSCRIBE_TIMEOUT_MS);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }

    assert.deepStrictEqual(client.published.map((p) => p.topic.split('/').slice(3).join('/')), ['common/yell', 'task/pause']);
  } finally {
    test.mock.timers.reset();
  }
});

test('terminate ends the MQTT session', async () => {
  const { socket, client } = await openSocket();

  socket.terminate();

  assert.strictEqual(client.ended, true);
  assert.strictEqual(socket.readyState, CLOSED);
});

test('a rejected MQTT login refreshes the token and reports the error', async () => {
  const account = fakeAccount();
  const mqtt = fakeMqtt();
  const socket = new CloudSocket({
    account, productId: PRODUCT, deviceId: DEVICE, connect: mqtt.connect,
  });
  const errors = [];
  socket.on('error', (err) => errors.push(err));
  await tick();

  const authError = new Error('Connection refused: Not authorized');
  authError.code = 135;
  mqtt.state.client.emit('error', authError);
  await tick();

  assert.strictEqual(account.refreshed, 1);
  assert.strictEqual(errors.length, 1);
});

test('a broker lookup failure surfaces as error and close', async () => {
  const account = fakeAccount({
    brokerUrl: async () => {
      throw new Error('Sign in again');
    },
  });
  const socket = new CloudSocket({
    account, productId: PRODUCT, deviceId: DEVICE, connect: fakeMqtt().connect,
  });
  const events = [];
  socket.on('error', () => events.push('error'));
  socket.on('close', () => events.push('close'));
  await tick(); await tick();

  assert.deepStrictEqual(events, ['error', 'close']);
  assert.strictEqual(socket.readyState, CLOSED);
});

test('NarwalClient in cloud mode sends its wake sequence and reports status from the cloud', async () => {
  const { NarwalClient } = require('../lib/NarwalClient'); // eslint-disable-line global-require
  const mqtt = fakeMqtt();
  const client = new NarwalClient({
    productKey: PRODUCT, deviceId: DEVICE, pollInterval: 60000, cloud: { account: fakeAccount(), connect: mqtt.connect },
  });
  const statuses = [];
  client.on('status', (s) => statuses.push(s));
  client.start();
  await tick();
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    mqtt.state.client.emit('connect', { reasonCode: 0 });
    for (let i = 0; i < 4; i += 1) await tick(); // subscription confirmed, socket open
    test.mock.timers.tick(500); // the wake burst follows discovery
    for (let i = 0; i < 20; i += 1) await tick(); // frames are published one by one
  } finally {
    test.mock.timers.reset();
  }

  const topics = mqtt.state.client.published.map((p) => p.topic.split('/').slice(3).join('/'));
  const wake = topics.indexOf('common/notify_app_event');
  assert.ok(wake >= 0, 'wake sequence published');
  assert.ok(topics.indexOf('status/get_device_base_status', wake) > wake, 'base status is asked for after the wake event');
  assert.ok(mqtt.state.client.published.every((p) => p.topic.startsWith(`${BASE}/`)), 'only this robot');

  mqtt.state.client.emit('message', `${BASE}/status/robot_base_status`, buildCloudPayload(UUID, Buffer.from([0x1a, 0x02, 0x08, 0x0a])));
  assert.strictEqual(statuses.at(-1).state, 'docked');
  client.stop();
});

test('frames keep flowing when the broker never acknowledges a publish', async () => {
  const { socket, client } = await openSocket();
  client.publish = (topic, payload, opts) => {
    client.published.push({ topic, payload, opts });
  }; // no callback, ever

  socket.send(buildFrame(`${BASE}/common/get_device_info`, Buffer.alloc(0)));
  socket.send(buildFrame(`${BASE}/common/notify_app_event`, Buffer.alloc(0)));
  for (let i = 0; i < 6; i += 1) await tick();

  assert.deepStrictEqual(client.published.map((p) => p.topic.split('/').slice(3).join('/')), ['common/get_device_info', 'common/notify_app_event']);
});

test('the cloud socket counts what it subscribed, sent and received, without IDs', async () => {
  const { socket, client } = await openSocket();

  socket.send(buildFrame(`${BASE}/common/yell`, Buffer.alloc(0)));
  for (let i = 0; i < 4; i += 1) await tick();
  client.emit('message', `${BASE}/status/robot_base_status`, buildCloudPayload(UUID, Buffer.from([0x08, 0x01])));

  const stats = socket.stats();
  assert.ok(stats.subscribed > 5, 'broadcast topics plus the response topic');
  assert.strictEqual(stats.refused, 0);
  assert.strictEqual(stats.published, 1);
  assert.strictEqual(stats.received, 1);
  assert.deepStrictEqual(stats.lastTopics, ['status/robot_base_status']);
  assert.ok(!JSON.stringify(stats).includes(DEVICE), 'no device id');
});

test('diagnostics record refused publishes, broker disconnects and messages for other topics, masked', async () => {
  const { socket, client } = await openSocket();
  client.publish = (topic, payload, opts, cb) => {
    const err = new Error('Not authorized'); err.code = 135; cb(err);
  };

  socket.send(buildFrame(`${BASE}/common/yell`, Buffer.alloc(0)));
  for (let i = 0; i < 4; i += 1) await tick();
  client.emit('message', `${PRODUCT}/${DEVICE}/status/robot_base_status`, Buffer.alloc(0)); // no leading slash
  client.emit('disconnect', { reasonCode: 142 });

  const stats = socket.stats();
  assert.strictEqual(stats.publishErrors, 1);
  assert.strictEqual(stats.lastPublishError, '135 Not authorized');
  assert.strictEqual(stats.rawReceived, 1);
  assert.deepStrictEqual(stats.otherTopics, ['<product>/<device>/status/robot_base_status']);
  assert.strictEqual(stats.disconnectReason, 142);
});

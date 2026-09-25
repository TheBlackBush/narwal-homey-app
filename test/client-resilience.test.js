'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { NarwalClient } = require('../lib/NarwalClient');
const { CloudSocket } = require('../lib/cloud/CloudSocket');
const C = require('../lib/constants');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Collects process-level crashes (uncaught errors, unhandled rejections)
// while `fn` runs.
async function crashesDuring(fn) {
  const crashes = [];
  const onCrash = (err) => crashes.push(err);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  try {
    await fn();
  } finally {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
  return crashes;
}

function fakeOpenSocket() {
  return {
    readyState: 1, send: () => {}, ping: () => {}, removeAllListeners: () => {}, terminate: () => {}, on: () => {},
  };
}

test('stopping a client whose socket is still connecting does not crash the app', async () => {
  // Accepts TCP but never answers the WebSocket upgrade, like a stale IP
  // that still routes somewhere.
  const sockets = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new NarwalClient({
    ip: '127.0.0.1', port: server.address().port, productKey: 'QxMSPG6VSO', pollInterval: 60000,
  });
  client.on('error', () => {});

  const crashes = await crashesDuring(async () => {
    client.start();
    await sleep(100);
    client.stop();
    await sleep(100);
  });

  sockets.forEach((socket) => socket.destroy());
  server.close();
  assert.deepStrictEqual(crashes.map((err) => err.message), []);
});

test('stopping a cloud socket before the broker lookup fails does not crash the app', async () => {
  let failLookup;
  const account = {
    brokerUrl: () => new Promise((resolve, reject) => {
      failLookup = reject;
    }),
  };
  const socket = new CloudSocket({
    account,
    productId: 'QxMSPG6VSO',
    deviceId: 'dev',
    connect: () => {
      throw new Error('not reached');
    },
  });

  const crashes = await crashesDuring(async () => {
    await tick();
    socket.removeAllListeners();
    socket.terminate();
    failLookup(new Error('Sign in again'));
    await tick();
    await tick();
  });

  assert.deepStrictEqual(crashes.map((err) => err.message), []);
});

function offlineClient() {
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'QxMSPG6VSO', pollInterval: 60000 });
  client._scheduleReconnect = () => {}; // attempts are driven by hand
  const events = [];
  client.on('connected', () => events.push('connected'));
  client.on('disconnected', () => events.push('disconnected'));
  return { client, events };
}

test('an outage is reported once, not on every failed reconnect attempt', () => {
  const { client, events } = offlineClient();

  client._onClose(-1);
  client._onClose(-1);
  client._onClose(-1);

  assert.deepStrictEqual(events, ['disconnected']);
  client.stop();
});

test('a new outage after the robot was back is reported again', () => {
  test.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, events } = offlineClient();
  try {
    client._onClose(-1);
    client._ws = fakeOpenSocket();
    client._onOpen();
    client._onClose(1006);

    assert.deepStrictEqual(events, ['disconnected', 'connected', 'disconnected']);
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

test('the reconnect backoff only resets after the connection stays up', () => {
  test.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'QxMSPG6VSO', pollInterval: 60000 });
  client._ws = fakeOpenSocket();
  try {
    client._reconnectAttempt = 5;
    client._onOpen();
    assert.strictEqual(client._reconnectAttempt, 5, 'a robot that accepts and drops at once keeps backing off');

    test.mock.timers.tick(C.CONNECTION_STABLE_MS);
    assert.strictEqual(client._reconnectAttempt, 0);
  } finally {
    client.stop();
    test.mock.timers.reset();
  }
});

function binaryClient() {
  const client = new NarwalClient({ ip: '127.0.0.1', productKey: 'QxMSPG6VSO', pollInterval: 60000 });
  client._ws = fakeOpenSocket();
  return client;
}

async function settled(promise) {
  let state = 'pending';
  promise.then(() => {
    state = 'resolved';
  }, () => {
    state = 'rejected';
  });
  await tick();
  await tick();
  return state;
}

const reply = (shortTopic, decoded) => ({ shortTopic, decoded, payload: Buffer.alloc(0) });

test('a command ignores replies to other topics and replies without a result code', async () => {
  const client = binaryClient();
  const pending = client.pauseClean();
  pending.catch(() => {});
  await tick();

  // Cloud replies name their topic: another command's reply is not ours.
  client._enqueueBinaryResponse(reply('task/resume', { 1: 1 }));
  // Local replies carry no topic: device-info and status replies have no
  // numeric result code and must not count as success.
  client._enqueueBinaryResponse(reply('', { 1: 'QxMSPG6VSO' }));
  client._enqueueBinaryResponse(reply('', { 1: { 1: 1000 } }));
  assert.strictEqual(await settled(pending), 'pending');

  client._enqueueBinaryResponse(reply('', { 1: 1 }));
  const result = await pending;
  assert.strictEqual(result.ok, true);
  client.stop();
});

test('a command reply for the same topic with a failure code still rejects', async () => {
  const client = binaryClient();
  const pending = client.pauseClean();
  await tick();

  client._enqueueBinaryResponse(reply('task/pause', { 1: 2 }));

  await assert.rejects(pending);
  client.stop();
});

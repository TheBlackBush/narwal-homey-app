'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { URL } = require('node:url');

const { NarwalCloudAccount, NarwalCloudError } = require('../lib/cloud/NarwalCloudAccount');

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function jwt(payload) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part(payload)}.sig`;
}

// Fake Narwal API: routes by path, records every request.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({
      host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, headers: init.headers || {}, body,
    });
    const handler = routes[u.pathname];
    const out = handler ? handler({
      body, headers: init.headers || {}, query: Object.fromEntries(u.searchParams), calls,
    }) : { status: 404, json: {} };
    const status = out.status || 200;
    return {
      status, ok: status < 400, json: async () => out.json, text: async () => JSON.stringify(out.json),
    };
  };
  return { fetch, calls };
}

const tokens = (n = 1) => ({ token: jwt({ uuid: UUID, n }), refresh_token: `refresh-${n}`, uuid: UUID });

test('password sign-in uses the country host, sends the official fields and keeps no password', async () => {
  const { fetch, calls } = fakeFetch({
    '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: 0, result: tokens() } }),
  });
  const account = new NarwalCloudAccount({ country: 'IL', fetch });

  await account.loginWithPassword('me@example.com', 'secret');

  assert.strictEqual(calls[0].host, 'il-app.narwaltech.com');
  assert.deepStrictEqual(Object.keys(calls[0].body).sort(), ['app_version', 'captcha_code', 'email', 'over_fourteen_years', 'password'].sort());
  assert.strictEqual(calls[0].body.password, 'secret');
  assert.strictEqual(account.uuid, UUID);
  const state = account.toJSON();
  assert.deepStrictEqual(Object.keys(state).sort(), ['accessToken', 'country', 'email', 'refreshToken', 'uuid']);
  assert.ok(!JSON.stringify(state).includes('secret'));
});

test('a rejected password sign-in throws with the server message', async () => {
  const { fetch } = fakeFetch({
    '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: -1, msg: 'Account or password is incorrect' } }),
  });
  const account = new NarwalCloudAccount({ country: 'IL', fetch });

  await assert.rejects(account.loginWithPassword('me@example.com', 'wrong'), (err) => err instanceof NarwalCloudError && /incorrect/.test(err.message));
  assert.strictEqual(account.uuid, null);
});

test('email code sign-in requests a login code and sends it as verification', async () => {
  const { fetch, calls } = fakeFetch({
    '/user-authentication-server/v3/email-code/generateEmailCode': () => ({ json: { code: 0, msg: 'ok' } }),
    '/user-authentication-server/v2/login/loginByEmailVerificationCode': () => ({ json: { code: 0, result: { ...tokens(), is_new_user: false } } }),
  });
  const account = new NarwalCloudAccount({ country: 'IL', fetch });

  await account.requestEmailCode('me@example.com');
  await account.loginWithEmailCode('me@example.com', ' 530105 ');

  assert.deepStrictEqual(calls[0].body, { email: 'me@example.com', code_type: 1 });
  const login = calls[1].body;
  assert.strictEqual(login.verification, 530105);
  assert.strictEqual(login.code_type, 1);
  assert.strictEqual(login.last_login_system, 6);
  assert.ok(login.default_nickname);
  assert.strictEqual(login.code, undefined);
  assert.strictEqual(account.uuid, UUID);
});

test('email code sign-in refuses an email that had no Narwal account', async () => {
  const { fetch, calls } = fakeFetch({
    '/user-authentication-server/v2/login/loginByEmailVerificationCode': () => ({ json: { code: 0, result: { ...tokens(), is_new_user: true } } }),
    '/user-authentication-server/v2/logout/getUserLogout': () => ({ json: { code: 0 } }),
  });
  const account = new NarwalCloudAccount({ country: 'IL', fetch });

  await assert.rejects(account.loginWithEmailCode('new@example.com', '123456'), /No Narwal account/);
  assert.strictEqual(account.uuid, null);
  assert.ok(calls.some((c) => c.path.endsWith('/getUserLogout')), 'the new session is signed out');
});

test('robot list and broker use the access token', async () => {
  const { fetch, calls } = fakeFetch({
    '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: 0, result: tokens() } }),
    '/user-device-platform-server/device-info/getDeviceInfoList': () => ({
      json: {
        code: 0,
        result: {
          deviceInfoList: [{
            deviceId: 'd'.repeat(32), productId: 'QxMSPG6VSO', robotName: 'Narwal Flow 2', firmwareVersion: 'v01.09.10.02', snNumber: 'SN',
          }],
        },
      },
    }),
    '/iot-broker-discover/app/v1/broker/discover': ({ query }) => ({ json: { code: 0, result: `mqtts://broker-${query.country}.example:8883` } }),
  });
  const account = new NarwalCloudAccount({ country: 'IL', fetch });
  await account.loginWithPassword('me@example.com', 'secret');

  const robots = await account.listRobots();
  const broker = await account.brokerUrl();
  await account.brokerUrl();

  assert.deepStrictEqual(robots, [{
    deviceId: 'd'.repeat(32), productId: 'QxMSPG6VSO', name: 'Narwal Flow 2', firmware: 'v01.09.10.02',
  }]);
  assert.strictEqual(broker, 'mqtts://broker-IL.example:8883');
  assert.strictEqual(calls.filter((c) => c.path.endsWith('/discover')).length, 1, 'broker is cached');
  const listCall = calls.find((c) => c.path.endsWith('/getDeviceInfoList'));
  assert.strictEqual(listCall.headers['auth-token'], account.toJSON().accessToken);
});

test('a rejected token is refreshed once and the request retried', async () => {
  let listCalls = 0;
  const { fetch, calls } = fakeFetch({
    '/user-device-platform-server/device-info/getDeviceInfoList': ({ headers }) => {
      listCalls += 1;
      return headers['auth-token'] === 'new-access' ? { json: { code: 0, result: { deviceInfoList: [] } } } : { status: 401, json: {} };
    },
    '/user-authentication-server/v1/token/refresh': ({ body }) => (body.refreshToken === 'old-refresh'
      ? { json: { code: 0, result: { token: 'new-access', refreshToken: 'new-refresh' } } }
      : { json: { code: -1 } }),
  });
  const updates = [];
  const account = NarwalCloudAccount.fromJSON({
    country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'old-access', refreshToken: 'old-refresh',
  }, { fetch, onTokens: (state) => updates.push(state) });

  assert.deepStrictEqual(await account.listRobots(), []);
  assert.strictEqual(listCalls, 2);
  assert.strictEqual(account.toJSON().refreshToken, 'new-refresh');
  assert.strictEqual(updates.length, 1, 'new tokens are reported for storage');
  assert.strictEqual(calls.filter((c) => c.path.endsWith('/token/refresh')).length, 1);
});

test('a failed refresh marks the account as needing a new sign-in', async () => {
  const { fetch } = fakeFetch({
    '/user-device-platform-server/device-info/getDeviceInfoList': () => ({ status: 401, json: {} }),
    '/user-authentication-server/v1/token/refresh': () => ({ json: { code: -1, msg: 'expired' } }),
  });
  const account = NarwalCloudAccount.fromJSON({
    country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'a', refreshToken: 'r',
  }, { fetch });

  await assert.rejects(account.listRobots(), (err) => err.code === 'SIGN_IN_REQUIRED');
});

test('concurrent requests share a single refresh', async () => {
  let refreshes = 0;
  const { fetch } = fakeFetch({
    '/user-device-platform-server/device-info/getDeviceInfoList': ({ headers }) => (headers['auth-token'] === 'new'
      ? { json: { code: 0, result: { deviceInfoList: [] } } }
      : { status: 401, json: {} }),
    '/user-authentication-server/v1/token/refresh': () => {
      refreshes += 1;
      return { json: { code: 0, result: { token: 'new', refreshToken: 'r2' } } };
    },
  });
  const account = NarwalCloudAccount.fromJSON({
    country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'old', refreshToken: 'r1',
  }, { fetch });

  await Promise.all([account.listRobots(), account.listRobots(), account.listRobots()]);
  assert.strictEqual(refreshes, 1);
});

test('only an encrypted broker address is accepted, since the token is sent to it', async () => {
  for (const [url, ok] of [['mqtts://b.example:8883', true], ['wss://b.example/mqtt', true], ['mqtt://b.example:1883', false], ['ws://b.example/mqtt', false]]) {
    const { fetch } = fakeFetch({
      '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: 0, result: tokens() } }),
      '/iot-broker-discover/app/v1/broker/discover': () => ({ json: { code: 0, result: url } }),
    });
    const account = new NarwalCloudAccount({ country: 'IL', fetch });
    await account.loginWithPassword('me@example.com', 'secret');
    if (ok) assert.strictEqual(await account.brokerUrl(), url);
    else await assert.rejects(account.brokerUrl(), /broker/, url);
  }
});

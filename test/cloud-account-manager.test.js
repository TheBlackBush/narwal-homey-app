'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { URL } = require('node:url');

const { CloudAccountManager, SETTINGS_KEY } = require('../lib/cloud/CloudAccountManager');

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fakeSettings(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (key) => (key in data ? data[key] : null),
    set: (key, value) => {
      data[key] = value;
    },
    unset: (key) => {
      delete data[key];
    },
  };
}

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[u.pathname];
    const out = handler ? handler() : { json: { code: -1, msg: 'not found' } };
    return { status: out.status || 200, json: async () => out.json };
  };
  return { fetch, calls };
}

const session = { token: 'access', refresh_token: 'refresh', uuid: UUID };

test('starts signed out with no stored account', () => {
  const manager = new CloudAccountManager({ settings: fakeSettings(), fetch: async () => {} });

  assert.deepStrictEqual(manager.status(), {
    mode: 'local', signedIn: false, email: null, country: null,
  });
  assert.strictEqual(manager.getAccount(), null);
});

test('password sign-in stores tokens only and reports the account', async () => {
  const settings = fakeSettings();
  const { fetch, calls } = fakeFetch({ '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: 0, result: session } }) });
  const manager = new CloudAccountManager({ settings, fetch });
  let changes = 0;
  manager.on('changed', () => {
    changes += 1;
  });

  await manager.loginWithPassword({ email: ' me@example.com ', password: 'secret', country: 'il' });

  assert.strictEqual(calls[0].host, 'il-app.narwaltech.com');
  assert.deepStrictEqual(manager.status(), {
    mode: 'local', signedIn: true, email: 'me@example.com', country: 'IL',
  });
  assert.ok(!JSON.stringify(settings.data[SETTINGS_KEY]).includes('secret'), 'password is not stored');
  assert.strictEqual(settings.data[SETTINGS_KEY].refreshToken, 'refresh');
  assert.strictEqual(changes, 1);
});

test('a stored account is restored after a restart and keeps new tokens', async () => {
  const settings = fakeSettings({
    [SETTINGS_KEY]: {
      country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'old', refreshToken: 'r1',
    },
  });
  const { fetch } = fakeFetch({
    '/user-device-platform-server/device-info/getDeviceInfoList': () => ({ status: 401, json: {} }),
    '/user-authentication-server/v1/token/refresh': () => ({ json: { code: 0, result: { token: 'new', refreshToken: 'r2' } } }),
  });
  const manager = new CloudAccountManager({ settings, fetch });

  assert.strictEqual(manager.status().signedIn, true);
  await manager.getAccount().listRobots().catch(() => {});

  assert.strictEqual(settings.data[SETTINGS_KEY].refreshToken, 'r2', 'refreshed tokens are persisted');
  assert.strictEqual(manager.getAccount(), manager.getAccount(), 'one shared account object');
});

test('email code sign-in requests the code and then signs in', async () => {
  const { fetch, calls } = fakeFetch({
    '/user-authentication-server/v3/email-code/generateEmailCode': () => ({ json: { code: 0 } }),
    '/user-authentication-server/v2/login/loginByEmailVerificationCode': () => ({ json: { code: 0, result: { ...session, is_new_user: false } } }),
  });
  const manager = new CloudAccountManager({ settings: fakeSettings(), fetch });

  await manager.requestEmailCode({ email: 'me@example.com', country: 'IL' });
  await manager.loginWithEmailCode({ email: 'me@example.com', code: '123456', country: 'IL' });

  assert.deepStrictEqual(calls.map((c) => c.path.split('/').pop()), ['generateEmailCode', 'loginByEmailVerificationCode']);
  assert.strictEqual(manager.status().signedIn, true);
});

test('a failed sign-in keeps the previous account', async () => {
  const settings = fakeSettings({
    [SETTINGS_KEY]: {
      country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'a', refreshToken: 'r',
    },
  });
  const { fetch } = fakeFetch({ '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: -1, msg: 'Account or password is incorrect' } }) });
  const manager = new CloudAccountManager({ settings, fetch });

  await assert.rejects(manager.loginWithPassword({ email: 'other@example.com', password: 'x', country: 'IL' }), /incorrect/);
  assert.strictEqual(manager.status().email, 'me@example.com');
});

test('input is validated before anything is sent', async () => {
  const { fetch, calls } = fakeFetch({});
  const manager = new CloudAccountManager({ settings: fakeSettings(), fetch });

  await assert.rejects(manager.loginWithPassword({ email: 'not-an-email', password: 'x', country: 'IL' }), /email/i);
  await assert.rejects(manager.loginWithPassword({ email: 'me@example.com', password: '', country: 'IL' }), /password/i);
  await assert.rejects(manager.requestEmailCode({ email: 'me@example.com', country: 'Israel' }), /country/i);
  assert.strictEqual(calls.length, 0);
});

test('sign-out forgets the account', async () => {
  const settings = fakeSettings({
    [SETTINGS_KEY]: {
      country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'a', refreshToken: 'r',
    },
  });
  const manager = new CloudAccountManager({ settings, fetch: async () => {} });
  let changes = 0;
  manager.on('changed', () => {
    changes += 1;
  });

  manager.logout();

  assert.strictEqual(manager.status().signedIn, false);
  assert.strictEqual(manager.getAccount(), null);
  assert.ok(!(SETTINGS_KEY in settings.data));
  assert.strictEqual(changes, 1);
});

test('the app connection mode defaults to local and is stored', () => {
  const settings = fakeSettings();
  const manager = new CloudAccountManager({ settings, fetch: async () => {} });
  const events = [];
  manager.on('changed', (e) => events.push(e));

  assert.strictEqual(manager.getMode(), 'local');
  manager.setMode('cloud');
  assert.strictEqual(manager.getMode(), 'cloud');
  assert.strictEqual(settings.data.connection_mode, 'cloud');
  assert.strictEqual(events.at(-1).modeChanged, true);

  manager.setMode('cloud');
  assert.strictEqual(events.length, 1, 'no event when the mode stays the same');
  assert.throws(() => manager.setMode('satellite'), /Local or Cloud/);
});

test('status reports the mode and account changes say whether robots must reconnect', async () => {
  const { fetch } = fakeFetch({ '/user-authentication-server/v2/login/loginByEmail': () => ({ json: { code: 0, result: session } }) });
  const manager = new CloudAccountManager({ settings: fakeSettings({ connection_mode: 'cloud' }), fetch });
  const events = [];
  manager.on('changed', (e) => events.push(e));

  assert.strictEqual(manager.status().mode, 'cloud');
  await manager.loginWithPassword({ email: 'me@example.com', password: 'secret', country: 'IL' });

  assert.strictEqual(events.at(-1).modeChanged, false);
  assert.strictEqual(events.at(-1).mode, 'cloud');
});

test('a token refresh that finishes after sign-out does not sign the account back in', () => {
  const settings = fakeSettings({
    [SETTINGS_KEY]: {
      country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'a', refreshToken: 'r',
    },
  });
  const manager = new CloudAccountManager({ settings, fetch: async () => {} });
  const old = manager.getAccount();

  manager.logout();
  old._emitTokens(); // what a refresh already in flight does when it lands

  assert.ok(!(SETTINGS_KEY in settings.data), 'old tokens are not stored again');
});

test('sign-out also ends the session on the Narwal server, without waiting for it', async () => {
  const settings = fakeSettings({
    [SETTINGS_KEY]: {
      country: 'IL', email: 'me@example.com', uuid: UUID, accessToken: 'a', refreshToken: 'r',
    },
  });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ path: new URL(url).pathname, auth: init.headers['auth-token'] });
    throw new Error('offline'); // must not affect the local sign-out
  };
  const manager = new CloudAccountManager({ settings, fetch });

  manager.logout();
  assert.strictEqual(manager.status().signedIn, false, 'signed out at once');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(calls, [{ path: '/user-authentication-server/v2/logout/getUserLogout', auth: 'a' }]);
});

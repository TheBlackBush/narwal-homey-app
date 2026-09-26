'use strict';

const { URL } = require('url');
const { apiHostForCountry } = require('./cloudFrame');
const { NarwalCloudError } = require('./NarwalCloudError');

/**
 * A Narwal account on the Narwal cloud: sign-in (password or emailed code),
 * token refresh, the account's robots and the MQTT broker address.
 *
 * Only the token pair, account UUID, email and country are kept (toJSON);
 * the password never is. Request bodies follow the official app.
 */

const APP_VERSION = '2.9.90';
const EMAIL_CODE_LOGIN = 1; // EmailPinKind.login in the official app
const LAST_LOGIN_SYSTEM = 6;
const ENCRYPTED_BROKER = /^(mqtts|wss|ssl|tls):\/\//i;

const PATHS = {
  loginByEmail: '/user-authentication-server/v2/login/loginByEmail',
  generateEmailCode: '/user-authentication-server/v3/email-code/generateEmailCode',
  loginByEmailCode: '/user-authentication-server/v2/login/loginByEmailVerificationCode',
  logout: '/user-authentication-server/v2/logout/getUserLogout',
  refresh: '/user-authentication-server/v1/token/refresh',
  robots: '/user-device-platform-server/device-info/getDeviceInfoList',
  broker: '/iot-broker-discover/app/v1/broker/discover',
};

function uuidFromToken(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).uuid || null;
  } catch (_) {
    return null;
  }
}

class NarwalCloudAccount {
  constructor({
    country, fetch = globalThis.fetch, onTokens = null, appVersion = APP_VERSION,
  } = {}) {
    this.country = String(country || '').trim().toUpperCase();
    this.host = apiHostForCountry(this.country);
    this._fetch = fetch;
    this._onTokens = onTokens;
    this._appVersion = appVersion;
    this.email = null;
    this.uuid = null;
    this._access = null;
    this._refresh = null;
    this._refreshing = null;
    this._broker = null;
  }

  static fromJSON(state = {}, options = {}) {
    const account = new NarwalCloudAccount({ ...options, country: state.country });
    account.email = state.email || null;
    account.uuid = state.uuid || null;
    account._access = state.accessToken || null;
    account._refresh = state.refreshToken || null;
    return account;
  }

  toJSON() {
    return {
      country: this.country,
      email: this.email,
      uuid: this.uuid,
      accessToken: this._access,
      refreshToken: this._refresh,
    };
  }

  get signedIn() {
    return Boolean(this._access && this.uuid);
  }

  async loginWithPassword(email, password) {
    const result = await this._post(PATHS.loginByEmail, {
      email,
      password,
      app_version: this._appVersion,
      captcha_code: '',
      over_fourteen_years: true,
    });
    this._storeSession(email, result);
  }

  async requestEmailCode(email) {
    await this._post(PATHS.generateEmailCode, { email, code_type: EMAIL_CODE_LOGIN });
  }

  // The server signs in or, for an unknown email, creates an account. This
  // app must never create accounts, so a new account is signed out again.
  async loginWithEmailCode(email, code) {
    const verification = Number(String(code).trim());
    if (!Number.isInteger(verification)) throw new NarwalCloudError('Enter the code from the email.', 'BAD_CODE');
    const result = await this._post(PATHS.loginByEmailCode, {
      email,
      verification,
      code_type: EMAIL_CODE_LOGIN,
      last_login_system: LAST_LOGIN_SYSTEM,
      last_login_app_version: this._appVersion,
      default_nickname: 'Narwal user',
      over_fourteen_years: true,
    });
    if (result && result.is_new_user) {
      await this._raw('POST', PATHS.logout, { token: result.token }).catch(() => {});
      throw new NarwalCloudError('No Narwal account found for this email. Create one in the Narwal app first.', 'NO_ACCOUNT');
    }
    this._storeSession(email, result);
  }

  // Ends this session on the Narwal server so its tokens stop working.
  async logout() {
    if (!this._access) return;
    await this._raw('POST', PATHS.logout, { token: this._access });
  }

  async listRobots() {
    const result = await this._authed('GET', PATHS.robots);
    const list = (result && result.deviceInfoList) || [];
    return list.map((robot) => ({
      deviceId: robot.deviceId,
      productId: robot.productId,
      name: robot.robotName || 'Narwal',
      firmware: robot.firmwareVersion || null,
    }));
  }

  async brokerUrl() {
    if (!this._broker) {
      const result = await this._authed('GET', PATHS.broker, { params: { country: this.country } });
      if (typeof result !== 'string' || !result.includes('://')) throw new NarwalCloudError('Narwal did not return an MQTT broker.');
      // The access token is the MQTT password, so only encrypted links.
      if (!ENCRYPTED_BROKER.test(result)) throw new NarwalCloudError('Narwal returned an unencrypted MQTT broker; not connecting.');
      this._broker = result;
    }
    return this._broker;
  }

  get accessToken() {
    return this._access;
  }

  // Refreshes once for any number of concurrent callers.
  refresh() {
    if (!this._refreshing) {
      this._refreshing = this._doRefresh().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  async _doRefresh() {
    if (!this._refresh) throw new NarwalCloudError('Sign in to your Narwal account again.', 'SIGN_IN_REQUIRED');
    let result;
    try {
      result = await this._post(PATHS.refresh, { refreshToken: this._refresh });
    } catch (err) {
      throw new NarwalCloudError('Sign in to your Narwal account again.', 'SIGN_IN_REQUIRED');
    }
    this._access = result.token || result.accessToken;
    this._refresh = result.refreshToken || result.refresh_token || this._refresh;
    this._emitTokens();
  }

  _storeSession(email, result) {
    if (!result || !(result.token || result.accessToken)) throw new NarwalCloudError('Narwal did not return a session.');
    this._access = result.token || result.accessToken;
    this._refresh = result.refresh_token || result.refreshToken || null;
    this.uuid = result.uuid || uuidFromToken(this._access);
    this.email = email;
    this._broker = null;
    this._emitTokens();
  }

  _emitTokens() {
    if (typeof this._onTokens === 'function') this._onTokens(this.toJSON());
  }

  async _authed(method, path, { params, body } = {}) {
    if (!this._access) throw new NarwalCloudError('Sign in to your Narwal account first.', 'SIGN_IN_REQUIRED');
    let res = await this._raw(method, path, { params, body, token: this._access });
    if (res.authFailed) {
      await this.refresh();
      res = await this._raw(method, path, { params, body, token: this._access });
    }
    return this._unwrap(res);
  }

  async _post(path, body) {
    return this._unwrap(await this._raw('POST', path, { body }));
  }

  _unwrap(res) {
    if (res.authFailed) throw new NarwalCloudError('Sign in to your Narwal account again.', 'SIGN_IN_REQUIRED');
    const json = res.json || {};
    if (json.code !== 0) throw new NarwalCloudError(json.msg || `Narwal request failed (HTTP ${res.status}).`);
    return json.result;
  }

  async _raw(method, path, { params, body, token } = {}) {
    const url = new URL(this.host + path);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (token) {
      headers['auth-token'] = token;
      headers.authorization = token;
    }
    let response;
    try {
      response = await this._fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new NarwalCloudError(`Could not reach the Narwal cloud: ${err.message}`, 'NETWORK');
    }
    const json = await response.json().catch(() => null);
    const authFailed = response.status === 401 || response.status === 403;
    return { status: response.status, json, authFailed };
  }
}

module.exports = { NarwalCloudAccount, NarwalCloudError, PATHS };

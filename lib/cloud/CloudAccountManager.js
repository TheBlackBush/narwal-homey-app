'use strict';

const { EventEmitter } = require('events');
const { NarwalCloudAccount } = require('./NarwalCloudAccount');
const { NarwalCloudError } = require('./NarwalCloudError');

/**
 * The app's connection mode (Local or Cloud) and its single Narwal account.
 * Stores only the account's token state (never the password) in the app
 * settings store, restores it after a restart, and emits 'changed' with
 * `modeChanged` when the mode, sign-in or sign-out changes.
 */

const SETTINGS_KEY = 'narwal_cloud_account';
const MODE_KEY = 'connection_mode';
const MODES = ['local', 'cloud'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanEmail(email) {
  const value = String(email || '').trim();
  if (!EMAIL_RE.test(value)) throw new NarwalCloudError('Enter the email address of your Narwal account.', 'BAD_INPUT');
  return value;
}

function cleanCountry(country) {
  const value = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) throw new NarwalCloudError('Choose the country of your Narwal account.', 'BAD_INPUT');
  return value;
}

class CloudAccountManager extends EventEmitter {
  constructor({ settings, fetch = globalThis.fetch }) {
    super();
    this._settings = settings;
    this._fetch = fetch;
    this._account = null;
    const stored = settings.get(SETTINGS_KEY);
    if (stored && stored.accessToken) this._account = this._restore(stored);
  }

  _restore(state) {
    const account = NarwalCloudAccount.fromJSON(state, {
      fetch: this._fetch,
      // A refresh that lands after sign-out or a new sign-in belongs to an
      // account that is no longer current; storing it would sign it back in.
      onTokens: (next) => {
        if (this._account === account) this._save(next);
      },
    });
    return account;
  }

  _save(state) {
    this._settings.set(SETTINGS_KEY, state);
  }

  getAccount() {
    return this._account;
  }

  // How every robot in the app connects: 'local' (default) or 'cloud'.
  getMode() {
    const mode = this._settings.get(MODE_KEY);
    return MODES.includes(mode) ? mode : 'local';
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new NarwalCloudError('Choose Local or Cloud.', 'BAD_INPUT');
    if (mode === this.getMode()) return;
    this._settings.set(MODE_KEY, mode);
    this._changed(true);
  }

  _changed(modeChanged) {
    this.emit('changed', { ...this.status(), modeChanged });
  }

  status() {
    const account = this._account;
    return {
      mode: this.getMode(),
      signedIn: Boolean(account && account.signedIn),
      email: account ? account.email : null,
      country: account ? account.country : null,
    };
  }

  async loginWithPassword({ email, password, country }) {
    const cleanMail = cleanEmail(email);
    if (!password) throw new NarwalCloudError('Enter your Narwal password.', 'BAD_INPUT');
    const account = this._newAccount(country);
    await account.loginWithPassword(cleanMail, password);
    this._adopt(account);
  }

  async requestEmailCode({ email, country }) {
    await this._newAccount(country).requestEmailCode(cleanEmail(email));
  }

  async loginWithEmailCode({ email, code, country }) {
    const cleanMail = cleanEmail(email);
    const account = this._newAccount(country);
    await account.loginWithEmailCode(cleanMail, code);
    this._adopt(account);
  }

  logout() {
    this._account = null;
    this._settings.unset(SETTINGS_KEY);
    this._changed(false);
  }

  // A sign-in attempt uses a fresh account object, so a failure leaves the
  // current account untouched.
  _newAccount(country) {
    return new NarwalCloudAccount({ country: cleanCountry(country), fetch: this._fetch });
  }

  _adopt(account) {
    this._save(account.toJSON());
    this._account = this._restore(account.toJSON());
    this._changed(false);
  }
}

module.exports = { CloudAccountManager, SETTINGS_KEY, MODE_KEY };

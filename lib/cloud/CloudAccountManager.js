'use strict';

const { EventEmitter } = require('events');
const { NarwalCloudAccount } = require('./NarwalCloudAccount');
const { NarwalCloudError } = require('./NarwalCloudError');

/**
 * The app's single Narwal account. Stores only the token state (never the
 * password) in the app settings store, restores it after a restart, and
 * emits 'changed' when the user signs in or out.
 */

const SETTINGS_KEY = 'narwal_cloud_account';
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
    return NarwalCloudAccount.fromJSON(state, { fetch: this._fetch, onTokens: (next) => this._save(next) });
  }

  _save(state) {
    this._settings.set(SETTINGS_KEY, state);
  }

  getAccount() {
    return this._account;
  }

  status() {
    const account = this._account;
    return {
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
    this.emit('changed', this.status());
  }

  // A sign-in attempt uses a fresh account object, so a failure leaves the
  // current account untouched.
  _newAccount(country) {
    return new NarwalCloudAccount({ country: cleanCountry(country), fetch: this._fetch });
  }

  _adopt(account) {
    this._save(account.toJSON());
    this._account = this._restore(account.toJSON());
    this.emit('changed', this.status());
  }
}

module.exports = { CloudAccountManager, SETTINGS_KEY };

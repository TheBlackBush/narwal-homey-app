'use strict';

module.exports = {
  async getDevices({ homey }) {
    return homey.app.getDevicesData();
  },

  async getCloud({ homey }) {
    return homey.app.getCloudStatus();
  },

  async setConnectionMode({ homey, body }) {
    return homey.app.setConnectionMode(body || {});
  },

  async cloudLoginPassword({ homey, body }) {
    return homey.app.cloudLoginWithPassword(body || {});
  },

  async cloudRequestCode({ homey, body }) {
    return homey.app.cloudRequestEmailCode(body || {});
  },

  async cloudLoginCode({ homey, body }) {
    return homey.app.cloudLoginWithEmailCode(body || {});
  },

  async cloudLogout({ homey }) {
    return homey.app.cloudLogout();
  },

  async refreshRoomsMap({ homey, query, body }) {
    const payload = body || {};
    const deviceId = payload.deviceId || query.deviceId || query.did || '';
    return homey.app.refreshSettingsRoomsMap(deviceId);
  },
};

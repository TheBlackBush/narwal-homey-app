'use strict';

module.exports = {
  async getDevices({ homey }) {
    return homey.app.getDevicesData();
  },

  async refreshRoomsMap({ homey, query, body }) {
    const payload = body || {};
    const deviceId = payload.deviceId || query.deviceId || query.did || '';
    return homey.app.refreshSettingsRoomsMap(deviceId);
  },
};

'use strict';

module.exports = {
  async getDeviceData({ homey, query }) {
    const deviceId = query.did || query.deviceId || '';
    return homey.app.getWidgetDeviceData(deviceId);
  },

  async getMap({ homey, query }) {
    const deviceId = query.did || query.deviceId || '';
    return homey.app.getWidgetMap(deviceId);
  },

  async getLive({ homey, query }) {
    const deviceId = query.did || query.deviceId || '';
    return homey.app.getWidgetLive(deviceId);
  },

  async refreshMap({ homey, query }) {
    const deviceId = query.did || query.deviceId || '';
    return homey.app.refreshWidgetMap(deviceId);
  },
};

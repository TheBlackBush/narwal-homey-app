'use strict';

/**
 * Decides how a device connects: 'local' (default, the robot's WebSocket on
 * the LAN) or 'cloud' (the user's Narwal account). Returns an error message
 * instead of a connection when the chosen mode cannot work yet.
 */
function chooseConnection({
  mode, account, deviceId, ip, mock = false,
}) {
  if (mock) return { mode: 'local' };
  if (mode !== 'cloud') {
    // Robots added through the cloud have no IP until mDNS has seen them.
    if (!String(ip || '').trim()) {
      return { mode: 'local', error: 'Enter the robot\'s IP address in the device settings, or switch Connection to Cloud in the app settings.' };
    }
    return { mode: 'local' };
  }
  if (!account || !account.signedIn) {
    return { mode: 'cloud', error: 'Sign in to your Narwal account in the app settings, or switch Connection to Local there.' };
  }
  if (!deviceId) {
    return { mode: 'cloud', error: 'This robot has no device ID yet. Remove it and add it again while Connection is set to Cloud in the app settings.' };
  }
  return { mode: 'cloud', cloud: { account } };
}

module.exports = { chooseConnection };

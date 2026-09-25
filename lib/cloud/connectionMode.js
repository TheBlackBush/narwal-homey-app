'use strict';

/**
 * Decides how a device connects: 'local' (default, the robot's WebSocket on
 * the LAN) or 'cloud' (the user's Narwal account). Returns an error message
 * instead of a connection when cloud mode cannot work yet.
 */
function chooseConnection({
  mode, account, deviceId, mock = false,
}) {
  if (mock || mode !== 'cloud') return { mode: 'local' };
  if (!account || !account.signedIn) {
    return { mode: 'cloud', error: 'Sign in to your Narwal account in the app settings, or switch Connection to Local there.' };
  }
  if (!deviceId) {
    return { mode: 'cloud', error: 'This robot has no device ID yet. Remove it and add it again while Connection is set to Cloud in the app settings.' };
  }
  return { mode: 'cloud', cloud: { account } };
}

module.exports = { chooseConnection };

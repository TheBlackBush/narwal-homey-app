'use strict';

/* eslint-disable import/no-extraneous-dependencies, node/no-extraneous-require, no-process-exit */

const App = require('homey/lib/App');
const HomeyAPIV3Local = require('homey-api/lib/HomeyAPI/HomeyAPIV3Local');
const fetch = require('node-fetch');

function cleanEnv(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

async function main() {
  const address = cleanEnv(process.env.HOMEY_ADDRESS);
  const token = process.env.HOMEY_LOCAL_TOKEN || process.env.HOMEY_PAT;

  if (!address) throw new Error('Missing HOMEY_ADDRESS');
  if (!token) throw new Error('Missing HOMEY_LOCAL_TOKEN or HOMEY_PAT');

  const ping = await fetch(`http://${address}/api/manager/webserver/ping`, { timeout: 5000 });
  const id = ping.headers.get('x-homey-id');
  const softwareVersion = ping.headers.get('x-homey-version') || 'unknown';

  if (!id) throw new Error('Could not determine Homey id from local ping');

  const homey = new HomeyAPIV3Local({
    properties: {
      id,
      name: 'Homey',
      model: 'homey_pro_2023',
      softwareVersion,
    },
    baseUrl: `http://${address}`,
    token,
  });
  homey.model = 'homey_pro_2023';

  const app = new App(process.cwd());
  const result = await app.install({
    homey,
    clean: false,
    skipBuild: false,
    debug: false,
  });

  console.log(JSON.stringify({
    appId: result && result.appId,
    homeyId: id,
    homeyVersion: softwareVersion,
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

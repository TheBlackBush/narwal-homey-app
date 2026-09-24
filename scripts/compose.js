'use strict';

/*
 * Minimal local re-implementation of `homey app build`'s compose step. It
 * assembles app.json from the .homeycompose sources and per-driver compose
 * files so the repository carries a valid, self-contained app.json even without
 * the Homey CLI installed. The Homey CLI will regenerate app.json identically
 * when you run `homey app run` / `homey app validate`.
 *
 * Usage: node scripts/compose.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function build() {
  const app = readJSON(path.join(root, '.homeycompose/app.json'));

  // 1. Capabilities.
  const capDir = path.join(root, '.homeycompose/capabilities');
  if (fs.existsSync(capDir)) {
    app.capabilities = app.capabilities || {};
    for (const file of fs.readdirSync(capDir).filter((f) => f.endsWith('.json'))) {
      const id = path.basename(file, '.json');
      app.capabilities[id] = readJSON(path.join(capDir, file));
    }
  }

  // 2. App-level Flow cards.
  app.flow = {};
  const flowDir = path.join(root, '.homeycompose/flow');
  for (const type of ['triggers', 'conditions', 'actions']) {
    const typeDir = path.join(flowDir, type);
    if (!fs.existsSync(typeDir)) continue;
    app.flow[type] = [];
    for (const file of fs.readdirSync(typeDir).filter((f) => f.endsWith('.json')).sort()) {
      const id = path.basename(file, '.json');
      const card = readJSON(path.join(typeDir, file));
      card.id = card.id || id;
      app.flow[type].push(card);
    }
  }

  // 3. Drivers.
  app.drivers = [];
  const driversDir = path.join(root, 'drivers');
  for (const driverId of fs.readdirSync(driversDir).filter((d) => !d.startsWith('.')).sort()) {
    const dir = path.join(driversDir, driverId);
    const composePath = path.join(dir, 'driver.compose.json');
    if (!fs.existsSync(composePath)) continue;

    const driver = readJSON(composePath);
    driver.id = driverId;
    app.drivers.push(driver);
  }

  // 4. Widgets.
  const widgetsDir = path.join(root, 'widgets');
  if (fs.existsSync(widgetsDir)) {
    const widgets = {};
    for (const widgetId of fs.readdirSync(widgetsDir).filter((d) => !d.startsWith('.')).sort()) {
      const dir = path.join(widgetsDir, widgetId);
      const composePath = path.join(dir, 'widget.compose.json');
      if (!fs.existsSync(composePath)) continue;

      const widget = readJSON(composePath);
      widget.id = widget.id || widgetId;
      widgets[widget.id] = widget;
    }
    if (Object.keys(widgets).length > 0) app.widgets = widgets;
  }

  fs.writeFileSync(path.join(root, 'app.json'), `${JSON.stringify(app, null, 2)}\n`);
  console.log('Wrote app.json');
}

build();

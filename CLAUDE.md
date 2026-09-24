# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Local-first Homey SDK v3 app (`com.narwal`, Homey `>=12.4.0`) that controls Narwal robot vacuums over the LAN (WebSocket, default port `9002`). No cloud, telemetry, or external services may be added.

`AGENTS.md` (local, gitignored) holds the full project rules, agent ownership boundaries, current priorities, and testing policy. Read it before non-trivial work. Other local, gitignored references:

- `CODEX.md`: short handoff with the local Homey and robot addresses used for testing (its version number may be stale; `.homeycompose/app.json` is authoritative).
- `docs/architecture.md`: runtime architecture and file responsibilities.
- `docs/deployment.md`: local install, the devkit fallback, versioning, troubleshooting.
- `docs/github.md`: GitHub workflow, releases, branch hygiene.
- `docs/implementation-roadmap.md`, `docs/default-room-selector-plan.md`: feature roadmap and protocol notes. Keep them aligned with what ships.

## Commands

```bash
npm run build          # regenerate app.json from compose sources (scripts/compose.js)
npm run lint           # eslint (athom config)
npm test               # node --test test (broken on Node 22+, see below)
node --test            # run all tests (auto-discovers test/*.test.js)
node --test test/mapparser.test.js                               # single test file
node --test --test-name-pattern="mock robot" test/client.test.js # tests matching a name
npm run validate       # homey app validate --level=publish
npm run release-check  # lint + test + validate
npm run deploy:local   # install to the local Homey (reads HOMEY_ADDRESS and HOMEY_LOCAL_TOKEN/HOMEY_PAT from env)
```

- On Node 22+, `node --test test` treats `test` as a module path and fails, which also breaks `npm test` and `npm run release-check`. Use `node --test` until the script is changed to `node --test` or `node --test test/*.test.js`.
- Run `npm run build` after touching `.homeycompose/**`, `drivers/*/driver.compose.json`, `widgets/*/widget.compose.json`, or app metadata. `app.json` is generated but committed; never hand-edit it.
- Do not deploy with `--skip-build`: widgets need Homey preprocessing to generate `__assets__`.
- Deploying must preserve paired Homey devices. Never clean-install, reset, remove, or recreate devices, and never change the app id, unless explicitly asked.
- Two install routes: `homey app install` with `/projects/.env` sourced (`set -a; . /projects/.env; set +a`) when `homey list` shows a Homey, otherwise `npm run deploy:local` (local devkit fallback). `HOMEY_PAT` is for cloud/CLI use; `HOMEY_LOCAL_TOKEN` is for the local API. Never echo token values.
- After an install, read back from Homey: `com.narwal` is installed and running, and paired devices are still present.

## Architecture

Layers, from Homey down to the wire:

- `app.js`: thin registry of live device instances (`registerNarwalDevice`) plus data methods for the settings page and widget. `api.js` routes Homey Web API calls to those methods.
- `drivers/<model>/`: one folder per supported model. `driver.js` subclasses `NarwalHomeyDriver` and only sets static `MODEL_ID` / `DEFAULT_IP` / `DEFAULT_DEVICE_ID`; `device.js` just re-exports `lib/NarwalHomeyDevice`. Model differences belong in `lib/constants.js`, not in driver folders.
- `lib/NarwalHomeyDriver.js`: pairing (probes the robot), plus Flow card run listeners and room autocomplete. Flow cards are app-level, so registration is guarded by `homey.__narwalFlowRegistered` to run once across all drivers.
- `lib/NarwalHomeyDevice.js`: capabilities, settings, Flow triggers, map caching (SVG stored for the widget/camera image), and the bridge to `NarwalClient` events.
- `lib/NarwalClient.js`: WebSocket lifecycle (connect, wake burst, heartbeat, reconnect backoff, polling), command sending, and response matching. Emits normalized `status`, `connected`, `sleeping`, map/room events.
- `lib/NarwalBinaryProtocol.js`: frame build/parse for the real robots' binary protobuf-like protocol (topics such as `clean/start_clean`, `task/pause`, `map/display_map`). Pure, no Homey.
- `lib/NarwalProtocol.js`: JSON request/reply/event protocol and status normalization. Pure, no Homey.
- `lib/MapParser.js`: room parsing and SVG map rendering.
- `lib/MockSocket.js`: in-process fake robot.

Two protocol paths matter: `NarwalClient` sets `binaryMode = !mock`. Real robots always go through `NarwalBinaryProtocol`; mock mode (`NARWAL_MOCK=1` or the `dev_mock` device setting) goes through the JSON `NarwalProtocol` + `MockSocket`. So `test/client.test.js` exercises the JSON path; binary protocol changes need coverage in `test/binary-protocol.test.js` and, when available, a real-robot check.

The settings page (`settings/index.html`) and the widget (`widgets/vacuum-map`) both read device data through `api.js` into `app.js` (`GET /devices`, rooms/map refresh). Keep the settings page and the widget on the same device methods, and never return secrets or raw payloads through these APIs.

Product rules that are easy to break:

- `dev_mock` stays out of the pairing and settings UI; mock mode is only reachable through `NARWAL_MOCK=1`.
- `Last update` is deliberately not a device capability. It is stored as `last_status_at` for the settings page and widget.
- Keep capabilities useful and low-noise; diagnostics belong in settings or the widget.
- Project docs must not mention external reference repositories.

Compose sources: `.homeycompose/app.json`, `.homeycompose/capabilities/*.json` (custom `narwal_*` capabilities), `.homeycompose/flow/{actions,conditions,triggers}/*.json`, driver and widget compose files. Adding a Flow card means a JSON file there plus a run listener in `NarwalHomeyDriver._registerFlowOnce()`.

Adding a model: add metadata/product key in `lib/constants.js`, copy an existing driver folder, add artwork, build, lint, test, validate.

## Diagnostics

`scripts/probe-narwal-local.js` and `scripts/dump-narwal-data.js` talk to a real robot; dumps land in `diagnostics/` (gitignored). These contain robot IDs, LAN IPs, room names, and raw payloads: keep them out of commits, public docs, and summaries (mask device IDs).

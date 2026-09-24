# Contributing to Narwal for Homey

Thank you for helping improve Narwal for Homey.

This is a local-first Homey SDK v3 app for supported Narwal robot vacuums. The
best contributions are small, testable, and careful with user privacy. Robot
logs, map payloads, local IPs, device IDs, access tokens, and network captures
can contain private information, so please sanitize them before sharing.

## Before opening an issue

Please check the following first:

* Search existing issues for the same problem or request.
* Make sure Homey, the app, and the robot firmware are up to date.
* Confirm Homey and the robot are on the same LAN/VLAN.
* Close the official Narwal app while testing local Homey control.
* Try refreshing rooms/map from the app settings if the issue is room or map
  related.

## Good bug reports

A useful bug report includes:

* Robot model and firmware version.
* Homey model and Homey software version.
* App version.
* What you expected to happen.
* What actually happened.
* Steps to reproduce the issue.
* Relevant sanitized logs.
* Whether the robot was docked, sleeping, cleaning, paused, or returning.
* Whether the official Narwal app was open during the test.

Do not include access tokens, Homey PATs, local tokens, raw private map data,
private room names, Charles captures, or unmasked device identifiers unless a
maintainer explicitly asks for a sanitized excerpt.

## Good feature requests

A useful feature request includes:

* The user problem you want to solve.
* The Homey surface where it should appear: device tile, Advanced settings,
  Flow card, app settings, widget, or pairing.
* The Narwal model you can test with.
* Any known local-protocol data that supports the feature.
* Any safety concerns, such as commands that move the robot or start cleaning.

## Pull request guidelines

Please keep pull requests focused and easy to review:

* Use the existing shared runtime classes where possible.
* Do not duplicate driver logic unless a model truly behaves differently.
* Keep the app local-first; do not add cloud dependencies, telemetry, analytics,
  or external services.
* Do not mention private research sources or third-party project names in
  user-facing files.
* Do not change the app id or paired-device identity format without discussing
  migration impact first.
* Preserve existing paired devices, settings, and stored room data.
* Add or update tests for protocol, map, pairing, Flow, or widget behavior when
  relevant.
* Update README or docs for user-visible behavior changes.

## Development setup

```bash
npm install
npm run build
npm run lint
npm test
npm run validate
```

Run with the mock robot during development:

```bash
NARWAL_MOCK=1 homey app run
```

For local Homey installation, use:

```bash
npm run deploy:local
```

The local deploy command expects Homey credentials in the local environment.
Never commit or print values from `/projects/.env` or any other secret file.

## Homey compose files

This project uses Homey compose sources. If you change any of these, run
`npm run build` so `app.json` is regenerated:

* `.homeycompose/app.json`
* `.homeycompose/capabilities/*.json`
* `.homeycompose/flow/**`
* `drivers/*/driver.compose.json`
* `widgets/*/widget.compose.json`

## Validation checklist

Use the smallest relevant set of checks for your change:

* Docs only: read back the changed markdown.
* JavaScript runtime change: `npm run lint` and relevant tests.
* Protocol or map change: protocol/map tests and, when possible, a safe real
  robot diagnostic.
* Driver, capability, Flow, widget, or asset change: `npm run build`,
  `npm run lint`, and `npm run validate`.
* Deployment change: `npm run release-check` before installing locally.

## Code of conduct

By participating in this project, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

# Narwal for Homey

![Homey](https://img.shields.io/badge/Homey-SDK%20v3-00AEEF?style=for-the-badge)
![App ID](https://img.shields.io/badge/App%20ID-com.narwal.global-683df5?style=for-the-badge)
![Version](https://img.shields.io/badge/Version-1.3.10-683df5?style=for-the-badge)
![Local First](https://img.shields.io/badge/Local--First-Cloud%20optional-2ea44f?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge)

Control your Narwal robot vacuum directly from Homey Pro over your local network: **local by default, no Narwal account needed**. Cloud mode (sign in with your Narwal account in the app settings) is optional. The app talks to supported robots through their local WebSocket API and exposes device controls, live status, Flow cards, room cleaning and a Homey widget.

> Unofficial community app. Not affiliated with, authorised by, or endorsed by Narwal. “Narwal” and “Freo” are trademarks of their respective owners and are used here only to describe compatibility.

## Features

- Local LAN connection to the robot, usually on WebSocket port `9002`.
- Optional Cloud mode: sign in with your Narwal account in the app settings to control the robot through the Narwal cloud, with the same features as Local.
- Separate Homey drivers for each supported model.
- Start, pause, resume and stop cleaning.
- Return to dock and locate the robot.
- Live battery, charging, docked, connected, cleaning area/time, firmware, status and last error.
- Fan-speed control: `Quiet`, `Standard`, `Strong`, `Super Powerful`, `Ultra Powerful` (Freo Z10 Pro / Turbo: up to Super Powerful). A level chosen while docked is used for the next clean.
- Room cleaning with Flow autocomplete. Room names match the Narwal app (custom names in any language, and numbered types such as `Toilet1`, `Toilet2`).
- Cleaning mode settings (mode, water level, mop strength, passes, route) and a Clean with settings Flow card for one-off cleans.
- Flow actions, conditions and triggers for common automation scenarios.
- Narwal Map widget: the robot's map in the Narwal app's room colours, room names, dock, and the robot's live position and cleaning path, in Homey's light and dark theme.
- Resilient reconnect, heartbeat keep-alive and polling fallback.
- Mock robot support for development via `NARWAL_MOCK=1`.

## Supported models

| Homey driver | Status |
| --- | --- |
| Narwal Flow | Supported by local protocol metadata |
| Narwal Flow 2 | Live-tested on local WebSocket |
| Freo Z10 Ultra | Supported by local protocol metadata; needs more live validation |
| Freo Z10 Pro / Turbo | Supported by local protocol metadata; needs live Homey validation |
| Freo X10 Pro | Supported by local protocol metadata; needs more live validation |
| Narwal Freo 20 | Local WebSocket status, map and sensors reported; command validation still welcome |

### Experimental local-protocol compatibility

The app also recognizes additional product keys during discovery so diagnostics
and future drivers can identify newer robots more accurately:

| Model family | Compatibility note |
| --- | --- |
| Freo Z Ultra | Local commands may work, but live broadcasts can be limited |
| Narwal JX | Local WebSocket compatibility reported; not yet exposed as a dedicated Homey driver |

These models should be treated as experimental until they are validated with
real Homey pairing, status, map and command tests.

### Unsupported or unverified models

- Freo X Ultra
- Freo X Plus
- J-series models except local-WebSocket JX-family models
- Older or APK-only product keys that have not been validated on local WebSocket

## Installation from source

```bash
git clone https://github.com/TheBlackBush/narwal-homey-app.git
cd narwal-homey-app
npm install
npm run build
npm run validate
homey app install
```

You need the Homey CLI installed and authenticated for your Homey account.

## Pairing

1. Make sure the robot is powered on and awake.
2. In Homey, go to **Devices → Add device → Narwal**.
3. Choose the exact model: **Narwal Flow**, **Narwal Flow 2**, **Freo Z10 Ultra**, **Freo Z10 Pro / Turbo**, **Freo X10 Pro** or **Narwal Freo 20**.
4. Pick your robot under **Robots found on your network**, or enter its IP address and port (default `9002`) if it is not listed.
5. When entering an IP, press **Continue**. The app validates the local connection and reads robot status.

Robots found on the network follow IP changes automatically; a DHCP reservation is still recommended.

## Flow cards

### Actions

- Start cleaning
- Pause cleaning
- Resume cleaning
- Stop cleaning
- Return to dock
- Locate robot
- Set fan speed
- Clean selected room
- Refresh robot status
- Refresh rooms / map

### Conditions

- Robot is cleaning
- Robot is docked
- Robot is charging
- Battery is above a percentage
- Robot is connected

### Triggers

- Robot started cleaning
- Robot paused
- Robot resumed
- Robot stopped
- Robot returned to dock
- Robot docked
- Robot undocked
- Battery level changed
- Charging state changed
- Cleaning completed
- Connection lost
- Connection restored

## Map, rooms and widget

- The app requests the robot's map when it connects and when the robot starts or stops working, and keeps it up to date from the robot's live map updates while it cleans. The last map is saved on Homey, so cleaning and the widget work right away after a restart.
- Rooms and their names come from the map and are used by the room Flow cards and the default rooms setting.
- The **Narwal Map** widget draws the map with the Narwal app's room colours (neighbouring rooms always differ), thin walls, room names that fit, the dock, and the robot with its heading. While the robot cleans, its position and path update live (pushed about every 2 seconds). The path stays visible after docking until the next clean starts.
- Widget settings: show status, show room names, and the refresh interval.
- If no map is available yet, run a full map-building clean in the official app, then use **Refresh rooms / map** in Homey.

Core vacuum controls do not depend on the map, except starting a whole-home or room clean, which needs the map's room list.

## Troubleshooting

### Pairing cannot reach the robot

- Verify the robot IP address and port.
- Make sure Homey and the robot are on the same LAN/VLAN.
- Wake the robot by opening the official app once, then close it and retry.
- Confirm another client is not holding the only local connection.

### Official app conflicts with Homey

Some robots appear to allow only one local client at a time. Close the official Narwal app while Homey is connected.

### Rooms or map are empty

- Build a map in the official app first.
- Use **Refresh rooms / map** in Homey.
- If the widget still has no map, the current local payload may not contain parsable map data yet.

### Cloud mode is slow to answer

Over the Narwal cloud, the robot's replies take 20 to 30 seconds. The app waits for them, and commands succeed as soon as the robot's status shows the result, usually within a few seconds. If the official Narwal app shows a network error for the robot, Homey cannot reach it through the cloud either; restart the robot or check its internet access.

### Connection keeps dropping

- Use a static IP or DHCP reservation.
- Check Wi-Fi signal near the dock.
- Be aware that firmware updates can change local protocol behavior.

## Privacy

This app talks to your robot on your local network by default. Cloud mode is optional: only when you switch Connection to Cloud and sign in with your Narwal account in the app settings does the app connect to Narwal's servers, and then only to control your own robots. Your password is never stored; only the session from Narwal is kept on your Homey. The app sends no telemetry or analytics to the developer, Narwal or any third party.

## Development

```bash
npm install
npm run build        # regenerate app.json from compose sources
npm run lint         # eslint using Athom/Homey config
npm test             # protocol, map parser and mock-client tests
npm run validate     # Homey publish-level validation
npm run release-check
```

Run with the simulated robot:

```bash
NARWAL_MOCK=1 homey app run
```

Deploy to a local Homey from this workspace when `/projects/.env` contains the required Homey values:

```bash
npm run deploy:local
```

## Project structure

```text
app.js                         App entry point and app/widget API data
api.js                         Homey app API routes
lib/constants.js               Shared model metadata and enums
lib/NarwalBinaryProtocol.js    Binary frame parser/builder
lib/NarwalProtocol.js          Normalized commands/status helpers
lib/NarwalClient.js            Connection lifecycle (local or cloud) and command API
lib/NarwalMapCodec.js          Map and live-map decoding, room names, saved maps
lib/LiveTrail.js               Live cleaning path of the current clean
lib/Discovery.js               mDNS helpers for pairing and IP changes
lib/cloud/                     Narwal account sign-in, cloud MQTT socket, connection mode
lib/NarwalHomeyDriver.js       Pairing, Flow card registration, autocomplete
lib/NarwalHomeyDevice.js       Capability, Flow trigger and client bridge
lib/MapParser.js               Map objects and widget render data
lib/MockSocket.js              Simulated robot for tests/dev mode
drivers/*                      Model-specific Homey drivers and assets
widgets/vacuum-map             Homey map/status widget
settings/index.html            App settings dashboard
.homeycompose/                 Source metadata for app, capabilities and Flow
test/                          Unit tests
```

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md): contribution guidelines.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): community standards.

## Disclaimer

This software is provided “as is”, without warranty of any kind. Use at your own risk.

## License

MIT, see [LICENSE](LICENSE).

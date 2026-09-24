# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.1.6] - 2026-09-25

### Added
- Pairing lists Narwal robots found on your network. Robots of the chosen model can be added with one tap; robots of another model point to the right driver. Manual IP entry is still available.
- Paired robots follow IP address changes automatically when they are visible on the network.

### Changed
- New devices use the robot's own device ID as their Homey identity instead of the IP address.

### Fixed
- A pairing probe that times out no longer risks an uncaught error in the app.

## [1.1.5] - 2026-09-24

### Changed
- The app ID is now `com.narwal.global`, because `com.narwal` is registered to another developer on the Homey App Store. Homey treats this as a new app: robots added under a development build with the old ID need to be added again, and Flows that use them need their Narwal cards selected again.

## [1.1.4] - 2026-09-24

### Fixed
- Robots that finish a task on the dock no longer stay on Returning (seen on the Freo Z10 Ultra). The dock presence signal now counts as docked.
- Partial status messages, such as battery-only updates sent by some firmware, no longer mark a docked robot as undocked.
- A robot that reports it has left the dock is no longer shown as Docked.

## [1.1.3] - 2026-09-24

### Changed
- Docked detection now recognises every off-the-dock signal used across Narwal firmware versions, so robots on older and newer firmware report Docked, Charging and Status consistently.

## [1.1.2] - 2026-09-24

### Fixed
- Status, Docked and Charging now show the robot as cleaning while it cleans. Newer Flow 2 firmware reports a status code the app treated as docked.
- The current room stays visible during a clean instead of going blank.
- Cleaning area no longer shows a leftover 1.8 m² after docking. That value was a dock timer, not area.
- The robot no longer flips between Cleaning and Docked while it drives onto the dock, so Flow triggers fire once.

## [1.1.1] - 2026-09-24

### Changed
- The Cleaning mode settings are now stored on robots paired before 1.1.0. Cleaning behaved the same before, because missing values already fell back to the defaults.

### Known issues
- The Homey mobile app shows "-" instead of the selected value for dropdown settings on the Advanced Settings page, in every app. Open a setting to see its current value.

## [1.1.0] - 2026-09-24

### Added
- Cleaning mode settings in each device's Advanced settings: mode (vacuum and mop, vacuum only, mop only, vacuum then mop), water level, mop strength, passes and route. Start cleaning, Clean default rooms and Clean selected room use them. The defaults match earlier versions, so nothing changes until you edit them.
- Flow card "Clean with settings": clean the whole home, the default rooms or one room with its own mode, suction, water level, mop strength, passes and route for that run only.

## [1.0.15] - 2026-09-24

### Added
- Five suction levels named as in the Narwal app: Quiet, Standard, Strong, Super Powerful and Ultra Powerful. Existing Flows keep working: Normal is now labelled Standard and Max is labelled Super Powerful, with the same suction. The Freo Z10 Pro / Turbo goes up to Super Powerful.

### Changed
- A fan speed chosen while the robot is docked is saved and used for the next clean. Whole-home and room cleans now start with the chosen suction instead of always using Standard.
- Unnamed rooms use the official Narwal room type names on every model. Some unnamed rooms may show a different name; room IDs are unchanged.

### Fixed
- Starting a whole-home clean without map data no longer reports success when the robot does not start. It now asks you to refresh rooms / map.
- A docked robot is no longer woken up on every status poll.

## [1.0.14] - 2026-09-24

### Fixed
- Fan speed now sets the selected suction level. Every level was previously one step too low, and Quiet sent no level at all.
- Live cleaning status and the live map no longer stop updating after about 10 minutes of cleaning. The robot's broadcast subscription is now renewed every 4 minutes.
- Custom per-room cleans, remapping, and cleans on newer Flow 2 firmware now show as cleaning instead of keeping the previous state.
- A robot that finished its task and is back on the dock now shows as docked instead of staying on returning.

## [1.0.13] - 2026-09-01

### Added
- Added dedicated Homey drivers for Freo Z10 Pro / Turbo and Narwal Freo 20.
- Added Homey driver images for Freo Z10 Pro / Turbo and Narwal Freo 20 following the app-store driver image format.
- Added updated Homey app images from the Narwal banner artwork.
- Added the current-room sensor capability for live cleaning status.
- Added `CODE_OF_CONDUCT.md` and `CONTRIBUTING.md`.
- Added README badges and refreshed setup/compatibility documentation.

### Changed
- Improved room cleaning commands to use the active map id and selected room ids.
- Improved whole-home cleaning fallback behavior when map and room data are available.
- Expanded product-key discovery and compatibility metadata for newer Narwal models.
- Pairing now stores the robot-reported product key when it is discovered.
- Corrected Freo 20 and JX compatibility metadata so Freo 20 uses its own product key.
- Updated `.gitignore` for Homey build output, local diagnostics, captures, backups, temporary files, and secrets.

### Fixed
- Fixed a case where default selected rooms could start a broader cleaning plan instead of only the configured rooms.
- Fixed command result handling for robots that report “not ready”.
- Fixed Freo Z10 Pro / Turbo driver artwork to remove the source cable from the product image.

## [1.0.12] - 2026-07-23

### Changed
- Improved the Narwal Map widget so map snapshots are persisted for display after app restarts.
- Improved widget empty and error states when no map is cached, the robot is sleeping, or data is unavailable.
- Regenerated widget preview images.

### Fixed
- Fixed widget packaging and validation issues around the map preview assets.
- Fixed cases where the widget could show no map even when a cached map snapshot existed.

## [1.0.11] - 2026-07-23

### Added
- Added the Narwal Map widget for a compact Homey dashboard map and status view.

### Changed
- Removed the Last update value from the device sensor list while keeping timestamps available internally for app and widget use.
- Improved widget packaging and Homey validation compatibility.

## [1.0.0] - 2026-06-16

### Added
- Local control of Narwal robot vacuums over the LAN WebSocket API (default port `9002`) — no cloud dependency.
- Custom pairing flow: robot IP, model selection and optional port, with live connectivity validation.
- Capabilities: vacuum state, battery, charging, docked, fan speed (Quiet/Normal/Strong/Max), cleaning area, cleaning time, firmware version, connection status, and control buttons.
- Room discovery from the robot map and a "Clean selected room" Flow card with room autocomplete.
- Best-effort map snapshot (rooms, dock, robot position, cleaning trail, obstacles).
- Full Flow card set: 10 actions, 12 triggers, 5 conditions.
- Resilient client: exponential-backoff reconnect, heartbeat keep-alive, and a 60-second polling fallback.
- Development mode with a simulated robot (`NARWAL_MOCK=1` or the pairing checkbox) and a unit-test suite.

### Notes
- Initially supported: Narwal Flow / AX12, Narwal Flow 2, Freo Z10 Ultra, Freo X10 Pro.
- Initially unsupported / unverified: Freo Z Ultra, Freo X Ultra, Freo X Plus, J-series.

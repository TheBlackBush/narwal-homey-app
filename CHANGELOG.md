# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.3.7] - 2026-09-26

### Fixed
- Cloud mode receives the robot's replies, including the map. Requests now carry the reply address in their header and the Narwal app's correlation format; without them the robot did not answer over the cloud.
- Cloud replies take 20 to 30 seconds, so the map request waits up to 60 seconds, and a command succeeds as soon as either its reply or the robot's status confirms it.

 - 2026-09-26

### Added
- The robot's map is saved on Homey and loaded at startup, so cleaning, room cleaning and the widget work before a fresh map arrives, including in Cloud mode. A fresh map is requested in the background until one arrives.
- In Cloud mode, where the robot's replies are often lost, a command counts as done once the robot's status shows it (for example cleaning after Start). Locate counts as sent. A refusal from the robot is still reported.

 - 2026-09-26

### Fixed
- Undoes the 1.3.4 changes (one request at a time over the cloud, the shorter wake-up, and map retries). They did not bring back the robot's replies and made the cloud connection drop about every minute.

## [1.3.4] - 2026-09-26

### Changed
- Cloud mode wakes the robot the way the Narwal app does (keep publishing, device page opened, status) and sends one request at a time, waiting up to 5 seconds for each reply.
- A map request that gets no answer is retried after 1, 2 and then every 5 minutes until a map is loaded.

 - 2026-09-26

### Fixed
- Saved rooms keep their type, floor texture and type number instead of losing them right after the map loads.

### Added
- Diagnostics describe the Narwal sign-in session: the sign-in method, whether the account ID matches the one in the token, the token's field names and age, and the broker's scheme and port. No IDs, tokens or host names.

 - 2026-09-26

### Fixed
- Cloud mode subscribes only to the four status broadcasts it needs. (This did not make request replies arrive over the cloud; that is still being investigated.)

 - 2026-09-26

### Added
- Diagnostics record messages received per topic and the outcome of the last map request.

 - 2026-09-26

### Changed
- Room names match the Narwal app exactly. When several rooms share a type, each gets a number with no space, as in the Narwal app: "Toilet1", "Toilet2", "Toilet3". Flows keep working, because they store room IDs.

### Fixed
- Room names in any language (for example Hebrew) display correctly instead of as a code.
- The map shows walls and rooms the way the Narwal app does, and every map cell is drawn in the right room's colour.
- Room labels sit inside their rooms, also in L-shaped rooms.

### Added
- The map is fetched automatically once the robot connects, and again when it starts or stops working. While it cleans, live map updates are applied as they arrive.

 - 2026-09-26

### Fixed
- Cloud mode works without the Narwal phone app open. Homey now sends the robot the same "keep publishing" request as the Narwal app, and renews it every 30 seconds; before, a docked robot only answered over the cloud while the phone app was open.

 - 2026-09-26

### Fixed
- Cloud mode connects to docked robots again. A docked robot takes about 40 seconds to answer a new cloud connection; the app gave up after 45 seconds and started over, so it often never connected. It now waits up to 3 minutes for the first answer.

 - 2026-09-26

### Added
- Cloud diagnostics also record refused messages, the broker's reason for closing the connection, and messages on unexpected topics (with IDs masked).

 - 2026-09-26

### Fixed
- A robot counts as connected only once it answers. A cloud connection that stays silent no longer flips between connected and disconnected every minute, or fires "Connection lost" each time.
- After reconnecting, the status no longer stays on "Disconnected".

### Added
- Connection diagnostics in the app's device data (messages received, cloud subscriptions, and whether the robot is on the Narwal account), without any IDs.

 - 2026-09-26

### Fixed
- "Refresh status" and the fallback poll wait for the robot's answer instead of returning the last known status.
- Replies the app does not wait for no longer pile up in memory, stopping the connection ends pending map requests at once, and truncated robot frames are rejected instead of being read short.
- The cloud connection only uses an encrypted broker address.
- The map widget scales the map to its size instead of clipping it, redraws on resize without asking the robot again, and clears "Map refreshed." after a few seconds.
- App settings: the rooms message no longer stays on "Refreshing…", the Local/Cloud switch waits for each change to save, and a removed robot is no longer shown as selected.
- Pairing: if the app cannot tell whether Local or Cloud is chosen, the screen says so and offers Try again instead of assuming Local.
- Room colours in the map are limited to plain colour values.

### Changed
- Sign-in fields submit with Enter, and form fields have proper labels.

 - 2026-09-26

### Changed
- Narwal account sign-in asks you to confirm you are 14 or older before anything is sent, since Narwal's sign-in states this on your behalf.
- The email-code option warns that signing in with a code for an address without a Narwal account makes Narwal create one.

 - 2026-09-26

### Fixed
- Flow triggers such as "Started cleaning" no longer fire twice when status updates arrive together.
- A map update without rooms no longer clears the saved room list.
- A room and map refresh handles the new map once, and the camera image is created once.
- Cloud mode now notices when the robot goes offline instead of showing it as connected, and a cloud subscription that is refused or never confirmed makes the app reconnect instead of hanging.
- A robot added through the cloud without a local IP now asks for the IP in Local mode instead of retrying a blank address.

### Changed
- Signing out of the Narwal account also ends the session on Narwal's server.
- Mock mode can no longer be switched on from the pairing screen.
- The app description and privacy text now describe the optional cloud mode.

 - 2026-09-26

### Fixed
- The app no longer crashes when a robot's connection is restarted while it is still connecting (IP change, settings change, Local/Cloud switch, app shutdown).
- "Connection lost" fires once per outage instead of on every reconnect attempt, and a robot that accepts and drops the connection no longer causes a reconnect loop every few seconds.
- Robot commands only accept the robot's answer to that command, so Pause, Locate and Start no longer report success from an unrelated reply.
- Signing out of the Narwal account can no longer be undone by a token refresh that was still running.
- The app package now contains only the files the app needs.

 - 2026-09-26

### Changed
- Local or Cloud is now one switch for the whole app on the app settings page, instead of a setting per robot. Robot settings are back to IP address and port only.

### Added
- In Cloud mode the pairing screen lists the robots on your Narwal account: add the one you want, see which ones are already added, and which belong under another model. In Local mode pairing works as before (search the network or enter the IP address).

## [1.2.0] - 2026-09-26

### Added
- Optional Narwal account sign-in on the app settings page, with an emailed code or a password. Only the session is stored, never the password.
- A Connection setting per robot: Local network (default) or Narwal cloud. In cloud mode the robot is controlled through your Narwal account, for example when it is not reachable on the local network.

## [1.1.10] - 2026-09-25

### Fixed
- Adding a robot from the found-robots list now follows the same steps as entering its IP address and pressing Continue, including Homey's room selection afterwards.

## [1.1.9] - 2026-09-25

### Fixed
- The robot search on the pairing screen starts again. It waited for a Homey event that pairing screens never receive, so it stayed on "Searching…" and Continue could not connect.
- The IP address field keeps its text and cursor inside the field.

### Changed
- Searching shows an animated indicator, and the section disappears after 5 seconds when no robot is found.

## [1.1.8] - 2026-09-25

### Changed
- Restored the original pairing screen design (header, card and styling). The layout fixes are kept: the Continue button stays in the page flow below the fields, so it no longer covers them while typing, and the tips sit below the button.

## [1.1.7] - 2026-09-25

### Changed
- Redesigned the pairing screen with Homey's own styles. The Connect button no longer covers the fields when the keyboard is open.
- Robots found on the network are listed right away and checked one by one, so the list no longer waits on a sleeping robot. A robot that does not answer can be retried, and the search can be run again.

### Fixed
- The robot search now starts once Homey's pairing session is ready, so it no longer stays on "Searching…".
- Entering an IP address of a robot that does not answer now shows an error instead of adding the robot without its device ID.

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
- Local control of Narwal robot vacuums over the LAN WebSocket API (default port `9002`), with no cloud dependency.
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

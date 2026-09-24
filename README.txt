Control your Narwal robot vacuum directly from Homey Pro over your local network. No Narwal cloud login, no internet round-trips, no external servers — the app talks to supported robots through their local WebSocket API.

Features:
- Add your exact model as a separate Homey device type: Narwal Flow, Narwal Flow 2, Freo Z10 Ultra, Freo Z10 Pro / Turbo, Freo X10 Pro or Narwal Freo 20.
- Start, pause, resume and stop cleaning.
- Return to dock and locate the robot.
- Live status for battery, charging, docked, connected, cleaning area, cleaning time, firmware and last error.
- Fan-speed control: Quiet, Standard, Strong, Super Powerful and Ultra Powerful.
- Flow cards for actions, conditions and triggers, including cleaning lifecycle, docking, battery and connection events.
- Room cleaning support when the robot exposes room data locally.
- Narwal Map widget for a best-effort local map snapshot and compact robot status.
- Resilient local connection with reconnect, heartbeat keep-alive and polling fallback.

Supported models:
- Narwal Flow / AX12
- Narwal Flow 2 (live-tested)
- Freo Z10 Ultra
- Freo Z10 Pro / Turbo
- Freo X10 Pro
- Narwal Freo 20

Experimental compatibility:
- Freo Z Ultra: local commands may work, but live broadcasts can be limited.
- Narwal JX: local WebSocket compatibility reported, but no dedicated Homey driver yet.

Not supported / unverified:
Some models appear to be cloud-only or use a different protocol, including Freo X Ultra, Freo X Plus, older J-series models outside the local-WebSocket JX family and APK-only product keys that have not been validated on local WebSocket.

Setup tips:
- Assign the robot a static IP address or DHCP reservation.
- Close the official Narwal app while Homey is connected; some robots allow only one local connection at a time.
- If pairing fails, wake the robot by opening the official app once, then close it and try again.
- If rooms or map are empty, run a full map-building clean in the official app first, then use the Homey “Refresh rooms / map” action.

Privacy:
This app communicates only with your robot on your local network. It does not use Narwal cloud services, does not require a Narwal account and does not transmit data to Narwal, the developer or any third party.

Unofficial community app. Not affiliated with, authorised by or endorsed by Narwal.

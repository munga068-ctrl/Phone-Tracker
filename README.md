# Phone Tracker

A simple, self-hosted "find my phone" tool: `track.html` runs on the phone you want to be able to find, `index.html` is the viewer/map.

## ⚠️ Required setup: lock down your Firebase database

The Firebase console's default "test mode" makes your **entire** database publicly readable and writable — anyone who finds your `databaseURL` (visible in `firebase-config.js`, which is public in this repo) could read or overwrite every device's location, not just guess one ID.

**Do this now:**

1. Go to the [Firebase console](https://console.firebase.google.com) → your project → Realtime Database → **Rules** tab.
2. Replace whatever is there with the contents of [`firebase-rules.json`](./firebase-rules.json) in this repo.
3. Click **Publish**.

What these rules do:
- Block reading or listing the whole `/devices` node — only a specific, known device ID can be read.
- Require any device ID to be at least 6 characters (matches the client-side validation in `tracker.js`).
- Validate that writes contain the expected shape (`lat`, `lng`, `accuracy`, `timestamp` as numbers) so garbage/malicious writes are rejected.

This does **not** make individual device IDs unguessable by brute force — treat your Device ID like a password. Longer and more random is better than something like `phone1`.

## Known limitations

- **No real IMEI support.** No browser exposes a phone's hardware IMEI to a webpage — this is an OS-level privacy restriction on both iOS and Android, not something fixable in this app's code. The random/private Device ID is the intended design (a shared secret), not a placeholder for a "real" identifier.
- **Won't track a phone with the screen off or the tab backgrounded.** Mobile browsers suspend JavaScript almost immediately once a tab isn't visible or the screen locks — there's no web API for reliable background location tracking. `tracker.js` requests a screen Wake Lock to help while the tab is in the foreground, but this is a partial mitigation, not a fix — a lost or stolen phone with its screen off won't be tracked by this tool.
- **Battery % may not show.** `navigator.getBattery()` is deprecated and unsupported on iOS Safari and most current desktop/mobile browsers; it'll just show nothing for those users.

## Files

- `track.html` / `tracker.js` — run on the phone being tracked. Sanitizes the Device ID, throttles writes to at most once per 8s, sends a heartbeat write every 30s so "last seen" doesn't go stale during a stationary GPS lull, and requests a Wake Lock while active.
- `index.html` / `viewer.js` — the map/dashboard. Flags a device as stale (⚠️) if it hasn't reported in 5+ minutes.
- `firebase-config.js` — your Firebase project config (the API key here is not a secret by itself — Firebase's security model relies on the *rules*, not on hiding this value).
- `firebase-rules.json` — paste into the Firebase console as described above.
- `style.css` — shared styling for both pages.

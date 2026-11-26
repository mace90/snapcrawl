# Changelog

## 0.2.0 · 2026-11-26

### Real iPhone over USB
- New driver `ios-device`: finds iPhones with `devicectl`, drives them through WebDriverAgent (tap, type, app state, screenshots, permission alerts), with fallbacks for older WDA endpoints and a clear message when WDA is not reachable or lost control after the iPhone was locked.
- `snapcrawl wda setup | start | stop | status`: builds the newest WebDriverAgent release with your team, starts it on the iPhone and forwards port 8100 through usbmuxd (built in, no iproxy needed).
- `--device` for `crawl` and `apps`, `devices` lists simulators and USB iPhones, `doctor` checks devicectl, Developer Mode, usbmuxd and WDA. The web UI shows USB iPhones and how to start WDA.
- Diffs mask the measured status bar at the screenshot's pixel scale.

### Real-world apps
- `--prepare` (UI: *Prepare app manually before crawl*): pause after launch; the screen you leave the app on becomes the root.
- Onboarding sheets and hints are dismissed (`crawl.dismiss`); cookie and privacy decisions are never made automatically.
- Permission prompts are denied by default (`crawl.systemAlerts`: dismiss, accept, pause).
- Links in web content are skipped; a tap that opens Safari or another app is logged as *left app*, the app is brought back.
- Screen identity by signature similarity (`crawl.matchThreshold`, 0.8): rotating ads, headlines, prices and web content no longer create new screens or break replays. Different navigation bar titles stay different screens.
- Replays check every step, dismiss interruptions, resume from the deepest known screen and restart once before giving up; matches are logged.
- Onboarding shown only once is marked *one-time*; the screen the app opens on afterwards becomes the launch screen. Diffs show missing one-time screens as *one-time (skipped)*, not as unreachable.
- Better screen names: navigation bar title, selected tab, large text, then the action; duplicates are numbered.

### Baselines, review and reports
- One baseline per app, run history in the UI, app names.
- Standalone HTML reports (`snapcrawl report`, `--full`; Export in the UI) with result passed / failed / in review.
- `snapcrawl review` to approve or reject changes from the terminal; `diff`, `review` and `report` compare the newest run after the baseline by default.

## 0.1.0

- First release: crawler for the iOS Simulator (idb), login with TOTP, manual or prompted 2FA, blocklist, crash detection.
- Pixel diff between runs (same, changed, new, broken), local web UI with live crawl, screen graph and review, optional model notes, demo data.

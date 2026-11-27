# Changelog

## 0.3.0 · 2026-11-26

### New name: snappcrawl
- The project was called **snapcrawl** before. Command, package, data folder (`.snappcrawl/`), config file (`snappcrawl.config.json`), home folder (`~/.snappcrawl/`, including WebDriverAgent), environment variables (`SNAPPCRAWL_*`), report file names and the suggested WebDriverAgent bundle id use the new name. Repository: https://github.com/mace90/snappcrawl
- Moving over: the old `.snapcrawl/`, `snapcrawl.config.json`, `~/.snapcrawl/` and `SNAPCRAWL_*` are still read while the new ones do not exist, with a one-time hint. `snappcrawl migrate` moves data and config, renames `env:` references and adds `.snappcrawl/` to `.gitignore`. Reinstall with `npm i -g github:mace90/snappcrawl` (and `npm uninstall -g snapcrawl`).

### Everything in the web UI, everything in the CLI
- `snappcrawl` without arguments checks the setup and opens the web UI.
- Web UI: device list with Refresh and boot by click; iPhone status (connected, trust, locked, Developer Mode, WebDriverAgent set up / running / in control); WebDriverAgent setup with the team id filled in and live progress, start, stop; a crawl on an iPhone starts WebDriverAgent itself; problems on the iPhone appear as hints with the action to take.
- Setup per run: permission prompts, dismiss labels, blocklist, prepare. Runs can be deleted (confirmed in the page). New Settings tab: AI provider, model and API key (stored in `~/.snappcrawl/config.json`, mode 600, shown masked) and the system checklist.
- New commands: `setup`, `boot <simulator>`, `runs rm <run>`, `notes`; crawl options `--minutes --alerts --dismiss --block`. UI and CLI call the same functions (`src/control.js`, `src/doctor.js`); `src/actions.js` lists every action with its UI place, command and route, checked by a test.

### Terminal
- Start banner (ANSI Shadow wordmark with the logo), compact line under 100 columns, none without a terminal, with `NO_COLOR` or in CI; truecolor, 256 or 16 colours.
- Setup checklist with a spinner per line, grouped into system, devices, iphone and optional, with the exact fix next to anything missing.
- `snappcrawl setup` walks through every missing piece: explains it, runs the fix after a yes, shows sudo commands for you to run, describes iPhone and Xcode steps.
- Crawl progress as an estimate, in the CLI status line and the Run tab: percent and time left, from the taps tried against the taps found so far and bounded by the screen and time limits (it adjusts as new screens appear).
- Headings with a thin rule, aligned tables, a live status line (progress, time left, screens, transitions, taps, time) during a crawl, errors as a short block with cause and fix; stack traces only with `--debug`.

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

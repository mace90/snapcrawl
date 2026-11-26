# snapcrawl

**Crawl your iOS app, map every screen as a graph, and catch visual regressions between builds.**

snapcrawl drives the iOS Simulator, taps through your app on its own, saves a screenshot of every screen it reaches and draws the result as a graph: screens are nodes, taps are edges. Crawl the next build and snapcrawl compares the two runs pixel by pixel: what changed, what is new, what crashed and what can no longer be reached.

```
$ snapcrawl crawl --bundle com.acme.app --label v2.4.0 --diff

00:01.2  INFO   device iPhone 16 · iOS 18.2
00:04.0  AUTH   login form detected · filling credentials
00:06.3  AUTH   2fa · totp code generated
00:07.9  INFO   screen.new s001 "Home" · 31 elements · 6 actions · depth 1
00:21.5  WARN   action.skip "Log out" (blocklist)
00:34.8  ERROR  app.crash after tap "Pro" on s001
03:41.0  DONE   crawl.done 13 screens · 15 transitions · 1 crashes

■ diff  v2.3.0 → v2.4.0
  same      6
  changed   5
  new       1
  broken    2
```

- **No test scripts.** The crawler finds screens itself through the accessibility tree.
- **Logins handled.** Username and password, TOTP codes generated automatically, SMS or e-mail codes typed in when asked, or log in by hand and let it continue.
- **Review as a graph.** `snapcrawl ui` opens a local web app: live crawl, screen graph, side-by-side and pixel diff, approve or reject each change.
- **Optional model notes.** Bring your own Anthropic, OpenAI or Ollama model to describe changes. The pixel diff decides; the model only comments.

---

## Requirements

| | Version | Why |
|---|---|---|
| macOS | 14 or newer | the iOS Simulator only runs on macOS |
| Xcode | 16 or newer, with an iOS Simulator runtime | `xcrun simctl` boots simulators and takes screenshots |
| Node.js | 20 or newer | runs snapcrawl |
| idb | latest | reads the accessibility tree and taps ([facebook/idb](https://github.com/facebook/idb)) |
| Python 3 + pipx | any recent | installs the idb client |

Install the tools once:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
brew tap facebook/fb
brew trust facebook/fb            # newer Homebrew asks you to trust third-party taps
brew install idb-companion        # idb server
brew install pipx && pipx ensurepath
pipx install fb-idb               # idb client (open a new terminal afterwards)
```

## Install

```bash
npm install -g github:mace90/snapcrawl
snapcrawl doctor
```

`snapcrawl doctor` checks every requirement and prints the fix for anything missing.

Or from a clone:

```bash
git clone https://github.com/mace90/snapcrawl && cd snapcrawl
npm install && npm link
```

## Try it without a simulator

```bash
snapcrawl demo     # writes two sample runs of a fictional app to ./.snapcrawl
snapcrawl ui       # opens http://localhost:4747
```

## Quick start

```bash
snapcrawl devices                                       # pick a simulator name from this list
xcrun simctl boot "iPhone 17"
open "$(xcode-select -p)/Applications/Simulator.app"    # optional: watch it tap
# install your build: Run in Xcode on that simulator, or xcrun simctl install booted MyApp.app

cd my-app-repo
snapcrawl init                     # writes snapcrawl.config.json
snapcrawl apps                     # find your bundle id
snapcrawl crawl --bundle com.acme.app --label v2.3.0    # first run of an app becomes its baseline

# … install the next build …
snapcrawl crawl --bundle com.acme.app --label v2.4.0 --diff
snapcrawl ui
```

## Real iPhone over USB

snapcrawl can crawl a real iPhone instead of the simulator. It talks to the phone through [WebDriverAgent](https://github.com/appium/WebDriverAgent) (WDA), a small test runner from the Appium project that snapcrawl builds and installs for you.

### Prerequisites (once)

1. **Apple ID in Xcode.** Xcode → Settings → Accounts → **+** → Apple ID. A free Apple ID works; a paid developer account avoids the 7-day limit below.
2. **Connect and trust.** Plug the iPhone in by USB, unlock it and tap **Trust** on "Trust This Computer?".
3. **Developer Mode.** On the iPhone: Settings → Privacy & Security → **Developer Mode** → on, restart, confirm. (The switch only appears after the iPhone was connected to Xcode once; open Xcode → Window → Devices and Simulators if it is missing.)
4. **Your team id** (10 characters, e.g. `AB12CD34EF`): Xcode → Settings → Accounts → your Apple ID → team, or developer.apple.com/account → Membership details. `snapcrawl wda setup` without `--team` reads it from your signing certificate when there is only one.

### Run it

```bash
snapcrawl doctor                                 # checks devicectl, the iPhone, Developer Mode, WDA
snapcrawl devices                                # simulators and USB iPhones (type column)

snapcrawl wda setup --team AB12CD34EF            # download + build WDA (once, ~2 min)
snapcrawl wda start                              # install, launch, forward port 8100
snapcrawl apps --device "Lena's iPhone"          # bundle ids on the phone
snapcrawl crawl --device "Lena's iPhone" --bundle com.acme.app --label v2.4.0
snapcrawl wda stop                               # when you are done
```

The first `wda start` with a **free Apple ID** stops with "Untrusted Developer". On the iPhone open Settings → General → **VPN & Device Management** → your Apple ID → **Trust**, then run `snapcrawl wda start` again.

To make the iPhone the default, set `"device": { "platform": "ios-device", "udid": "Lena's iPhone" }` in `snapcrawl.config.json`. `--udid` always means a simulator, `--device` a real iPhone. In the web UI, USB iPhones appear in the device list marked `usb`; if WDA is not running the UI shows the command to start it.

How it fits together: `devicectl` (part of Xcode) finds the iPhone and lists its apps. `wda setup` clones the newest WDA release to `~/.snapcrawl/wda`, gives it your team and a unique bundle id (`com.<you>.snapcrawl.<team>.WebDriverAgentRunner`, change it with `--bundle-id`) and runs `xcodebuild build-for-testing`. `wda start` runs `xcodebuild test-without-building` in the background and forwards `127.0.0.1:8100` to port 8100 on the phone through usbmuxd, the same mechanism `iproxy` uses, built in, so libimobiledevice is not needed. Process ids go to `~/.snapcrawl/wda/pids`, logs to `~/.snapcrawl/wda/*.log`. Another WDA address can be set with `device.wdaUrl`.

Screenshots from real devices are in device pixels (2x or 3x); the status bar height is measured through WDA and masked in diffs at the right pixel size.

### Troubleshooting the iPhone

- **`No iPhone connected`**: unlock the phone, tap Trust, try another cable or port. `xcrun devicectl list devices` should list it.
- **`Developer Mode disabled`**: see prerequisite 3.
- **`Untrusted Developer` / `invalid code signature`**: Settings → General → VPN & Device Management → Trust (free Apple IDs, after every new setup).
- **Stops working after a week**: provisioning profiles of free Apple IDs expire after **7 days**. Run `snapcrawl wda setup` again.
- **`Failed to register bundle identifier`**: the id is taken. `snapcrawl wda setup --team … --bundle-id com.<you>.<anything>.WebDriverAgentRunner`.
- **`maximum number of apps`**: free Apple IDs may register only a few app ids per week; keep the bundle id that is already in `~/.snapcrawl/wda/setup.json`.
- **`WebDriverAgent not reachable at http://127.0.0.1:8100`**: `snapcrawl wda status`, then `snapcrawl wda start`. Keep the iPhone unlocked while WDA starts and while it crawls; auto-lock interrupts the session (Settings → Display & Brightness → Auto-Lock → Never helps).
- **Xcode is "preparing" the iPhone**: the first connection copies debug symbols; wait until Xcode → Window → Devices and Simulators is done.
- The full xcodebuild output is in `~/.snapcrawl/wda/build.log` (setup) and `~/.snapcrawl/wda/xcodebuild.log` (start).

## Using the web UI

`snapcrawl ui` opens the same workflow in the browser:

1. **Setup** – pick a simulator and an app, add a login if needed, start. The footer tells you whether this run becomes the app's baseline or is compared with it.
2. **Run** – the graph grows live, with the latest screenshot and the log. When the crawl needs a 2FA code or a manual login it pauses here. Afterwards every previous run is listed per app and can be opened.
3. **Compare** – the newest run of an app against its baseline. Filter by status, open a screen to see base, head and pixel diff, approve or reject, or make the new run the baseline.

Every app has its own baseline, so runs of different apps are never compared with each other.

When every change is decided, the inspector shows **All changes reviewed** with both export buttons. **Export** in the Compare header works at any time.

## CLI workflow

Everything the web UI does also works in the terminal, e.g. in CI or over SSH:

| In the UI | In the terminal |
|---|---|
| Setup → **Start crawl** (the first run of an app is its baseline) | `snapcrawl crawl --bundle com.acme.app --label v1` |
| Test run after a new build | `snapcrawl crawl --bundle com.acme.app --label v2 --diff` |
| **Compare** | `snapcrawl diff` |
| **Approve** / **Reject** / **Undo** | `snapcrawl review <screen-id\|all> <approve\|reject\|undo>` |
| **Make head the baseline** | `snapcrawl baseline <run>` |
| Run → list of runs | `snapcrawl runs` |
| **Export** → Summary / Full report | `snapcrawl report` / `snapcrawl report --full` |

Without arguments, `diff`, `review` and `report` (and the Compare tab) take the app of the newest run and compare its baseline with the newest run of that app created after the baseline. If nothing is newer than the baseline, they stop with `<App>: nothing newer than the baseline <label>` instead of comparing an older run. Pass `[base] [head]` run ids to compare any two runs, in either direction. Decisions are stored in the diff's `report.json`, so the UI and the CLI see the same review.

A complete pass, from the baseline to the report:

```bash
# build 1 · becomes the baseline of com.acme.app
snapcrawl crawl --bundle com.acme.app --label v2.3.0

# … install build 2 …
snapcrawl crawl --bundle com.acme.app --label v2.4.0 --diff

snapcrawl review                       # changes and their decisions
snapcrawl review s002 approve          # one screen
snapcrawl review x007 reject           # the crash is a bug
snapcrawl review all approve           # everything still open
snapcrawl review x007 undo             # take a decision back

snapcrawl report                       # .snapcrawl/reports/snapcrawl-acme-v2.4.0-summary.html
snapcrawl report --full --out build/snapcrawl.html

snapcrawl baseline 20261126-091500-v2.4.0   # optional: v2.4.0 is the new reference
```

`review all approve` and `review all reject` only touch screens that are still open; earlier decisions stay. `review all undo` clears every decision.

## Reports

`snapcrawl report` (or **Export** in the UI) writes one self-contained HTML file: no external fonts, scripts or images, so it opens offline, can be attached to a ticket or kept as a CI artifact, and prints on a light background.

| | `summary` (default) | `full` (`--full`) |
|---|---|---|
| App, runs, device, result, counters | ✓ | ✓ |
| Table of all screens: path, status, pixel Δ, decision, note | ✓ | ✓ |
| Screen graph with thumbnails (drag to pan, scroll to zoom, click to jump) | | ✓ |
| Base, head with changed regions, and pixel diff for every change | | ✓ |
| Thumbnails of unchanged screens | | ✓ |
| Typical size | ~15 KB | a few hundred KB to a few MB (images downscaled to 390 px) |

The result at the top:

| Result | When |
|---|---|
| **passed** | every change was reviewed and nothing was rejected (broken screens count only once approved) |
| **failed** | at least one change was rejected, e.g. a crash or an unreachable screen that is not accepted |
| **in review** | nothing rejected yet, but changes are still open |

Unchanged screens always count as passed.

## Logins and two-factor authentication

When the crawler sees a password field it logs in. Credentials come from environment variables or the config file, never from the repo:

```bash
export SNAPCRAWL_USERNAME="qa@acme.com"
export SNAPCRAWL_PASSWORD="…"
export SNAPCRAWL_TOTP_SECRET="JBSWY3DPEHPK3PXP"   # only for mfa: totp
```

| `auth.mfa` | What happens |
|---|---|
| `none` | username and password only |
| `totp` | snapcrawl generates the 6-digit code from the TOTP secret (same as Google Authenticator / 1Password) |
| `prompt` | the crawl pauses and asks for the code, in the terminal or in the web UI |
| `manual` | the crawl pauses; you log in on the simulator yourself and press continue |

With `fallbackManual: true` (default), a failed automatic login also pauses for a manual one. After login the session is kept for the rest of the run.

> **Use test accounts, never production accounts.** The crawler taps everything it is allowed to tap.

## Real-world apps: banners, onboarding and alerts

Real apps rarely open straight on their start screen. snapcrawl handles the usual suspects:

| What appears | What snapcrawl does | Setting |
|---|---|---|
| Onboarding sheets, "What's new", hints | Taps a dismiss button (exact label: *Alles klar, OK, Später, Nicht jetzt, Schließen, Überspringen, Got it, Not now, Maybe later, Close, Skip, …*) at start and whenever a relaunch or replay lands on an unexpected screen; up to 3 times, logged as `dismiss "…"` | `crawl.dismiss` (list of labels) |
| Cookie and privacy banners | **Never decided automatically.** With `--prepare` you decide yourself; otherwise the screen is skipped with a warning (a banner on the start screen ends the crawl there) | `--prepare` |
| Permission prompts (notifications, location, tracking, photos) | Answered with *Don't Allow* / *Ask App Not to Track* by default, through WebDriverAgent's alert API on iPhones and through the accessibility tree on the simulator | `crawl.systemAlerts`: `dismiss` · `accept` · `pause` |
| Links in web content | Not tapped (`action.skip "…" (web link)`), they usually open Safari | `crawl.webLinks`: `skip` · `tap` |
| A tap that brings Safari or another app to the front | Logged as `left app`, the app is brought back, nothing is registered (no crash node) | |
| A replay that lands on the wrong screen | Dismiss first, then one complete restart and replay; only then the screen is skipped with a warning | `crawl.matchThreshold` |
| Onboarding shown only on the first launch | When the app opens twice in a row on another known screen, that screen becomes the **launch screen**; the screens before it are marked *one-time* (dashed in the graph), not a warning. Paths are stored relative to the launch screen. In a diff, one-time screens are compared only when both runs have them, otherwise they show as *one-time (skipped)* | |

**`--prepare`** (in the UI: *Prepare app manually before crawl*) launches the app and pauses: *Bring the app to the screen where the crawl should start, then continue.* Use it to make the cookie decision, finish onboarding or log in by hand. The screen you leave the app on becomes the root of the graph. If a later restart does not show that screen again, snapcrawl dismisses what is in the way; if a privacy banner comes back, it pauses again.

```bash
snapcrawl crawl --device "Lena's iPhone" --bundle com.acme.app --prepare
```

Warnings collected during a run are stored in `atlas.json` (`meta.warnings`).

## Safety: the blocklist

Elements whose label contains a blocklisted word are never tapped. Defaults: `log out`, `sign out`, `delete account`, `buy`, `purchase`, `pay now`, plus German equivalents. Extend it per app in `crawl.blocklist`. Skipped actions are logged as `action.skip`.

## Configuration

`snapcrawl.config.json` in your project (created by `snapcrawl init`). Values of the form `env:NAME` are read from the environment.

```json
{
  "app": { "bundleId": "com.acme.app" },
  "device": { "platform": "ios-sim", "udid": "booted" },
  "auth": {
    "username": "env:SNAPCRAWL_USERNAME",
    "password": "env:SNAPCRAWL_PASSWORD",
    "mfa": "totp",
    "totpSecret": "env:SNAPCRAWL_TOTP_SECRET",
    "fallbackManual": true
  },
  "crawl": { "maxDepth": 8, "maxScreens": 200, "timeLimitMin": 20, "blocklist": ["log out", "delete account", "buy"], "systemAlerts": "dismiss" },
  "diff": { "threshold": 0.1, "minChangedRatio": 0.0005, "ignoreStatusBar": true }
}
```

| Key | Default | Meaning |
|---|---|---|
| `device.platform` | `ios-sim` | `ios-sim` (simulator) or `ios-device` (iPhone over USB) |
| `device.udid` | `booted` | simulator or iPhone, by udid or name |
| `device.wdaUrl` | `http://127.0.0.1:8100` | WebDriverAgent address for `ios-device` |
| `crawl.maxDepth` | `8` | taps away from the first screen |
| `crawl.maxScreens` | `200` | stop after this many screens |
| `crawl.timeLimitMin` | `20` | stop after this many minutes |
| `crawl.settleMs` | `900` | wait after each tap before reading the screen |
| `crawl.matchThreshold` | `0.8` | similarity (0–1) from which two views count as the same screen |
| `crawl.prepare` | `false` | pause after launch for manual preparation (`--prepare`) |
| `crawl.dismiss` | DE + EN list | button labels that close onboarding sheets and hints |
| `crawl.systemAlerts` | `dismiss` | permission prompts: `dismiss`, `accept` or `pause` |
| `crawl.webLinks` | `skip` | links in web content: `skip` or `tap` |
| `diff.threshold` | `0.1` | per-pixel colour tolerance (0–1) |
| `diff.minChangedRatio` | `0.0005` | share of changed pixels below which a screen counts as unchanged |
| `diff.ignoreStatusBar` | `true` | masks the clock and battery area |

## Model notes (optional)

The comparison is deterministic and needs no model. If you want a one-line description and a suggested verdict (intended / bug) for each change, connect a model with your own key:

```bash
# Anthropic
snapcrawl config set ai.provider anthropic
export ANTHROPIC_API_KEY=sk-ant-…

# OpenAI
snapcrawl config set ai.provider openai
export OPENAI_API_KEY=sk-…

# Local, nothing leaves your machine
snapcrawl config set ai.provider ollama
snapcrawl config set ai.model llava
```

Then `snapcrawl diff --ai`, or **Notes** in the web UI. Global settings live in `~/.snapcrawl/config.json` (mode 600); `ai.model` overrides the default model.

## Commands

| Command | |
|---|---|
| `snapcrawl doctor` | check Xcode, idb, simulator, config |
| `snapcrawl devices` | list simulators and USB iPhones |
| `snapcrawl apps` | list apps on the booted simulator · `--device` for an iPhone |
| `snapcrawl init` | write `snapcrawl.config.json` |
| `snapcrawl crawl` | explore the app · `--bundle --udid --device --label --max-depth --max-screens --mfa --prepare --diff` |
| `snapcrawl runs` | list runs (◆ marks each app's baseline) |
| `snapcrawl baseline [run]` | show baselines, or make a run the baseline of its app |
| `snapcrawl diff [base] [head]` | compare runs (default: baseline vs the newest run after it) · `--ai` |
| `snapcrawl review [base] [head]` | list the changes and their decisions |
| `snapcrawl review <id\|all> <approve\|reject\|undo>` | decide like in the UI · `all` = every open change |
| `snapcrawl report [base] [head]` | write an HTML report to `.snapcrawl/reports/` · `--full --out <file>` |
| `snapcrawl ui` | local web UI · `--port --no-open` |
| `snapcrawl demo` | create sample runs |
| `snapcrawl config set <key> <value>` | global settings |
| `snapcrawl wda setup --team <id>` | build WebDriverAgent for the connected iPhone · `--bundle-id` |
| `snapcrawl wda start` / `stop` / `status` | run WebDriverAgent on the iPhone with port forwarding · `--udid` |

`snapcrawl diff` exits with code `1` when screens crashed or became unreachable, so it can fail a CI job.

## How it works

1. **Explore.** After launch (and login), the crawler reads the accessibility tree with `idb ui describe-all`, collects tappable elements (buttons, cells, tabs, links), and explores breadth-first. To get back to a screen it taps *Back* or relaunches the app and replays the taps that led there.
2. **Identify screens.** A screen's identity is a fingerprint of its accessibility structure, with numbers masked, so a clock or a counter does not create a "new" screen. Web content inside the app (ad banners, embedded pages) is left out, so a rotating banner does not either. When the fingerprint differs, a **signature** decides: the stable parts of a screen (navigation bar title, selected tab, buttons, toolbar, layout) count, feed texts in cells, numbers, dates and ads count little or not at all. Two views are the same screen from a similarity of `crawl.matchThreshold` (0.8); a different navigation bar title always means a different screen. The same rule is used for replays (every step is checked and logged as `replay s002 ok · match 0.91`) and for matching screens between two runs. Screens are named after the navigation bar title, else the selected tab, else the first large text near the top, else the action that led there; repeated names get " (2)", " (3)".
3. **Detect crashes.** After every tap snapcrawl checks whether the app process is still alive and records a crash node in the graph.
4. **Compare.** Screens of two runs are matched by the path of taps that reached them, then by fingerprint. Matched screenshots are compared with [pixelmatch](https://github.com/mapbox/pixelmatch); changed pixels are grouped into regions. Screens only in the new run are *new*; screens only in the baseline are *unreachable*.

## Output

```
.snapcrawl/
├── baselines.json               # baseline run per app
├── reports/                     # exported HTML reports
│   └── snapcrawl-<app>-<head>-<summary|full>.html
├── runs/<run-id>/
│   ├── atlas.json               # screens, edges, paths, device info
│   └── screens/s000.png …
└── diffs/<base>__<head>/
    ├── report.json              # statuses, regions, review decisions, notes
    └── s000.png …               # pixel diff images
```

Add `.snapcrawl/` to `.gitignore` (`snapcrawl init` does this).

## Limitations and roadmap

- iOS Simulator and iPhones over USB. **Next:** Android (adb + UiAutomator).
- Apps with poor accessibility labels expose fewer tappable elements; a screenshot-based fallback is planned.
- Lists with endless dynamic content can produce many similar screens; use `maxScreens` and `maxDepth`.
- Planned: replay mode (re-run exactly the baseline paths), ignore regions per screen.

## Development

```bash
npm install
npm test          # runs the crawler against a scripted fake app; no Xcode needed
```

Drivers implement one small interface (`resolve`, `listApps`, `launch`, `isRunning`, `elements`, `tap`, `type`, `screenshot`), see `src/drivers/ios-sim.js`, `src/drivers/ios-device.js` and `test/fake-app.js`. `test/fake-wda.js` serves the fake app as a WebDriverAgent, so the iPhone driver and the port forwarder are tested without a phone.

## Troubleshooting

- **`unable to find utility "simctl"`**: only the command line tools are active. `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
- **`You have not agreed to the Xcode license`**: `sudo xcodebuild -license accept`
- **`Refusing to load formula … from untrusted tap`**: `brew trust facebook/fb`
- **`Unable to find application named 'Simulator'`**: `open "$(xcode-select -p)/Applications/Simulator.app"`. The window is optional; a booted simulator is enough.
- **`idb: command not found`** after `pipx install fb-idb`: run `pipx ensurepath` and open a new terminal.
- **idb fails on a very new Python:** `pipx install --python python3.11 fb-idb`.
- **No booted simulator:** `snapcrawl devices`, then `xcrun simctl boot "<name>"`.
- **Port 4747 busy:** `snapcrawl ui` picks the next free port automatically.
- **Taps land in the wrong place:** raise `crawl.settleMs` so animations finish before the screen is read.

## License

MIT

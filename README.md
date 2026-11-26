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
xcode-select --install                                # command line tools
brew tap facebook/fb && brew install idb-companion     # idb server
brew install pipx && pipx install fb-idb              # idb client
```

## Install

```bash
npm install -g github:<your-user>/snapcrawl
snapcrawl doctor
```

`snapcrawl doctor` checks every requirement and prints the fix for anything missing.

Or from a clone:

```bash
git clone https://github.com/<your-user>/snapcrawl && cd snapcrawl
npm install && npm link
```

## Try it without a simulator

```bash
snapcrawl demo     # writes two sample runs of a fictional app to ./.snapcrawl
snapcrawl ui       # opens http://localhost:4747
```

## Quick start

```bash
xcrun simctl boot "iPhone 16" && open -a Simulator
# install your build: xcrun simctl install booted path/to/MyApp.app

cd my-app-repo
snapcrawl init                     # writes snapcrawl.config.json
snapcrawl apps                     # find your bundle id
snapcrawl crawl --bundle com.acme.app --label v2.3.0    # first run becomes the baseline

# … install the next build …
snapcrawl crawl --bundle com.acme.app --label v2.4.0 --diff
snapcrawl ui
```

Everything can also be started from the browser: `snapcrawl ui` → **Setup** → pick simulator and app → **Start crawl**.

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
  "crawl": { "maxDepth": 8, "maxScreens": 200, "timeLimitMin": 20, "blocklist": ["log out", "delete account", "buy"] },
  "diff": { "threshold": 0.1, "minChangedRatio": 0.0005, "ignoreStatusBar": true }
}
```

| Key | Default | Meaning |
|---|---|---|
| `crawl.maxDepth` | `8` | taps away from the first screen |
| `crawl.maxScreens` | `200` | stop after this many screens |
| `crawl.timeLimitMin` | `20` | stop after this many minutes |
| `crawl.settleMs` | `900` | wait after each tap before reading the screen |
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
| `snapcrawl devices` | list simulators |
| `snapcrawl apps` | list apps on the booted simulator |
| `snapcrawl init` | write `snapcrawl.config.json` |
| `snapcrawl crawl` | explore the app · `--bundle --udid --label --max-depth --max-screens --mfa --diff` |
| `snapcrawl runs` | list runs (◆ marks the baseline) |
| `snapcrawl baseline [run]` | show or set the baseline |
| `snapcrawl diff [base] [head]` | compare runs (default: baseline vs latest) · `--ai` |
| `snapcrawl ui` | local web UI · `--port --no-open` |
| `snapcrawl demo` | create sample runs |
| `snapcrawl config set <key> <value>` | global settings |

`snapcrawl diff` exits with code `1` when screens crashed or became unreachable, so it can fail a CI job.

## How it works

1. **Explore.** After launch (and login), the crawler reads the accessibility tree with `idb ui describe-all`, collects tappable elements (buttons, cells, tabs, links), and explores breadth-first. To get back to a screen it taps *Back* or relaunches the app and replays the taps that led there.
2. **Identify screens.** A screen's identity is a fingerprint of its accessibility structure, with numbers masked, so a clock or a counter does not create a "new" screen.
3. **Detect crashes.** After every tap snapcrawl checks whether the app process is still alive and records a crash node in the graph.
4. **Compare.** Screens of two runs are matched by the path of taps that reached them, then by fingerprint. Matched screenshots are compared with [pixelmatch](https://github.com/mapbox/pixelmatch); changed pixels are grouped into regions. Screens only in the new run are *new*; screens only in the baseline are *unreachable*.

## Output

```
.snapcrawl/
├── baseline                     # id of the baseline run
├── runs/<run-id>/
│   ├── atlas.json               # screens, edges, paths, device info
│   └── screens/s000.png …
└── diffs/<base>__<head>/
    ├── report.json              # statuses, regions, review decisions, notes
    └── s000.png …               # pixel diff images
```

Add `.snapcrawl/` to `.gitignore` (`snapcrawl init` does this).

## Limitations and roadmap

- iOS Simulator only for now. **Next:** real iPhones over USB (WebDriverAgent) and Android (adb + UiAutomator).
- Apps with poor accessibility labels expose fewer tappable elements; a screenshot-based fallback is planned.
- Lists with endless dynamic content can produce many similar screens; use `maxScreens` and `maxDepth`.
- Planned: replay mode (re-run exactly the baseline paths), ignore regions per screen, static HTML report for CI artifacts.

## Development

```bash
npm install
npm test          # runs the crawler against a scripted fake app; no Xcode needed
```

Drivers implement one small interface (`resolve`, `listApps`, `launch`, `isRunning`, `elements`, `tap`, `type`, `screenshot`), see `src/drivers/ios-sim.js` and `test/fake-app.js`.

## Troubleshooting

- **`idb: command not found`** after `pipx install fb-idb`: run `pipx ensurepath` and open a new terminal.
- **idb fails on a very new Python:** `pipx install --python python3.11 fb-idb`.
- **No booted simulator:** `xcrun simctl boot "iPhone 16" && open -a Simulator`.
- **Taps land in the wrong place:** raise `crawl.settleMs` so animations finish before the screen is read.

## License

MIT

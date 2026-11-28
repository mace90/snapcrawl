---
name: snappcrawl
description: Check an iOS app after changing it. Crawls the app in the Simulator and compares every screen with a baseline or with main (screenshots, texts, buttons, navigation, crashes). Use after editing SwiftUI or UIKit views, navigation, texts, layout, assets or app startup, before saying the work is done, and when asked to test, verify or screenshot an iOS app.
when_to_use: 'Requests like: check the iOS app, did I break the UI, regression test the app, screenshot every screen, compare with main; and after any change to the user interface of an app with an .xcodeproj or .xcworkspace.'
---

# Checking an iOS app with snappcrawl

snappcrawl taps through the app in the iOS Simulator by itself (no test scripts), saves every screen and compares it with a reference run. Use the `snappcrawl` MCP tools from this plugin.

## The usual check

1. `status`: is the setup ready (Xcode, idb, a booted simulator)? If not, show the user the `setup` hints it returns. Commands with `sudo` are for the user to run.
2. `check` with `baseRef: "main"` (or the branch the work started from) and, if the Xcode project is not in the current folder, `dir`. snappcrawl builds main in a temporary worktree and the working tree, crawls both and compares them. Nothing else to prepare.
   - Already installed app instead: `check` with `bundleId`; the first check of an app saves its baseline.
   - The call answers within ~45 s. While `verdict` is `running`, call `check_status` with the job id until it is done.
3. Read the result:
   - `passed`: nothing changed. Say so.
   - `broken`: a new crash or a screen that can no longer be reached. Almost always caused by the change: find and fix it, then check again. Crashes marked `known` were already in the baseline.
   - `changes`: for each screen, `texts` (added, removed) and `buttons` (renamed, moved, removed) say what differs. Decide whether each is what the user asked for. When words are not enough, call `screen` with its id to see the head and diff pictures.
   - `input`: a login, code or PIN is needed. Ask the user for test credentials as environment variables (SNAPPCRAWL_USERNAME, SNAPPCRAWL_PASSWORD, SNAPPCRAWL_TOTP_SECRET, SNAPPCRAWL_PIN). Never use real accounts.
4. Report to the user: verdict, what changed in words, what you fixed. Unexpected changes are findings, not noise.

## Rules

- Do not `review` approve or `set_baseline` on your own to make a check pass. Approving is the user's decision; offer it.
- An area that changes on every run (an animation, live data) can be left out with `ignore`, after telling the user.
- Without the MCP tools, the CLI does the same: `snappcrawl check --build --base-ref main --json` (exit 0 passed, 1 broken, 2 changes, 3 needs input, 4 setup).

# Releasing snappcrawl

Everything below is prepared in the repository; each step publishes something and is done by hand, in this order.

## 1. Version

`package.json`, `package-lock.json`, `server.json` (twice) and `.claude-plugin/plugin.json` carry the version (now 0.4.0); `CHANGELOG.md` has the section. `npm test` green, `claude plugin validate --strict .` green.

## 2. npm

```bash
npm login
npm publish --dry-run          # check the file list: bin, src, ui, README, LICENSE
npm publish                    # publishConfig.access is public
git tag v0.4.0 && git push origin v0.4.0
gh release create v0.4.0 --title "snappcrawl 0.4.0" --notes-file <(awk '/^## 0.4.0/{p=1;next}/^## /{p=0}p' CHANGELOG.md)
```

From then on: `npx -y snappcrawl` works everywhere, and `npm i -g snappcrawl` replaces the GitHub install in the README.

## 3. MCP Registry (registry.modelcontextprotocol.io)

Needs the npm package from step 2 (its `mcpName` proves ownership).

```bash
brew install mcp-publisher
mcp-publisher login github     # device code in the browser, as mace90
mcp-publisher publish          # reads server.json
```

Directories that read the registry (and clients with a server search) list snappcrawl from then on.

## 4. Claude Code plugin

Already live once this is on the default branch: users run

```
/plugin marketplace add mace90/snappcrawl
/plugin install snappcrawl@snappcrawl
```

Test before: `claude plugin marketplace add ./` and `claude plugin install snappcrawl@snappcrawl` in a fresh session. Listing in Anthropic's directory: submit at https://claude.ai/directory/manage (needs a paid claude.ai plan).

## 5. GitHub Action (Marketplace)

`action.yml` is in the root. On the release page of a tag: *Publish this Action to the GitHub Marketplace* (accept the agreement once, category *Testing*). Then `uses: mace90/snappcrawl@v0.4.0` works; keep a moving `v0` tag: `git tag -f v0 && git push -f origin v0`.

## 6. Homebrew

Create `github.com/mace90/homebrew-tap`, then:

```bash
curl -sL https://registry.npmjs.org/snappcrawl/-/snappcrawl-0.4.0.tgz | shasum -a 256
# put the hash into packaging/homebrew/snappcrawl.rb, copy it to homebrew-tap/Formula/snappcrawl.rb
brew install --build-from-source mace90/tap/snappcrawl && brew test snappcrawl
```

Users: `brew install mace90/tap/snappcrawl`.

## 7. After npm: agent configs without a global install

`snappcrawl init --agents --npx` writes `npx -y snappcrawl mcp` into the MCP configs, so a cloned repository works without installing anything first.

## 8. Telling people

- Pull requests to the lists agents and developers read: `punkpeye/awesome-mcp-servers` (Testing), `appcypher/awesome-mcp-servers`, `vsouza/awesome-ios` (Testing), `hesreallyhim/awesome-claude-code`.
- A short demo: `examples/ios-demo`, `snappcrawl check --build --base-ref main` after renaming a button, the PR comment of the action.
- Show HN / r/iOSProgramming / iOS Dev Weekly: the angle is "your coding agent can now prove its iOS change didn't break a screen".

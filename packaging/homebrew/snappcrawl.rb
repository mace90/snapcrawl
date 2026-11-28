# Homebrew formula for a tap (github.com/mace90/homebrew-tap → brew install mace90/tap/snappcrawl).
# Fill in url and sha256 after `npm publish` (see RELEASING.md), then copy it to the tap's Formula/.
class Snappcrawl < Formula
  desc "Crawl your iOS app, map every screen, catch regressions between builds"
  homepage "https://github.com/mace90/snappcrawl"
  url "https://registry.npmjs.org/snappcrawl/-/snappcrawl-0.4.0.tgz"
  sha256 "FILL_IN_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "node"
  depends_on :macos

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      For simulators snappcrawl uses idb:
        brew tap facebook/fb && brew install idb-companion
        pipx install fb-idb
      Then run `snappcrawl` (setup check and web UI) or `snappcrawl setup`.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/snappcrawl --version")
    assert_match "check", shell_output("#{bin}/snappcrawl help")
  end
end

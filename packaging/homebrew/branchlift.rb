class Branchlift < Formula
  desc "Stateful backend environments for parallel coding agents"
  homepage "https://github.com/muratkomurcu/BranchLift"
  url "https://github.com/muratkomurcu/BranchLift/releases/download/v1.1.0/branchlift-1.1.0.tgz"
  sha256 "b6bca7e6eb472236b3ccaa234922d9d5bae18e78681f55a946609568b4caca7d"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/branchlift --version")
  end
end

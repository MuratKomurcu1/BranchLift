class Branchlift < Formula
  desc "Stateful backend environments for parallel coding agents"
  homepage "https://github.com/muratkomurcu/BranchLift"
  url "https://github.com/muratkomurcu/BranchLift/releases/download/v1.1.0/branchlift-1.1.0.tgz"
  sha256 "b1b3f153510b112106f0d1f07eef983a91e1249e461dd33740b2e36fbd5c3128"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/branchlift --version")
  end
end

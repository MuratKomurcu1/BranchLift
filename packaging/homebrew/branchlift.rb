class Branchlift < Formula
  desc "Stateful backend environments for parallel coding agents"
  homepage "https://github.com/MuratKomurcu1/BranchLift"
  url "https://github.com/MuratKomurcu1/BranchLift/releases/download/v1.4.0/branchlift-1.4.0.tgz"
  sha256 "1c14fd63138ef945f93415a90d9c88ead6bc131fee1acd5a603e12aada916d07"
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

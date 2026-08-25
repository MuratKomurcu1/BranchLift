class Branchlift < Formula
  desc "Stateful backend environments for parallel coding agents"
  homepage "https://github.com/MuratKomurcu1/BranchLift"
  url "https://github.com/MuratKomurcu1/BranchLift/releases/download/v1.4.0/branchlift-1.4.0.tgz"
  sha256 "0379b38af31764d2f80e98799950da02af37c408f2181c574fb272beba2b0fa1"
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

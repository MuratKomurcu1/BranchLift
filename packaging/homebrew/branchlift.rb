class Branchlift < Formula
  desc "Stateful backend environments for parallel coding agents"
  homepage "https://github.com/MuratKomurcu1/BranchLift"
  url "https://github.com/MuratKomurcu1/BranchLift/releases/download/v1.2.0/branchlift-1.2.0.tgz"
  sha256 "30de1b976791f09bb0e8ff46a9462d583dba90e8033f649bd2a949e1282a3b34"
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

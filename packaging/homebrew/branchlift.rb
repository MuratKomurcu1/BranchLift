class Branchlift < Formula
  desc "Stateful backend environments for parallel coding agents"
  homepage "https://github.com/muratkomurcu/BranchLift"
  url "https://github.com/muratkomurcu/BranchLift/releases/download/v1.1.0/branchlift-1.1.0.tgz"
  sha256 "ceab45c500bc0e5cf54f5c4e60b1fbf9b4840b0567f386a2cfa19d60544de47a"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/branchlift --version")
  end
end

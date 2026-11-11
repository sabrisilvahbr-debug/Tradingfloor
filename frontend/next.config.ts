import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Gera um servidor enxuto para rodar dentro do Docker.
  output: "standalone",
};

export default nextConfig;

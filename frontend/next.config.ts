import type { NextConfig } from "next";

// Docker usa o servidor enxuto ("standalone"). Netlify, Cloudflare Pages e outros hosts
// estáticos usam a exportação estática (pasta out/), pois o painel roda todo no navegador.
const isDocker = process.env.TMF_DOCKER === "1";

const nextConfig: NextConfig = {
  output: isDocker ? "standalone" : "export",
  images: { unoptimized: true },
};

export default nextConfig;

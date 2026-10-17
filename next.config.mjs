/** @type {import('next').NextConfig} */
const distDir = process.env.NEXT_DIST_DIR || ".next";

const nextConfig = {
  output: "standalone",
  distDir,
  experimental: {
    ...(distDir === ".next-desktop" ? { cpus: 2 } : {}),
    serverComponentsExternalPackages: ["sharp"],
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;

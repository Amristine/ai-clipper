import type { NextConfig } from "next";
const nextConfig: NextConfig = { webpack(config) { config.resolve.alias = { ...config.resolve.alias, "@ffmpeg/ffmpeg": "@ffmpeg/ffmpeg", "@ffmpeg/util": "@ffmpeg/util" }; return config; } };
export default nextConfig;

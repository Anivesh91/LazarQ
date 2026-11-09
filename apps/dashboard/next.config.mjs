import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  ...(process.env.NEXT_OUTPUT_STANDALONE === "true"
    ? {
        output: "standalone",
        outputFileTracingRoot: path.join(__dirname, "../../"),
      }
    : {}),
};

export default nextConfig;

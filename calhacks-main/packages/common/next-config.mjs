import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Secrets live in one .env.local at the repo root. Next.js only reads env files from each store's folder, so the root file is loaded here.
// Each store runs from its own folder, two levels below the root.
const rootEnv = resolve(process.cwd(), "../../.env.local");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Every store shares this Next.js config. Workspace packages ship TypeScript, so Next.js compiles them.
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  devIndicators: false,
  transpilePackages: ["@calhacks/common", "@calhacks/amazon"],
};

export default nextConfig;

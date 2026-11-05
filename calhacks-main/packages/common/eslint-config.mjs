import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Every store shares this ESLint config.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The covers are small local files sized with CSS, so plain img tags are fine.
    rules: { "@next/next/no-img-element": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;

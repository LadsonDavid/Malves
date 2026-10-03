import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, so no build is needed before `pnpm test`.
    alias: {
      "@malves/protocol": src("protocol"),
      "@malves/core": src("core"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // GitHub's Windows runners have slow disks: a SQLite test that writes with
    // synchronous=FULL took 7.4 s there, past the default 5 s. Real hangs still
    // fail — just at 20 s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

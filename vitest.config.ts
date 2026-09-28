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
      "@malves/relay": fileURLToPath(new URL("./packages/relay/src/relay.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});

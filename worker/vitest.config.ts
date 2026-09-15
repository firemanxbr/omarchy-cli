// The Worker's tests run inside workerd (Miniflare) with a real local D1
// and R2: the same code path production runs, with the migrations applied
// to an empty database before each test file (test/setup.ts). Nothing here
// reaches the network.
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JOB_TOKEN_SECRET: "test-secret",
            POOL_URL: "http://pool.test",
            POOL_VERSION: "test",
            SOURCE_CHECK: "off",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});

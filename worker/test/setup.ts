import { applyD1Migrations, env } from "cloudflare:test";

// An empty index with every migration applied, per test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

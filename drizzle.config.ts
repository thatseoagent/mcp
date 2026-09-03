import { defineConfig } from "drizzle-kit";

/**
 * For `pnpm db:generate` only. The server never reads this file: migrations are
 * applied at startup by `src/lib/db/database.ts`, from the SQL committed under
 * `drizzle/`.
 *
 * That split is deliberate. `drizzle-kit` is a development tool — it diffs the
 * schema and writes the migration — and shipping it as a runtime dependency
 * would put a bundler and a TypeScript parser in the install path of a server
 * whose whole claim is that it starts on a clean machine.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
});

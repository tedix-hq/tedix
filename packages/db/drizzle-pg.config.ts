import { defineConfig } from "drizzle-kit";

// Generation is offline: no credentials, env files or production target.
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema-pg/core.ts",
	out: "./drizzle-pg",
});

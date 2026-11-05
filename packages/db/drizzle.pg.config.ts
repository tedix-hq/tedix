import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/pg/schema/index.ts",
	out: "./drizzle-pg",
	dialect: "postgresql",
	casing: "snake_case",
});

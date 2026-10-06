import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
		// trace-safety.test.ts uses raw node:assert (standalone script) — not a
		// vitest suite, so vitest would report "No test suite found". Exclude it.
		exclude: ["src/trace-safety.test.ts"],
	},
});

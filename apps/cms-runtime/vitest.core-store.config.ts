import { defineConfig } from "vite-plus";

export default defineConfig({
	test: { include: ["test/core-store.test.ts"], maxWorkers: 1 },
});

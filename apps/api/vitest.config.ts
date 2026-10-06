import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { sharedTestConfig } from "../../scripts/vite/task-config";

export default defineConfig({
	resolve: {
		alias: {
			// `agents/observability/ai` (the span wrapper behind
			// `src/lib/traced-ai.ts`) imports `cloudflare:workers`, which exists
			// only at Worker runtime. Without this alias every node test that
			// imports a kernel router fails to collect.
			"cloudflare:workers": fileURLToPath(
				new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
	test: {
		// A package-local config REPLACES the root one rather than merging, so the
		// shared bounds have to be spread back in or this suite silently drops to
		// vitest's 5s default. See scripts/vite/task-config.ts.
		...sharedTestConfig,
		server: {
			deps: {
				// `agents` ships ESM that imports `cloudflare:workers` directly.
				// Externalized it reaches Node's resolver, which rejects the scheme
				// before the alias above can apply; inlined it goes through Vite.
				inline: ["agents"],
			},
		},
	},
});

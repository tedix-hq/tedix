import path from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
	resolve: {
		alias: {
			// `@cloudflare/containers` imports `DurableObject` from
			// `cloudflare:workers`, which only exists at Worker runtime.
			// Stub it so MCP integration smoke tests can run under plain
			// Node — none of the stubbed APIs are exercised.
			"cloudflare:workers": path.resolve(
				__dirname,
				"../mcp/test/stubs/cloudflare-workers.ts",
			),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["e2e/**", "test/e2e/**", "src/**/*.workerd.test.ts"],
		// `@cloudflare/containers` ships ESM with extensionless internal
		// imports (`import './lib/container'`) that Node's strict resolver
		// rejects. Inline transform routes it through Vite, which fills in
		// the `.js` extension. Required for `mcp-integration.test.ts`,
		// which transitively imports the Sandbox SDK.
		//
		// `@cloudflare/codemode` also exports Worker-runtime helpers from its
		// root entrypoint. Inline it so value imports used by the Tedi MCP
		// muscle tools respect the `cloudflare:workers` test alias above.
		server: {
			deps: {
				inline: [
					"@cloudflare/codemode",
					"@cloudflare/containers",
					"@cloudflare/sandbox",
				],
			},
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			exclude: ["e2e/**", "node_modules/**", "**/*.test.ts"],
		},
	},
});

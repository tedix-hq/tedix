import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
	resolve: {
		// src/template-plugins.test.ts imports the template plugin sources. Once a
		// starter build has installed templates/*/node_modules, their `emdash`
		// import would resolve there and escape the test's vi.mock("emdash").
		alias: [
			{
				find: /^emdash$/,
				replacement: fileURLToPath(import.meta.resolve("emdash")),
			},
		],
	},
	test: {
		environment: "node",
		server: { deps: { inline: [/emdash/] } },
		// scripts/ carries the operator validators (responsive media, Site Builder MCP
		// surface, route smoke). Their pure contract helpers are unit-tested here.
		include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
	},
});

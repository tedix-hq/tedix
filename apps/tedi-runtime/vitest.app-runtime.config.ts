import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: path.resolve(import.meta.dirname, "test/app-runtime/worker.ts"),
			miniflare: {
				compatibilityDate: "2026-10-01",
				compatibilityFlags: ["nodejs_compat"],
				workerLoaders: { LOADER: {} },
				bindings: { SECRETS_MASTER_KEY: "fictional-app-test-key" },
				serviceBindings: {
					API_SERVICE: async (request) => {
						const body = (await request.json()) as {
							json?: {
								events?: Array<{ outcome?: string }>;
								operation?: string;
								args?: { decision?: string };
							};
						};
						if (body.json?.operation === "connections.call") {
							const status = body.json.args?.decision ?? "pending";
							if (status === "revoked")
								return new Response("Revoked", { status: 403 });
							return Response.json({
								json:
									status === "approved"
										? { events: ["fixture-event"] }
										: { approval: { approved: false, status } },
							});
						}
						if (
							body.json?.events?.some(
								(event) => event.outcome === "fixture_unavailable",
							)
						)
							return new Response("Unavailable", { status: 503 });
						return Response.json({ json: { recorded: true } });
					},
				},
				durableObjects: {
					WORKSPACE_APP_HOST: {
						className: "WorkspaceAppHostDO",
						useSQLite: true,
					},
				},
			},
		}),
	],
	test: {
		include: ["test/app-runtime/*.workerd.test.ts"],
		testTimeout: 15000,
		fsModuleCache: false,
	},
});

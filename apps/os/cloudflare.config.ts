import {
	bindings,
	defineConfig,
	defineWorker,
	exports,
	triggers,
} from "cf/config";
import { deployValues } from "@tedix/deploy-values";

const runtimeEnv = (
	globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	}
).process?.env;
const releaseSha = runtimeEnv?.GIT_SHA ?? runtimeEnv?.GITHUB_SHA ?? "unknown";
// The isolated Worker lane (`bun dev`, scripts/dev/os-local.ts) and
// `bun run dev:remote`. `bun dev` builds and previews this lane in development
// mode, so it is selected by the environment rather than by `mode`.
const localDev = runtimeEnv?.TEDIX_OS_LOCAL_DEV === "1";
const remoteDev = !localDev && runtimeEnv?.TEDIX_OS_REMOTE_DEV === "1";
// Isolated-lane values. scripts/dev-local.ts passes disabled Descope
// placeholders so a local Worker never reaches a live project.
const localLane = {
	apiUrl: runtimeEnv?.TEDIX_LOCAL_API_URL?.trim() || "http://localhost:8787",
	descopeProjectId:
		runtimeEnv?.DESCOPE_PROJECT_ID || "local-development-disabled",
	descopeBaseUrl: runtimeEnv?.DESCOPE_BASE_URL || "http://127.0.0.1:9",
	demoEnabled: "true",
} as const;
// Shown wherever production takes a value from the private deploy values.
const PLACEHOLDER = "configured-via-private-overlay";
export const productionIngress = {
	workersDev: false,
	previewUrls: false,
} as const;

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	const local = !production && localDev;
	const worker = (name: string) => (production ? `${name}-production` : name);
	// Live production values when Ship sets TEDIX_DEPLOY_VALUES; otherwise
	// every lookup returns the placeholder beside it.
	const live = deployValues({ mode });
	const service = (surface: string, name: string) =>
		production ? live.worker(surface, worker(name)) : name;
	// Development uses a distinct Worker name to isolate its deployment.
	const workerName = production
		? live.worker("os", "public-installation-os")
		: "public-installation-os-development";
	const liveUrl = (host: string) =>
		live.active ? `https://${live.host(host, "")}` : PLACEHOLDER;

	return {
		...(live.active ? { accountId: live.account("") } : {}),
		worker: defineWorker({
			name: workerName,
			entrypoint: "src/worker.ts",
			compatibilityDate:
				(local && runtimeEnv?.TEDIX_LOCAL_COMPATIBILITY_DATE?.trim()) ||
				"2026-08-12",
			compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
			workersDev: productionIngress.workersDev,
			previewUrls: productionIngress.previewUrls,
			...(live.active
				? {
						domains: live.domains("os", []),
						triggers: live
							.routes("os", [])
							.map((route) => triggers.fetch(route)),
					}
				: {}),
			logpush: true,
			observability: {
				enabled: true,
				logs: { invocationLogs: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.05 },
			},
			// The router sees every request first, so an unprovisioned tenant is
			// refused before any shell HTML ships.
			assets: {
				runWorkerFirst: true,
				notFoundHandling: "single-page-application",
			},
			// Live SQLite-backed class. Keep it with the same storage: a changed
			// storage is rejected and a deleted state drops every room.
			exports: {
				CollabRoom: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				ASSETS: bindings.assets(),
				// Live OT session state only; canonical truth stays in D1 via apps/api.
				COLLAB_ROOM: bindings.durableObject({
					worker: workerName,
					exportName: "CollabRoom",
				}),
				// Tenant-slug resolution. src/worker.ts skips provisioning enforcement
				// only when the binding is absent.
				API_SERVICE: bindings.worker({
					// scripts/dev-local.ts runs apps/api under this local name.
					worker: local
						? "public-installation-api"
						: service("api", "public-installation-api"),
					exportName: "InternalEntrypoint",
				}),
				// Same-zone fetches to the MCP edge dead-end, so the widget bridge
				// reaches it by binding.
				MCP_SERVICE: bindings.worker({
					worker: service("mcp", "public-installation-mcp"),
					exportName: "InternalEntrypoint",
				}),
				// Workspace chat: the pane's WebSocket upgrade is forwarded to the
				// object that owns the workspace (apps/workspace-do).
				WORKSPACE_RUNTIME: bindings.worker({
					worker: service("workspace-do", "public-installation-workspace-do"),
					exportName: "InternalEntrypoint",
				}),
				// The isolated lane has no session broker.
				...(!local
					? {
							OS_SESSION_BROKER: bindings.worker({
								worker: remoteDev
									? "public-installation-session-broker"
									: service(
											"session-broker",
											"public-installation-session-broker",
										),
								exportName: "OsSessionBroker",
								dev: { remote: remoteDev },
							}),
							CLI_SESSION_BROKER: bindings.worker({
								worker: remoteDev
									? "public-installation-session-broker"
									: service(
											"session-broker",
											"public-installation-session-broker",
										),
								exportName: "CliSessionBroker",
								dev: { remote: remoteDev },
							}),
						}
					: {}),
				// Public identity: src/worker.ts reads DESCOPE_PROJECT_ID, and
				// vite.config.ts bakes all three into the SPA unless a TEDIX_BUILD_*
				// override is set.
				API_URL: bindings.text(local ? localLane.apiUrl : liveUrl("api")),
				DESCOPE_PROJECT_ID: bindings.text(
					local
						? localLane.descopeProjectId
						: live.vars("os", "DESCOPE_PROJECT_ID", PLACEHOLDER),
				),
				DESCOPE_BASE_URL: bindings.text(
					local ? localLane.descopeBaseUrl : liveUrl("auth"),
				),
				// The provider-host cohort resolves its identity on this OS tenant: an
				// organization id, not the Descope tenant id.
				PROVIDER_COHORT_OS_TENANT_ID: bindings.text(
					live.vars("os", "PROVIDER_COHORT_OS_TENANT_ID", PLACEHOLDER),
				),
				PROVIDER_COHORT_EXTERNAL_TENANT_ID: bindings.text(
					live.vars("os", "PROVIDER_COHORT_EXTERNAL_TENANT_ID", PLACEHOLDER),
				),
				// Optional: without it the provider cohort answers 503. Local runs
				// never use it, so it is not declared there (no missing-secret warning).
				...(local
					? { TEDIX_LOCAL_DEMO_ENABLED: bindings.text(localLane.demoEnabled) }
					: { TEDIX_PROVIDER_COHORT_API_KEY: bindings.secret() }),
				GIT_SHA: bindings.text(releaseSha),
				RELEASE_REPOSITORY: bindings.text(
					runtimeEnv?.RELEASE_REPOSITORY ?? PLACEHOLDER,
				),
				SHIP_RUN_ID: bindings.text(runtimeEnv?.SHIP_RUN_ID ?? "0"),
			},
		}),
	};
});

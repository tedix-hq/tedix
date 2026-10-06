import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkBindings,
	localBindingTargets,
	readWorkerRegistry,
	resolveAppBindings,
	resolveRegistryDirectory,
} from "./binding-registry";

function registryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "tedix-dev-registry-"));
}

/** Matches what a live `wrangler dev` writes: one JSON file per Worker. */
function writeWorker(directory: string, name: string, port = 12345): void {
	writeFileSync(
		join(directory, name),
		JSON.stringify({
			debugPortAddress: `127.0.0.1:${port}`,
			defaultEntrypointService: `core:user:${name}`,
			userWorkerService: `core:user:${name}`,
		}),
	);
}

describe("Wrangler dev registry", () => {
	test("prefers WRANGLER_REGISTRY_PATH, then the platform default", () => {
		expect(
			resolveRegistryDirectory(
				{ WRANGLER_REGISTRY_PATH: "/custom/registry" },
				"darwin",
				"/Users/nobody",
			),
		).toBe("/custom/registry");
		// A checkout-scoped registry beats the machine-global one: parallel
		// worktrees each register Workers under the SAME names, so a shared
		// registry lets a service binding resolve to another checkout's Worker.
		const checkout = mkdtempSync(
			join(tmpdir(), "tedix-dev-registry-checkout-"),
		);
		expect(
			resolveRegistryDirectory({}, "darwin", "/Users/nobody", checkout),
		).toBe(checkout);
		// but an explicit override still wins over it.
		expect(
			resolveRegistryDirectory(
				{ WRANGLER_REGISTRY_PATH: "/custom/registry" },
				"darwin",
				"/Users/nobody",
				checkout,
			),
		).toBe("/custom/registry");
		// No legacy ~/.wrangler under a temp home, and no checkout registry, so the
		// XDG path must answer. The checkout path is injected as a non-existent
		// directory: on a real machine it exists and deliberately shadows both
		// fallbacks (see resolveRegistryDirectory).
		const home = mkdtempSync(join(tmpdir(), "tedix-dev-registry-home-"));
		const noCheckout = join(home, "absent", ".wrangler", "registry");
		expect(resolveRegistryDirectory({}, "darwin", home, noCheckout)).toBe(
			join(home, "Library/Preferences/.wrangler/registry"),
		);
		expect(resolveRegistryDirectory({}, "linux", home, noCheckout)).toBe(
			join(home, ".config/.wrangler/registry"),
		);
		expect(
			resolveRegistryDirectory(
				{ XDG_CONFIG_HOME: "/xdg" },
				"darwin",
				home,
				noCheckout,
			),
		).toBe("/xdg/.wrangler/registry");
	});

	test("a missing directory reports absent rather than failing bindings", () => {
		const snapshot = readWorkerRegistry(
			join(registryDirectory(), "never-created"),
		);
		expect(snapshot.present).toBe(false);
		expect(snapshot.workers.size).toBe(0);
	});

	test("skips malformed and stale entries without throwing", () => {
		const directory = registryDirectory();
		writeWorker(directory, "tedix-tedi");
		writeFileSync(join(directory, "half-written"), '{"debugPortAddress"');
		writeFileSync(join(directory, "not-an-object"), "[]");
		writeFileSync(
			join(directory, "__miniflare_storage_candidate__-abc"),
			JSON.stringify({ storageScope: "/tmp" }),
		);

		const snapshot = readWorkerRegistry(directory);
		expect([...snapshot.workers.keys()]).toEqual(["tedix-tedi"]);
		expect(snapshot.workers.get("tedix-tedi")?.debugPortAddress).toBe(
			"127.0.0.1:12345",
		);
		expect(
			snapshot.skipped.map((skip) => `${skip.file}:${skip.reason}`).sort(),
		).toEqual(["half-written:malformed", "not-an-object:malformed"]);

		// Freshness, not existence, decides: an entry whose heartbeat stopped 10
		// minutes ago belongs to a dev process that is gone.
		const stale = readWorkerRegistry(directory, Date.now() + 600_000);
		expect(stale.workers.size).toBe(0);
		expect(stale.skipped).toContainEqual({
			file: "tedix-tedi",
			reason: "stale",
		});
	});

	test("reports registered and unregistered targets from one snapshot", () => {
		const directory = registryDirectory();
		writeWorker(directory, "tedix-tedi-runtime");
		const snapshot = readWorkerRegistry(directory);
		const checks = checkBindings(
			[
				{
					binding: "TEDI_RUNTIME_SERVICE",
					target: "tedix-tedi-runtime",
					kind: "service",
				},
				{ binding: "CMS", target: "tedix-cms", kind: "service" },
			],
			snapshot,
		);
		expect(checks.map((check) => check.registered)).toEqual([true, false]);
		expect(checks[0]?.detail).toContain("[registered]");
		expect(checks[1]?.detail).toContain("[not registered]");

		// A target whose own file was skipped must say why: "never started" and
		// "heartbeat stopped" are different problems with different fixes.
		const staleChecks = checkBindings(
			[
				{
					binding: "TEDI_RUNTIME_SERVICE",
					target: "tedix-tedi-runtime",
					kind: "service",
				},
			],
			readWorkerRegistry(directory, Date.now() + 600_000),
		);
		expect(staleChecks[0]?.detail).toContain("entry stale");
	});

	test("resolves the local tedix-api rename and cross-script DO bindings", () => {
		const app = mkdtempSync(join(tmpdir(), "tedix-dev-registry-app-"));
		writeFileSync(
			join(app, "wrangler.jsonc"),
			`{
				"name": "tedix-email",
				"services": [{ "binding": "API_SERVICE", "service": "tedix-api" }],
				"durable_objects": {
					"bindings": [
						{ "name": "TEDI_AGENT", "class_name": "AgentTediDO", "script_name": "tedix-tedi-runtime" },
						{ "name": "LOCAL_DO", "class_name": "LocalDO" },
					],
				},
			}
			`,
		);

		// dev-local.ts renames tedix-api locally; resolving the committed name
		// would report every API_SERVICE binding as missing.
		expect(localBindingTargets(app)).toEqual([
			{
				binding: "API_SERVICE",
				target: "public-installation-api",
				kind: "service",
			},
			{
				binding: "TEDI_AGENT",
				target: "tedix-tedi-runtime",
				kind: "durable_object",
			},
		]);

		const directory = registryDirectory();
		writeWorker(directory, "public-installation-api");
		const { checks } = resolveAppBindings(app, "API_SERVICE", directory);
		expect(checks).toHaveLength(1);
		expect(checks[0]?.registered).toBe(true);
	});

	test("reads peer bindings from a cloudflare.config.ts in development mode", () => {
		const app = mkdtempSync(join(tmpdir(), "tedix-dev-registry-cf-app-"));
		writeFileSync(
			join(app, "cloudflare.config.ts"),
			`export default ({ mode }: { mode: string }) => ({
				worker: {
					name: "tedix-edge",
					env: {
						API_SERVICE: { type: "worker", worker: mode === "production" ? "tedix-api-production" : "public-installation-api", exportName: "InternalEntrypoint" },
						SANDBOX: { type: "durable-object", worker: "tedix-sandbox", exportName: "Sandbox" },
						DB: { type: "d1", id: "local" },
					},
				},
			});
			`,
		);

		expect(localBindingTargets(app)).toEqual([
			{
				binding: "API_SERVICE",
				target: "public-installation-api",
				kind: "service",
			},
			{ binding: "SANDBOX", target: "tedix-sandbox", kind: "durable_object" },
		]);
	});
});

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";
import { unstable_readConfig } from "wrangler";
import { developerInstallationManifest } from "./developer-example";
import {
	createWranglerOverlay,
	renderWranglerSecretNames,
	WranglerOverlayError,
} from "./wrangler-overlay";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourcePath = resolve(repositoryRoot, "apps/api/wrangler.jsonc");
const outputPath = resolve(
	repositoryRoot,
	"apps/api/wrangler.oss-example.json",
);
const secretsPath = resolve(
	repositoryRoot,
	"apps/api/wrangler.oss-example.secrets.json",
);
function source(): string {
	return readFileSync(sourcePath, "utf8");
}

/**
 * The account and database identifiers the overlay must strip are read back out
 * of the private source config rather than copied here: a literal in this file
 * would ship verbatim in the OSS export (only `wrangler.jsonc` is sanitized on
 * the way out), and a copy also silently stops testing anything the day the
 * source config is repointed. The public export already ships that config
 * sanitized (no account id, zeroed D1 id), so there is less to strip there.
 */
function sourceProductionIdentifiers(): string[] {
	const config = parse(source()) as {
		account_id?: unknown;
		d1_databases?: { database_id?: unknown }[];
	};
	const identifiers = [
		config.account_id,
		...(config.d1_databases ?? []).map((database) => database?.database_id),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	const isPublicExport = !existsSync(
		resolve(repositoryRoot, "scripts/oss/public-files.json"),
	);
	if (!isPublicExport && identifiers.length < 2) {
		throw new Error(
			"the source Wrangler config declares no account id and D1 database id to strip",
		);
	}
	return identifiers;
}

const productionMarkers = [
	...sourceProductionIdentifiers(),
	"tedix.dev",
	"tedi.club",
	["pass:", "//"].join(""),
];

function manifest(): Record<string, any> {
	return structuredClone(developerInstallationManifest);
}

describe("Wrangler installation overlay", () => {
	test("is deterministic and maps every declared binding kind", () => {
		const first = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: source(),
			workerId: "control-api",
		});
		const second = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(first).toEqual(second);
		expect(first.config).toMatchObject({
			account_id: "example-cloudflare-account",
			ai: { binding: "AI" },
			assets: {
				binding: "ASSETS",
				directory: "./dist/client",
				run_worker_first: true,
			},
			browser: { binding: "BROWSER" },
			containers: [
				{
					class_name: "WorkstationContainer",
					image: "registry.example.invalid/acme/workstation:0.1.0",
					name: "acme-workstation",
				},
			],
			d1_databases: [
				{
					binding: "DB",
					database_id: "example-d1-database",
					database_name: "acme-developer",
				},
			],
			durable_objects: {
				bindings: [{ class_name: "AgentState", name: "AGENT" }],
			},
			hyperdrive: [
				{ binding: "GRAPH_DB", id: "example-hyperdrive-configuration" },
			],
			kv_namespaces: [{ binding: "CACHE", id: "example-kv-namespace" }],
			name: "acme-control-api",
			workers_dev: false,
			vars: {
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
				TEDIX_FLEET_AUTHORITY_MODE: "disabled",
				TEDIX_RUNTIME_ENTITLEMENT_GRANTS:
					'[{"key":"browser-runtime","status":"active","source":"operator"}]',
			},
			queues: {
				producers: [{ binding: "EVENTS", queue: "acme-events" }],
			},
			r2_buckets: [
				{ binding: "ARTIFACTS", bucket_name: "acme-developer-artifacts" },
			],
			services: [{ binding: "RUNTIME", service: "acme-runtime-production" }],
			vectorize: [{ binding: "VECTOR", index_name: "acme-memory" }],
			workflows: [
				{
					binding: "INSTALLER",
					class_name: "InstallWorkflow",
					name: "acme-install",
				},
			],
		});
	});

	test("carries a named service-binding entrypoint", () => {
		const input = manifest();
		const binding = input.workers[0].bindings.find(
			(entry: { kind: string }) => entry.kind === "service",
		);
		binding.entrypoint = "InternalEntrypoint";
		const result = createWranglerOverlay({
			manifest: input,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(result.config.services).toEqual([
			{
				binding: "RUNTIME",
				entrypoint: "InternalEntrypoint",
				service: "acme-runtime-production",
			},
		]);
	});

	test("takes workers.dev exposure from the manifest, not the authored config", () => {
		const input = manifest();
		input.workers[0].workersDev = true;
		const authored = {
			...(parse(source()) as Record<string, unknown>),
			workers_dev: false,
		};
		const result = createWranglerOverlay({
			manifest: input,
			sourceConfig: JSON.stringify(authored),
			workerId: "control-api",
		});
		expect(result.config.workers_dev).toBe(true);
	});

	test("strips production identifiers, source environments, and source bindings", () => {
		const result = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: source(),
			workerId: "control-api",
		});
		for (const marker of productionMarkers)
			expect(result.text).not.toContain(marker);
		expect(result.config.env).toBeUndefined();
		expect(result.config.flagship).toBeUndefined();
		expect(result.config.ai_search_namespaces).toBeUndefined();
		expect(result.config.send_email).toBeUndefined();
		expect(result.config.main).toBe("src/index.ts");
		expect(result.config.compatibility_flags).toEqual([
			"nodejs_compat",
			// Coordinate-free hardening (e38d173f9): an install wants the same
			// strictly-public fetch posture as production, so the flag survives.
			"global_fetch_strictly_public",
		]);
		// Script-scoped, coordinate-free features must survive the overlay: the
		// rate limiter fails closed (503s every request) when its binding is
		// missing, and CF_VERSION_METADATA is read unguarded on the version route.
		expect(result.config.ratelimits).toEqual(
			(parse(source()) as Record<string, unknown>).ratelimits,
		);
		expect(result.config.version_metadata).toEqual({
			binding: "CF_VERSION_METADATA",
		});
		// worker_loaders is equally coordinate-free (apps/api does not declare it,
		// so exercise the passthrough with an augmented source).
		const augmented = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: JSON.stringify({
				...(parse(source()) as Record<string, unknown>),
				worker_loaders: [{ binding: "LOADER" }],
			}),
			workerId: "control-api",
		});
		expect(augmented.config.worker_loaders).toEqual([{ binding: "LOADER" }]);
		expect(result.config.observability).toEqual(
			expect.objectContaining({ enabled: true }),
		);
	});

	test("preserves authored Durable Object migrations exactly after JSONC parsing", () => {
		const authored = parse(source()) as Record<string, unknown>;
		const result = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(result.config.migrations).toEqual(authored.migrations);
		expect(JSON.stringify(result.config.migrations)).toBe(
			JSON.stringify(authored.migrations),
		);
	});

	test("returns secret names separately and never copies source secret declarations", () => {
		const result = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(result.requiredSecrets).toEqual(["DESCOPE_MANAGEMENT_KEY"]);
		expect(
			result.requiredSecrets.some((name) => name.startsWith("STRIPE_")),
		).toBe(false);
		expect(result.config.secrets).toBeUndefined();
		expect(result.text).not.toContain("DESCOPE_MANAGEMENT_KEY");
		const artifact = renderWranglerSecretNames(
			"control-api",
			result.requiredSecrets,
		);
		expect(JSON.parse(artifact)).toEqual({
			requiredSecrets: ["DESCOPE_MANAGEMENT_KEY"],
			workerId: "control-api",
		});
		expect(() =>
			createWranglerOverlay({
				manifest: developerInstallationManifest,
				sourceConfig:
					'{ "main": "src/index.ts", "define": { "API_TOKEN": "plaintext" } }',
				workerId: "control-api",
			}),
		).toThrow("looks like an inline secret value");
	});

	test("managed settlement requires and returns explicit Stripe secret names", () => {
		const input = manifest();
		input.fleetAuthority.mode = "co-located";
		input.billingSettlement = { provider: "stripe", mode: "managed" };
		expect(() =>
			createWranglerOverlay({
				manifest: input,
				sourceConfig: source(),
				workerId: "control-api",
			}),
		).toThrow(/Managed Stripe settlement requires secret names/);
		for (const name of [
			"STRIPE_SECRET_KEY",
			"STRIPE_TEST_SECRET_KEY",
			"STRIPE_WEBHOOK_SECRET",
			"STRIPE_TEST_WEBHOOK_SECRET",
		]) {
			input.secretRequirements.push({
				name,
				scope: "worker",
				target: "control-api",
				required: true,
			});
		}
		const result = createWranglerOverlay({
			manifest: input,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(result.config.vars).toMatchObject({
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		});
		expect(result.requiredSecrets).toEqual([
			"DESCOPE_MANAGEMENT_KEY",
			"STRIPE_SECRET_KEY",
			"STRIPE_TEST_SECRET_KEY",
			"STRIPE_TEST_WEBHOOK_SECRET",
			"STRIPE_WEBHOOK_SECRET",
		]);
	});

	test("external settlement is emitted without managed Stripe requirements", () => {
		const input = manifest();
		input.billingSettlement = { provider: "customer-ledger", mode: "external" };
		const result = createWranglerOverlay({
			manifest: input,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(result.config.vars).toMatchObject({
			TEDIX_BILLING_SETTLEMENT_MODE: "external",
		});
		expect(result.requiredSecrets).toEqual(["DESCOPE_MANAGEMENT_KEY"]);
	});

	test("rejects unresolved coordinates in preview mode", () => {
		const input = manifest();
		input.resources[0].databaseId = {
			state: "unresolved",
			key: "developer-database",
			reason: "not provisioned",
		};
		expect(() =>
			createWranglerOverlay({
				manifest: input,
				sourceConfig: source(),
				workerId: "control-api",
			}),
		).toThrow(WranglerOverlayError);
		try {
			createWranglerOverlay({
				manifest: input,
				sourceConfig: source(),
				workerId: "control-api",
			});
		} catch (error) {
			expect((error as WranglerOverlayError).code).toBe(
				"coordinate.unresolved",
			);
		}
	});

	test("requires installation-ready certification only in deploy mode", () => {
		expect(() =>
			createWranglerOverlay({
				manifest: developerInstallationManifest,
				mode: "deploy",
				sourceConfig: source(),
				workerId: "control-api",
			}),
		).toThrow("Deploy overlay requires certified installation-ready");

		const certified = manifest();
		certified.certification.status = "certified";
		certified.certification.level = "installation-ready";
		expect(
			createWranglerOverlay({
				manifest: certified,
				mode: "deploy",
				sourceConfig: source(),
				workerId: "control-api",
			}).config.name,
		).toBe("acme-control-api");
	});

	test("tracked developer artifacts match generated output", () => {
		const result = createWranglerOverlay({
			manifest: developerInstallationManifest,
			sourceConfig: source(),
			workerId: "control-api",
		});
		expect(readFileSync(outputPath, "utf8")).toBe(result.text);
		expect(readFileSync(secretsPath, "utf8")).toBe(
			renderWranglerSecretNames("control-api", result.requiredSecrets),
		);
		const trackedArtifacts = `${readFileSync(outputPath, "utf8")}\n${readFileSync(secretsPath, "utf8")}`;
		for (const marker of productionMarkers) {
			expect(trackedArtifacts).not.toContain(marker);
		}
		const wranglerConfig = unstable_readConfig({ config: outputPath });
		expect(wranglerConfig.name).toBe("acme-control-api");
		expect(wranglerConfig.main).toBe(
			resolve(repositoryRoot, "apps/api/src/index.ts"),
		);
	});
});

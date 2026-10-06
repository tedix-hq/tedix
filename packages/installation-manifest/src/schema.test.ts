import { describe, expect, test } from "bun:test";
import { developerInstallationManifest } from "./developer-example";
import {
	certifyInstallationManifest,
	installationManifestJsonSchema,
	parseInstallationManifest,
} from "./schema";

function example(): Record<string, any> {
	return structuredClone(developerInstallationManifest);
}

function claimInstallationReady(manifest: Record<string, any>): void {
	manifest.certification.status = "certified";
	manifest.certification.level = "installation-ready";
}

describe("installation manifest", () => {
	test("accepts current cf config paths without allowing arbitrary TypeScript", () => {
		const manifest = example();
		manifest.workers[0].sourceConfig = "apps/api/cloudflare.config.ts";
		expect(parseInstallationManifest(manifest).workers[0]?.sourceConfig).toBe(
			"apps/api/cloudflare.config.ts",
		);
		for (const path of [
			"apps/api/arbitrary.ts",
			"../cloudflare.config.ts",
			"/apps/api/cloudflare.config.ts",
		]) {
			manifest.workers[0].sourceConfig = path;
			expect(() => parseInstallationManifest(manifest)).toThrow();
		}
	});

	test("parses the sanitized developer example without claiming certification", () => {
		const parsed = parseInstallationManifest(developerInstallationManifest);
		const certification = certifyInstallationManifest(parsed);
		expect(parsed.schemaVersion).toBe("1.0");
		expect(parsed.workers[0]?.sourceConfig).toBe("apps/api/wrangler.jsonc");
		expect(certification).toMatchObject({
			certified: false,
			effectiveStatus: "uncertified",
			issues: [],
			success: true,
		});
	});

	test("covers every declared Cloudflare resource and binding kind", () => {
		const expected = [
			"ai",
			"assets",
			"browser",
			"container",
			"d1",
			"durable-object",
			"hyperdrive",
			"kv",
			"queue",
			"r2",
			"service",
			"vectorize",
			"workflow",
		];
		expect(
			developerInstallationManifest.resources
				.map((resource) => resource.kind)
				.sort(),
		).toEqual(expected);
		expect(
			developerInstallationManifest.workers
				.flatMap((worker) => worker.bindings.map((binding) => binding.kind))
				.sort(),
		).toEqual(expected);
	});

	test("rejects unknown fields at the document and nested levels", () => {
		const topLevel = example();
		topLevel.unknown = true;
		const nested = example();
		nested.organization.unknown = true;
		expect(certifyInstallationManifest(topLevel).success).toBe(false);
		expect(certifyInstallationManifest(nested).success).toBe(false);
		expect(certifyInstallationManifest(nested).issues[0]?.code).toBe(
			"schema.unrecognized_keys",
		);
	});

	test("rejects the retired dashboard surface kind", () => {
		const manifest = example();
		manifest.surfaces.push({
			id: "retired-dashboard",
			kind: "dashboard",
			worker: "control-api",
			exposure: "authenticated",
		});
		expect(certifyInstallationManifest(manifest).success).toBe(false);
	});

	test("rejects secret values, secret-like bootstrap values, and provider mappings", () => {
		const secretValue = example();
		secretValue.secretRequirements[0].value = "not-allowed";
		const bootstrapSecret = example();
		bootstrapSecret.bootstrap.inputs[0].name = "API_TOKEN";
		const providerMapping = example();
		providerMapping.bootstrap.inputs[0].value = [
			"pass:",
			"//Example/Token",
		].join("");
		const workerVar = example();
		workerVar.workers[0].vars.API_TOKEN = "not-allowed";

		expect(certifyInstallationManifest(secretValue).success).toBe(false);
		expect(certifyInstallationManifest(bootstrapSecret).issues).toContainEqual(
			expect.objectContaining({ code: "bootstrap.secret-like-input" }),
		);
		expect(certifyInstallationManifest(providerMapping).issues).toContainEqual(
			expect.objectContaining({ code: "secret.pass-reference" }),
		);
		expect(certifyInstallationManifest(workerVar).issues).toContainEqual(
			expect.objectContaining({ code: "worker.secret-like-var" }),
		);
	});

	test("rejects absolute and traversing source config paths", () => {
		for (const sourceConfig of ["/tmp/wrangler.jsonc", "../wrangler.jsonc"]) {
			const manifest = example();
			manifest.workers[0].sourceConfig = sourceConfig;
			expect(certifyInstallationManifest(manifest).success).toBe(false);
		}
	});

	test("rejects capabilities that exclude the organization profile", () => {
		const manifest = example();
		manifest.capabilities[0].accessPlan.profiles = ["smb", "enterprise"];
		expect(certifyInstallationManifest(manifest).issues).toContainEqual(
			expect.objectContaining({ code: "capability.profile-mismatch" }),
		);
	});

	test("rejects topology and binding defects without a certification claim", () => {
		const topology = example();
		topology.cloudflare.primaryAccount = "missing-account";
		const binding = example();
		binding.workers[0].bindings[0].resource = "missing-resource";

		expect(certifyInstallationManifest(topology).issues).toContainEqual(
			expect.objectContaining({ code: "topology.primary-account-missing" }),
		);
		expect(certifyInstallationManifest(binding).issues).toContainEqual(
			expect.objectContaining({ code: "binding.resource-missing" }),
		);
	});

	test("allows certification-readiness defects while the manifest remains uncertified", () => {
		const missingCapability = example();
		missingCapability.capabilities = missingCapability.capabilities.slice(1);
		const unavailableCapability = example();
		unavailableCapability.capabilities[0].availability = "unavailable";
		const unresolved = example();
		unresolved.resources[0].databaseId = {
			state: "unresolved",
			key: "primary-database-id",
			reason: "created during account bootstrap",
		};
		const missingEntitlement = example();
		missingEntitlement.capabilities[0].accessPlan = {
			kind: "entitlement",
			profiles: ["developer"],
			entitlement: "core-runtime",
		};
		const missingProvider = example();
		missingProvider.providerPrerequisites[0].status = "missing";

		for (const manifest of [
			missingCapability,
			unavailableCapability,
			unresolved,
			missingEntitlement,
			missingProvider,
		]) {
			expect(certifyInstallationManifest(manifest)).toMatchObject({
				certified: false,
				effectiveStatus: "uncertified",
				issues: [],
				success: true,
			});
		}
	});

	test("does not certify missing required capabilities or unresolved coordinates", () => {
		const missingCapability = example();
		claimInstallationReady(missingCapability);
		missingCapability.capabilities = missingCapability.capabilities.slice(1);
		const unavailableCapability = example();
		claimInstallationReady(unavailableCapability);
		unavailableCapability.capabilities[0].availability = "unavailable";
		const unresolved = example();
		claimInstallationReady(unresolved);
		unresolved.resources[0].databaseId = {
			state: "unresolved",
			key: "primary-database-id",
			reason: "created during account bootstrap",
		};

		expect(
			certifyInstallationManifest(missingCapability).issues,
		).toContainEqual(
			expect.objectContaining({
				code: "certification.required-capability-missing",
			}),
		);
		expect(
			certifyInstallationManifest(unavailableCapability).issues,
		).toContainEqual(
			expect.objectContaining({
				code: "certification.required-capability-unavailable",
			}),
		);
		expect(certifyInstallationManifest(unresolved)).toMatchObject({
			certified: false,
			effectiveStatus: "blocked",
			success: false,
		});
		expect(certifyInstallationManifest(unresolved).issues).toContainEqual(
			expect.objectContaining({ code: "certification.unresolved-coordinate" }),
		);
	});

	test("keeps runtime entitlements independent from billing settlement", () => {
		const manifest = example();
		expect(manifest.billingSettlement).toBeUndefined();
		expect(certifyInstallationManifest(manifest)).toMatchObject({
			certified: false,
			effectiveStatus: "uncertified",
			success: true,
		});
		claimInstallationReady(manifest);
		manifest.capabilities[0].accessPlan = {
			kind: "entitlement",
			profiles: ["developer"],
			entitlement: "core-runtime",
		};
		expect(certifyInstallationManifest(manifest).issues).toContainEqual(
			expect.objectContaining({ code: "certification.entitlement-missing" }),
		);
	});

	test("requires explicit fleet authority coordinates", () => {
		const missingMode = example();
		delete missingMode.fleetAuthority;
		expect(certifyInstallationManifest(missingMode).success).toBe(false);

		const service = example();
		(service.fleetAuthority as { mode: string }).mode = "service";
		expect(certifyInstallationManifest(service).success).toBe(false);
	});

	test("preserves explicitly configured external and managed settlement modes", () => {
		for (const mode of ["external", "managed"] as const) {
			const manifest = example();
			if (mode === "managed") manifest.fleetAuthority.mode = "co-located";
			manifest.billingSettlement = { provider: "stripe", mode };
			expect(parseInstallationManifest(manifest).billingSettlement?.mode).toBe(
				mode,
			);
		}
	});

	test("returns deterministic issues and JSON Schema", () => {
		const manifest = example();
		claimInstallationReady(manifest);
		manifest.cloudflare.primaryAccount = "missing-account";
		manifest.capabilities[0].availability = "planned";
		manifest.providerPrerequisites[0].status = "missing";
		const first = certifyInstallationManifest(manifest).issues;
		const second = certifyInstallationManifest(manifest).issues;
		expect(first).toEqual(second);
		expect(first.map((issue) => issue.code)).toEqual([
			"certification.required-capability-unavailable",
			"topology.primary-account-missing",
			"certification.provider-not-ready",
		]);

		const firstSchema = installationManifestJsonSchema();
		const secondSchema = installationManifestJsonSchema();
		expect(JSON.stringify(firstSchema)).toBe(JSON.stringify(secondSchema));
		expect(firstSchema).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			additionalProperties: false,
			type: "object",
		});
	});
});

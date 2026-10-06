import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { providerInstallations } from "../schema/provider-installations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getProviderInstallation,
	createProviderInstallationIfAbsent,
	listProviderWidgetInstallations,
	updateProviderWidgetAccess,
	listProviderPortableWebMcpConfigurations,
	publishProviderPortableWebMcpProfile,
	listProviderCapacitySponsorships,
	provisionProviderInstallation,
	resolveActiveProviderInstallation,
	resolveActiveProviderInstallationForOutcome,
	setProviderInstallationPaused,
	setProviderCapacitySponsorship,
} from "./provider-installations";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(providerInstallations));
	return createDbQueryClient(createD1Facade(sqlite));
}

function installation(overrides: Record<string, unknown> = {}) {
	return {
		id: "installation-1",
		providerOrganizationId: "acme-org",
		providerAppId: "acme-api-staging",
		providerApiKeyId: "acme-key",
		externalTenantId: "1",
		customerOrganizationId: "globex-org",
		primaryWorkspaceId: "globex-workspace",
		primaryTediId: "globex-operator",
		allowedOrigin: "https://www.acme.example",
		hostTenantArgument: "companyId",
		hostTenantNamespace: "acme_staging",
		provisionedBy: "operator:test",
		provenance: { pilot: "globex" },
		...overrides,
	};
}

describe("provider installations", () => {
	it("idempotently provisions one target per provider app and external tenant", async () => {
		const db = fixture();
		const first = await provisionProviderInstallation(db, installation());
		const replay = await provisionProviderInstallation(
			db,
			installation({
				id: "ignored-replay-id",
				primaryTediId: "replacement-tedi",
			}),
		);

		expect(first.id).toBe("installation-1");
		expect(replay).toMatchObject({
			id: "installation-1",
			primaryTediId: "replacement-tedi",
			status: "active",
		});
		expect(
			await getProviderInstallation(db, {
				providerOrganizationId: "acme-org",
				providerAppId: "acme-api-staging",
				externalTenantId: "1",
			}),
		).toMatchObject({ customerOrganizationId: "globex-org" });
	});

	it("resolves only the authenticated provider organization and API key", async () => {
		const db = fixture();
		await provisionProviderInstallation(db, installation());

		await expect(
			resolveActiveProviderInstallation(db, {
				providerOrganizationId: "acme-org",
				providerApiKeyId: "acme-key",
				externalTenantId: "1",
			}),
		).resolves.toMatchObject({ primaryTediId: "globex-operator" });
		await expect(
			resolveActiveProviderInstallation(db, {
				providerOrganizationId: "acme-org",
				providerApiKeyId: "acme-key",
				externalTenantId: "367",
			}),
		).resolves.toBeUndefined();
		await expect(
			resolveActiveProviderInstallation(db, {
				providerOrganizationId: "foreign-org",
				providerApiKeyId: "acme-key",
				externalTenantId: "1",
			}),
		).resolves.toBeUndefined();
	});

	it("fails closed while paused and resumes without changing identity", async () => {
		const db = fixture();
		await provisionProviderInstallation(db, installation());
		await expect(
			setProviderInstallationPaused(db, {
				organizationId: "foreign-org",
				installationId: "installation-1",
				paused: true,
			}),
		).resolves.toBeUndefined();
		await expect(
			resolveActiveProviderInstallation(db, {
				providerOrganizationId: "acme-org",
				providerApiKeyId: "acme-key",
				externalTenantId: "1",
			}),
		).resolves.toMatchObject({ status: "active" });

		await setProviderInstallationPaused(db, {
			organizationId: "acme-org",
			installationId: "installation-1",
			paused: true,
		});

		await expect(
			resolveActiveProviderInstallation(db, {
				providerOrganizationId: "acme-org",
				providerApiKeyId: "acme-key",
				externalTenantId: "1",
			}),
		).resolves.toBeUndefined();
		const resumed = await setProviderInstallationPaused(db, {
			organizationId: "acme-org",
			installationId: "installation-1",
			paused: false,
		});
		expect(resumed).toMatchObject({
			status: "active",
			primaryTediId: "globex-operator",
		});
	});

	it("lets a provider configure only its own installation sponsorship", async () => {
		const db = fixture();
		await provisionProviderInstallation(db, installation());
		const policy = {
			enabled: true,
			budgetRevision: 1,
			maxTransfersPerBudgetDay: 2,
			lowWatermarkTokens: 250_000,
			lowWatermarkSpendMicros: 1_000_000,
			transferTokens: 1_000_000,
			transferSpendMicros: 5_000_000,
		};
		await expect(
			setProviderCapacitySponsorship(db, {
				providerOrganizationId: "foreign-org",
				installationId: "installation-1",
				policy,
			}),
		).resolves.toBeNull();
		await expect(
			setProviderCapacitySponsorship(db, {
				providerOrganizationId: "acme-org",
				installationId: "installation-1",
				policy,
			}),
		).resolves.toMatchObject({
			externalTenantId: "1",
			customerOrganizationId: "globex-org",
			policy,
		});
		await expect(
			listProviderCapacitySponsorships(db, "acme-org"),
		).resolves.toEqual([
			expect.objectContaining({
				installationId: "installation-1",
				policy,
			}),
		]);
		await expect(
			listProviderCapacitySponsorships(db, "foreign-org"),
		).resolves.toEqual([]);
	});

	it("publishes tenant-scoped profile revisions with compare-and-swap history", async () => {
		const db = fixture();
		await provisionProviderInstallation(db, installation());
		const profile = {
			version: 1 as const,
			routes: [
				{
					id: "orders",
					match: { routeKey: "orders" },
					tools: [
						{
							callable: "acme_staging.orders_list",
							name: "orders_list",
							description: "List orders",
							inputSchema: {
								type: "object" as const,
								properties: {},
								additionalProperties: false as const,
							},
							annotations: { readOnlyHint: true as const },
						},
					],
				},
			],
		};
		await expect(
			publishProviderPortableWebMcpProfile(db, {
				providerOrganizationId: "foreign-org",
				installationId: "installation-1",
				expectedRevision: 0,
				profile,
				changeSummary: "Foreign write",
				publishedBy: "user:foreign",
			}),
		).resolves.toBeNull();
		await expect(
			publishProviderPortableWebMcpProfile(db, {
				providerOrganizationId: "acme-org",
				installationId: "installation-1",
				expectedRevision: 0,
				profile,
				changeSummary: "Initial routes",
				publishedBy: "user:owner",
			}),
		).resolves.toMatchObject({ revision: 1, profile });
		await expect(
			publishProviderPortableWebMcpProfile(db, {
				providerOrganizationId: "acme-org",
				installationId: "installation-1",
				expectedRevision: 0,
				profile,
				changeSummary: "Stale update",
				publishedBy: "user:owner",
			}),
		).resolves.toBe("conflict");
		await expect(
			listProviderPortableWebMcpConfigurations(db, "acme-org"),
		).resolves.toEqual([
			expect.objectContaining({
				installationId: "installation-1",
				revision: 1,
				profile,
				history: [expect.objectContaining({ changeSummary: "Initial routes" })],
			}),
		]);
	});
});

describe("widget access persistence", () => {
	it("scopes writes and lists to the provider, preserves provenance, and rejects stale revisions", async () => {
		const db = fixture();
		await provisionProviderInstallation(db, installation());
		const policy = {
			version: 1 as const,
			enabled: false,
			users: "selected" as const,
			allowedUserIds: ["42"],
			deniedUserIds: ["43"],
		};
		expect(
			await updateProviderWidgetAccess(db, {
				organizationId: "foreign",
				installationId: "installation-1",
				expectedRevision: 0,
				policy,
				updatedBy: "admin",
			}),
		).toBeNull();
		expect(await listProviderWidgetInstallations(db, "foreign")).toEqual([]);
		const input = {
			organizationId: "acme-org",
			installationId: "installation-1",
			expectedRevision: 0,
			policy,
			updatedBy: "admin",
		};
		expect(await updateProviderWidgetAccess(db, input)).toMatchObject({
			provenance: {
				pilot: "globex",
				widgetAccess: { revision: 1, policy, updatedBy: "admin" },
			},
		});
		expect(await updateProviderWidgetAccess(db, input)).toBe("conflict");
		const rows = await listProviderWidgetInstallations(db, "acme-org");
		expect(rows[0]?.provenance?.widgetAccessHistory).toHaveLength(1);
	});
});

it("automatic provisioning preserves an existing paused installation", async () => {
	const db = fixture();
	const first = await createProviderInstallationIfAbsent(db, installation());
	await setProviderInstallationPaused(db, {
		organizationId: "acme-org",
		installationId: first.id,
		paused: true,
	});
	const replay = await createProviderInstallationIfAbsent(
		db,
		installation({
			id: "different-id",
			primaryTediId: "wrong-worker",
			provenance: { replacement: true },
		}),
	);
	expect(replay).toMatchObject({
		id: first.id,
		primaryTediId: "globex-operator",
		status: "paused",
		provenance: { pilot: "globex" },
	});
});

it("authorizes secondary workers only in the current installation policy and tenant boundary", async () => {
	const db = fixture();
	const primary = "11111111-1111-4111-8111-111111111111";
	const secondary = "22222222-2222-4222-8222-222222222222";
	await provisionProviderInstallation(
		db,
		installation({ primaryTediId: primary }),
	);
	const input = {
		installationId: "installation-1",
		providerAppId: "acme-api-staging",
		customerOrganizationId: "globex-org",
		externalTenantId: "1",
		allowedOrigin: "https://www.acme.example",
		primaryTediId: secondary,
	};
	await expect(
		resolveActiveProviderInstallationForOutcome(db, input),
	).resolves.toBeUndefined();
	const policy = {
		version: 1 as const,
		enabled: true,
		users: "all" as const,
		allowedUserIds: [],
		deniedUserIds: [],
		tediSelection: {
			defaultTediId: primary,
			allowedTediIds: [primary, secondary],
		},
	};
	await updateProviderWidgetAccess(db, {
		organizationId: "acme-org",
		installationId: input.installationId,
		expectedRevision: 0,
		policy,
		updatedBy: "admin",
	});
	await expect(
		resolveActiveProviderInstallationForOutcome(db, input),
	).resolves.toMatchObject({ id: input.installationId });
	for (const boundary of [
		{ customerOrganizationId: "foreign" },
		{ providerAppId: "foreign" },
		{ externalTenantId: "2" },
		{ allowedOrigin: "https://foreign.test" },
	]) {
		await expect(
			resolveActiveProviderInstallationForOutcome(db, {
				...input,
				...boundary,
			}),
		).resolves.toBeUndefined();
	}
	await updateProviderWidgetAccess(db, {
		organizationId: "acme-org",
		installationId: input.installationId,
		expectedRevision: 1,
		policy: {
			...policy,
			tediSelection: { defaultTediId: primary, allowedTediIds: [primary] },
		},
		updatedBy: "admin",
	});
	await expect(
		resolveActiveProviderInstallationForOutcome(db, input),
	).resolves.toBeUndefined();
});

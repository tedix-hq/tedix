/**
 * Organization features — plan defaults, explicit overrides and the widget
 * quota projection, executed against the D1 facade with real billing rows.
 * `organizations-plan-features.test.ts` covers OS-provisioning preservation
 * across plan changes; this file covers the surrounding read/write contract.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import {
	DEFAULT_ORGANIZATION_FEATURES_BY_PLAN,
	organizations,
} from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	applyOrganizationPlanFeatures,
	getOrganizationById,
	getOrganizationFeatures,
	listOrganizationWidgetQuotaStatus,
	updateOrganizationFeatures,
} from "./organizations";

const NOW = "2026-10-20T12:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

let sqlite: DatabaseSync | undefined;

function setup(): DbClient {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(billingPlanVersions, organizations, billingAccounts));
	return createDbClient(createD1Facade(sqlite));
}

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

const METADATA = {
	contactEmail: "ops@example.test",
	timezone: "Europe/Berlin",
	tediWidget: {
		version: 1 as const,
		turnQuota: { visitorTurnsPerHour: 20, originTurnsPerHour: 500 },
	},
};

async function seedOrganization(db: DbClient, id: string) {
	await db.insert(organizations).values({
		id,
		name: "Fictional Co",
		slug: id,
		descopeTenantId: `T_${id}`,
		features: { os: true, maxApps: 999, customDomain: true },
		metadata: METADATA,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

async function seedStarterAccount(db: DbClient, organizationId: string) {
	await db.insert(billingPlanVersions).values({
		id: "plan-starter-1",
		planKey: "starter",
		version: 1,
		status: "active",
		name: "Starter",
		includedMonthlyTokens: 0,
		maxTedis: 1,
		maxCronJobsPerTedi: 1,
		maxIterationsPerTask: 1,
		defaultDailyTokenLimit: 1,
		defaultDailyMessageLimit: 1,
		effectiveAt: PAST,
		createdAt: PAST,
	});
	await db.insert(billingAccounts).values({
		organizationId,
		planVersionId: "plan-starter-1",
		status: "active",
		billingMode: "stripe",
		periodStart: PAST,
		periodEnd: FUTURE,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

describe("applyOrganizationPlanFeatures", () => {
	it("replaces features with the plan defaults and leaves every other column alone", async () => {
		const db = setup();
		await seedOrganization(db, "org-plan");

		const updated = await applyOrganizationPlanFeatures(
			db,
			"org-plan",
			"growth",
		);

		expect(updated.features).toEqual({
			...DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.growth,
			os: true,
		});
		expect(updated.metadata).toEqual(METADATA);
		expect(updated).toMatchObject({
			name: "Fictional Co",
			slug: "org-plan",
			descopeTenantId: "T_org-plan",
			createdAt: NOW,
		});
		expect(updated.updatedAt).not.toBe(NOW);
	});

	it("throws for an unknown organization", async () => {
		const db = setup();
		await expect(
			applyOrganizationPlanFeatures(db, "org-missing", "starter"),
		).rejects.toThrow("Organization not found: org-missing");
	});
});

describe("updateOrganizationFeatures / getOrganizationFeatures", () => {
	it("round-trips a partial update merged over the plan defaults", async () => {
		const db = setup();
		await seedOrganization(db, "org-features");
		await seedStarterAccount(db, "org-features");

		const updated = await updateOrganizationFeatures(db, "org-features", {
			maxApps: 7,
			sso: true,
		});
		expect(updated.features).toEqual({
			os: true,
			maxApps: 7,
			customDomain: true,
			sso: true,
		});
		expect(updated.metadata).toEqual(METADATA);

		expect(await getOrganizationFeatures(db, "org-features")).toEqual({
			...DEFAULT_ORGANIZATION_FEATURES_BY_PLAN.starter,
			os: true,
			maxApps: 7,
			customDomain: true,
			sso: true,
		});

		await updateOrganizationFeatures(db, "org-features", { maxApps: 2 });
		const features = await getOrganizationFeatures(db, "org-features");
		expect(features?.maxApps).toBe(2);
		expect(features?.sso).toBe(true);
		expect((await getOrganizationById(db, "org-features"))?.features).toEqual({
			os: true,
			maxApps: 2,
			customDomain: true,
			sso: true,
		});
	});

	it("returns null without a billing entitlement and throws on an unknown organization", async () => {
		const db = setup();
		await seedOrganization(db, "org-unbilled");

		expect(await getOrganizationFeatures(db, "org-unbilled")).toBeNull();
		expect(await getOrganizationFeatures(db, "org-missing")).toBeNull();
		await expect(
			updateOrganizationFeatures(db, "org-missing", { maxApps: 1 }),
		).rejects.toThrow("Organization not found: org-missing");
	});
});

describe("listOrganizationWidgetQuotaStatus", () => {
	it("orders by slug and projects only the quota regardless of other metadata", async () => {
		const db = setup();
		await db.insert(organizations).values([
			{
				id: "org-z",
				name: "Zed",
				slug: "zed",
				metadata: METADATA,
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "org-a",
				name: "Alpha",
				slug: "alpha",
				metadata: { ...METADATA, tediWidget: { version: 1 } },
				createdAt: NOW,
				updatedAt: NOW,
			},
		]);

		expect(await listOrganizationWidgetQuotaStatus(db)).toEqual([
			{
				id: "org-a",
				slug: "alpha",
				name: "Alpha",
				visitorTurnsPerHour: null,
				originTurnsPerHour: null,
			},
			{
				id: "org-z",
				slug: "zed",
				name: "Zed",
				visitorTurnsPerHour: 20,
				originTurnsPerHour: 500,
			},
		]);
	});
});

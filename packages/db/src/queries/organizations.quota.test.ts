/**
 * App quota — `canCreateApp` and the app-count maintenance queries, executed
 * against the D1 facade with real billing rows rather than a mocked
 * entitlement. The facade rejects `db.transaction()` and duplicate output
 * column names, so this file also keeps those invariants on every query it
 * touches.
 */

import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apps } from "../schema/apps";
import {
	billingAccounts,
	billingPlanVersions,
	type BillingAccountStatus,
	type BillingPlanKey,
} from "../schema/billing";
import {
	organizations,
	type OrganizationFeatures,
} from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	canCreateApp,
	decrementAppCount,
	incrementAppCount,
	syncAppCount,
} from "./organizations";

const NOW = "2026-10-20T12:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

let sqlite: DatabaseSync | undefined;

function setup(): DbClient {
	sqlite = new DatabaseSync(":memory:");
	// `apps` references catalog tables these queries never read.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(billingPlanVersions, organizations, billingAccounts, apps),
	);
	return createDbClient(createD1Facade(sqlite));
}

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

async function seedPlan(db: DbClient, planKey: BillingPlanKey) {
	const id = `plan-${planKey}-1`;
	await db.insert(billingPlanVersions).values({
		id,
		planKey,
		version: 1,
		status: "active",
		name: planKey,
		includedMonthlyTokens: 0,
		maxTedis: 1,
		maxCronJobsPerTedi: 1,
		maxIterationsPerTask: 1,
		defaultDailyTokenLimit: 1,
		defaultDailyMessageLimit: 1,
		effectiveAt: PAST,
		createdAt: PAST,
	});
	return id;
}

async function seedOrganization(
	db: DbClient,
	input: {
		id: string;
		appsCount?: number;
		features?: OrganizationFeatures | null;
	},
) {
	await db.insert(organizations).values({
		id: input.id,
		name: input.id,
		slug: input.id,
		appsCount: input.appsCount ?? 0,
		features: input.features ?? null,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

async function seedBillingAccount(
	db: DbClient,
	input: {
		organizationId: string;
		planVersionId: string;
		status: BillingAccountStatus;
		periodEnd?: string;
	},
) {
	await db.insert(billingAccounts).values({
		organizationId: input.organizationId,
		planVersionId: input.planVersionId,
		status: input.status,
		billingMode: input.status === "trial" ? "trial" : "stripe",
		periodStart: PAST,
		periodEnd: input.periodEnd ?? FUTURE,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

describe("canCreateApp", () => {
	it("rejects an unknown organization", async () => {
		const db = setup();
		expect(await canCreateApp(db, "org-missing")).toEqual({
			allowed: false,
			reason: "Organization not found",
		});
	});

	it("rejects an organization without a billing account", async () => {
		const db = setup();
		await seedOrganization(db, { id: "org-no-billing" });
		expect(await canCreateApp(db, "org-no-billing")).toEqual({
			allowed: false,
			reason: "Billing account not found",
		});
	});

	it.each(["cancelled", "past_due", "suspended"] as const)(
		"rejects a %s subscription",
		async (status) => {
			const db = setup();
			const plan = await seedPlan(db, "growth");
			await seedOrganization(db, { id: "org-status" });
			await seedBillingAccount(db, {
				organizationId: "org-status",
				planVersionId: plan,
				status,
			});
			expect(await canCreateApp(db, "org-status")).toEqual({
				allowed: false,
				reason: `Subscription is ${status}`,
			});
		},
	);

	it("rejects a trial whose period has ended", async () => {
		const db = setup();
		const plan = await seedPlan(db, "starter");
		await seedOrganization(db, { id: "org-expired-trial" });
		await seedBillingAccount(db, {
			organizationId: "org-expired-trial",
			planVersionId: plan,
			status: "trial",
			periodEnd: PAST,
		});
		expect(await canCreateApp(db, "org-expired-trial")).toEqual({
			allowed: false,
			reason: "Trial has expired",
		});
	});

	it("allows a live trial under its app limit", async () => {
		const db = setup();
		const plan = await seedPlan(db, "starter");
		await seedOrganization(db, { id: "org-trial" });
		await seedBillingAccount(db, {
			organizationId: "org-trial",
			planVersionId: plan,
			status: "trial",
			periodEnd: FUTURE,
		});
		expect(await canCreateApp(db, "org-trial")).toEqual({ allowed: true });
	});

	it("does not apply the trial expiry check to an active subscription", async () => {
		const db = setup();
		const plan = await seedPlan(db, "starter");
		await seedOrganization(db, { id: "org-active-old-period" });
		await seedBillingAccount(db, {
			organizationId: "org-active-old-period",
			planVersionId: plan,
			status: "active",
			periodEnd: PAST,
		});
		expect(await canCreateApp(db, "org-active-old-period")).toEqual({
			allowed: true,
		});
	});

	it("blocks at the limit and reports the counts", async () => {
		const db = setup();
		const plan = await seedPlan(db, "growth");
		await seedOrganization(db, {
			id: "org-at-limit",
			appsCount: 3,
			features: { maxApps: 3 },
		});
		await seedBillingAccount(db, {
			organizationId: "org-at-limit",
			planVersionId: plan,
			status: "active",
		});
		expect(await canCreateApp(db, "org-at-limit")).toEqual({
			allowed: false,
			reason: "App limit reached (3/3). Upgrade to create more apps.",
		});
	});

	it("allows one below the limit", async () => {
		const db = setup();
		const plan = await seedPlan(db, "growth");
		await seedOrganization(db, {
			id: "org-below-limit",
			appsCount: 2,
			features: { maxApps: 3 },
		});
		await seedBillingAccount(db, {
			organizationId: "org-below-limit",
			planVersionId: plan,
			status: "active",
		});
		expect(await canCreateApp(db, "org-below-limit")).toEqual({
			allowed: true,
		});
	});

	it("treats maxApps = -1 as unlimited", async () => {
		const db = setup();
		const plan = await seedPlan(db, "starter");
		await seedOrganization(db, {
			id: "org-unlimited",
			appsCount: 10_000,
			features: { maxApps: -1 },
		});
		await seedBillingAccount(db, {
			organizationId: "org-unlimited",
			planVersionId: plan,
			status: "active",
		});
		expect(await canCreateApp(db, "org-unlimited")).toEqual({
			allowed: true,
		});
	});

	it("falls back to the plan's default limit when features are null", async () => {
		const db = setup();
		const starter = await seedPlan(db, "starter");
		const growth = await seedPlan(db, "growth");
		await seedOrganization(db, {
			id: "org-starter-null",
			appsCount: 1,
			features: null,
		});
		await seedOrganization(db, {
			id: "org-growth-null",
			appsCount: 1,
			features: null,
		});
		await seedBillingAccount(db, {
			organizationId: "org-starter-null",
			planVersionId: starter,
			status: "active",
		});
		await seedBillingAccount(db, {
			organizationId: "org-growth-null",
			planVersionId: growth,
			status: "active",
		});

		expect(await canCreateApp(db, "org-starter-null")).toEqual({
			allowed: false,
			reason: "App limit reached (1/1). Upgrade to create more apps.",
		});
		expect(await canCreateApp(db, "org-growth-null")).toEqual({
			allowed: true,
		});
	});

	it("lets an explicit feature override win over the plan default", async () => {
		const db = setup();
		const plan = await seedPlan(db, "starter");
		await seedOrganization(db, {
			id: "org-override",
			appsCount: 1,
			features: { maxApps: 4 },
		});
		await seedBillingAccount(db, {
			organizationId: "org-override",
			planVersionId: plan,
			status: "active",
		});
		expect(await canCreateApp(db, "org-override")).toEqual({ allowed: true });
	});
});

describe("app count maintenance", () => {
	async function count(db: DbClient, id: string) {
		const [row] = await db
			.select({ appsCount: organizations.appsCount })
			.from(organizations)
			.where(eq(organizations.id, id));
		return row?.appsCount;
	}

	it("increments and decrements, never below zero", async () => {
		const db = setup();
		await seedOrganization(db, { id: "org-count" });
		await seedOrganization(db, { id: "org-other", appsCount: 5 });

		await incrementAppCount(db, "org-count");
		await incrementAppCount(db, "org-count");
		expect(await count(db, "org-count")).toBe(2);

		await decrementAppCount(db, "org-count");
		await decrementAppCount(db, "org-count");
		await decrementAppCount(db, "org-count");
		expect(await count(db, "org-count")).toBe(0);

		expect(await count(db, "org-other")).toBe(5);
	});

	it("recounts from the apps table and only touches the target organization", async () => {
		const db = setup();
		await seedOrganization(db, { id: "org-drifted", appsCount: 7 });
		await seedOrganization(db, { id: "org-neighbour", appsCount: 9 });
		const app = (id: string, organizationId: string) => ({
			id,
			organizationId,
			name: id,
			slug: id,
		});
		await db
			.insert(apps)
			.values([
				app("app-1", "org-drifted"),
				app("app-2", "org-drifted"),
				app("app-3", "org-drifted"),
				app("app-n", "org-neighbour"),
			]);

		expect(await syncAppCount(db, "org-drifted")).toBe(3);
		expect(await count(db, "org-drifted")).toBe(3);
		expect(await count(db, "org-neighbour")).toBe(9);

		expect(await syncAppCount(db, "org-without-apps")).toBe(0);
	});
});

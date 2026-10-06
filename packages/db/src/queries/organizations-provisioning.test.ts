/**
 * Regression cover for the multi-write provisioning paths.
 *
 * These ran through `db.transaction()`, which Drizzle's D1 driver implements by
 * emitting a literal `begin`. Real D1 rejects that with Cloudflare error 7500,
 * so `createOrganization` threw on every call — including Descope just-in-time
 * tenant sync — while passing under permissive in-memory test doubles. The
 * facade here fails on explicit transaction control exactly like production,
 * so a reintroduced `db.transaction()` fails this file instead of the next
 * tenant signup.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { organizations } from "../schema/organizations";
import { organizationMembers } from "../schema/organization-members";
import { principalIdentities } from "../schema/principal-identities";
import { users } from "../schema/users";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { createOrganization } from "./organizations";
import { ensureOrgAndMember } from "./organization-sync";

const NOW = "2026-07-29T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			billingPlanVersions,
			organizations,
			billingAccounts,
			users,
			organizationMembers,
			principalIdentities,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	return { db, sqlite };
}

async function seedStarterPlan(db: ReturnType<typeof setup>["db"]) {
	await db.insert(billingPlanVersions).values({
		id: "plan-starter-1",
		planKey: "starter",
		version: 1,
		status: "active",
		name: "Starter",
		currency: "usd",
		monthlyPriceMicros: 0,
		annualPriceMicros: 0,
		includedMonthlyTokens: 0,
		includedMonthlyCreditMicros: 0,
		overageUnitTokens: 1,
		overageUnitPriceMicros: 0,
		maxTedis: 1,
		maxCronJobsPerTedi: 1,
		maxIterationsPerTask: 1,
		defaultDailyTokenLimit: 1,
		defaultDailyMessageLimit: 1,
		allowOverage: false,
		effectiveAt: NOW,
		createdAt: NOW,
	});
}

describe("createOrganization", () => {
	let context: ReturnType<typeof setup>;

	beforeEach(async () => {
		context = setup();
		await seedStarterPlan(context.db);
	});

	it("provisions the organization and its billing account without a transaction", async () => {
		const org = await createOrganization(
			context.db,
			{
				name: "Acme",
				slug: "Acme",
				descopeTenantId: "T-acme",
			},
			{ settlementMode: "managed" },
		);

		expect(org.slug).toBe("acme");

		const accounts = await context.db.select().from(billingAccounts);
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.organizationId).toBe(org.id);
		expect(accounts[0]?.planVersionId).toBe("plan-starter-1");
		expect(accounts[0]?.status).toBe("trial");
		expect(accounts[0]?.billingMode).toBe("trial");
	});

	it("leaves no organization behind when the plan is missing", async () => {
		context.sqlite.exec("DELETE FROM billing_plan_versions");

		await expect(
			createOrganization(
				context.db,
				{
					name: "Orphan",
					slug: "orphan",
					descopeTenantId: "T-orphan",
				},
				{ settlementMode: "managed" },
			),
		).rejects.toThrow(/Active billing plan not found/);

		const rows = await context.db.select().from(organizations);
		expect(rows).toHaveLength(0);
	});

	it("proves db.transaction() is unusable on D1", async () => {
		// The guard the other cases rely on. If this ever stops throwing, the
		// facade has drifted permissive and the regression it protects against
		// can reach production again.
		await expect(
			context.db.transaction(async (tx) => {
				await tx.select().from(organizations);
			}),
		).rejects.toThrow(/Failed query: begin/);
	});

	it("rolls the organization back when the billing write fails", async () => {
		// A duplicate billing account for the same org id is the failure the batch
		// has to be atomic about: D1 wraps a batch in an implicit transaction, so
		// the organization insert in the same batch must not survive.
		await context.db.insert(organizations).values({
			id: "org-existing",
			name: "Existing",
			slug: "existing",
			createdAt: NOW,
			updatedAt: NOW,
		});

		await expect(
			createOrganization(
				context.db,
				{
					name: "Duplicate",
					slug: "existing",
					descopeTenantId: "T-dupe",
				},
				{ settlementMode: "managed" },
			),
		).rejects.toThrow();

		const rows = await context.db.select().from(organizations);
		expect(rows.map((row) => row.slug)).toEqual(["existing"]);
	});

	it("provisions disabled installations with an active internal backing row", async () => {
		const org = await createOrganization(
			context.db,
			{
				name: "Self hosted",
				slug: "self-hosted",
				descopeTenantId: "T-self-hosted",
			},
			{
				settlementMode: "disabled",
				runtimeEntitlementGrants: [
					{ key: "browser-runtime", status: "active", source: "operator" },
				],
			},
		);
		const [account] = await context.db.select().from(billingAccounts);
		expect(account).toMatchObject({
			organizationId: org.id,
			status: "active",
			billingMode: "internal",
			stripeEnvironment: null,
		});
		expect(account?.metadata).toMatchObject({
			runtimeEntitlementSource: "installation",
			runtimeEntitlementGrants: [
				{ key: "browser-runtime", status: "active", source: "operator" },
			],
		});
	});

	it("binds exact Descope identities to canonical org and user principals", async () => {
		const result = await ensureOrgAndMember(context.db, {
			settlementMode: "managed",
			descopeTenantId: "T-acme",
			descopeUserId: "U-owner",
			identityIssuer: "https://auth.example.test/P-project",
			email: "owner@example.test",
			name: "Owner",
			organizationName: "Acme",
		});

		expect(result.organization.id).not.toBe("T-acme");
		expect(result.user.id).not.toBe("U-owner");
		expect(result.member.userId).toBe(result.user.id);
		const mappings = await context.db.select().from(principalIdentities);
		expect(mappings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					principalType: "organization",
					principalId: result.organization.id,
					subject: "T-acme",
				}),
				expect.objectContaining({
					principalType: "user",
					principalId: result.user.id,
					subject: "U-owner",
				}),
			]),
		);
	});
});

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "./runtime-entitlements";

const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, billingPlanVersions, billingAccounts));
	const db = createDbClient(createD1Facade(sqlite));
	return { db };
}

describe("runtime entitlements", () => {
	it("projects only provider-neutral runtime fields from the temporary backing tables", async () => {
		const { db } = setup();
		await db.insert(organizations).values({
			id: "org-1",
			name: "Acme",
			slug: "acme",
			stripeCustomerId: "cus_must_not_escape",
			createdAt: START,
			updatedAt: START,
		});
		await db.insert(billingPlanVersions).values({
			id: "profile-1",
			planKey: "starter",
			version: 7,
			status: "active",
			name: "Developer",
			includedMonthlyTokens: 100_000,
			overageUnitPriceMicros: 50_000,
			maxTedis: 2,
			maxCronJobsPerTedi: 5,
			maxIterationsPerTask: 12,
			defaultDailyTokenLimit: 20_000,
			defaultDailyMessageLimit: 50,
			effectiveAt: START,
			createdAt: START,
		});
		await db.insert(billingAccounts).values({
			organizationId: "org-1",
			planVersionId: "profile-1",
			status: "active",
			billingMode: "internal",
			periodStart: START,
			periodEnd: END,
			entitlementVersion: 3,
			metadata: {
				runtimeEntitlementSource: "installation",
				runtimeEntitlementGrants: [
					{ key: "browser-runtime", status: "active", source: "operator" },
				],
			},
			createdAt: START,
			updatedAt: START,
		});

		const entitlement = await getRuntimeEntitlement(db, "org-1");
		expect(entitlement).toEqual({
			organizationId: "org-1",
			status: "active",
			effectivePeriod: { startsAt: START, endsAt: END },
			profile: { key: "starter", name: "Developer" },
			limits: {
				includedMonthlyTokens: 100_000,
				maxTedis: 2,
				maxCronJobsPerTedi: 5,
				maxIterationsPerTask: 12,
				defaultDailyTokenLimit: 20_000,
				defaultDailyMessageLimit: 50,
			},
			grants: [
				{ key: "browser-runtime", status: "active", source: "operator" },
			],
			source: "installation",
			version: 3,
		});
		expect(JSON.stringify(entitlement)).not.toMatch(
			/stripe|price|charge|rate/i,
		);
		expect(runtimeEntitlementIsActive(entitlement!, Date.parse(START))).toBe(
			true,
		);
		expect(runtimeEntitlementIsActive(entitlement!, Date.parse(END))).toBe(
			false,
		);
		await expect(getRuntimeEntitlement(db, "missing")).resolves.toBeNull();
	});
});

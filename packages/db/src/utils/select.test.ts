import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { duplicateOutputColumns } from "../test/output-columns";
import { schemaDdl } from "../test/schema-ddl";
import { prefixedColumns } from "./select";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(organizations, billingPlanVersions, billingAccounts));
	return createDbClient(createD1Facade(sqlite));
}

const joined = (db: ReturnType<typeof setup>) =>
	db
		.select({
			account: prefixedColumns(billingAccounts, "account"),
			plan: prefixedColumns(billingPlanVersions, "plan"),
		})
		.from(billingAccounts)
		.innerJoin(
			billingPlanVersions,
			eq(billingAccounts.planVersionId, billingPlanVersions.id),
		);

describe("prefixedColumns", () => {
	it("removes the collision the bare table selection creates", () => {
		const db = setup();

		const unsafe = db
			.select({ account: billingAccounts, plan: billingPlanVersions })
			.from(billingAccounts)
			.innerJoin(
				billingPlanVersions,
				eq(billingAccounts.planVersionId, billingPlanVersions.id),
			);
		expect(duplicateOutputColumns(unsafe.toSQL().sql)).toEqual(
			expect.arrayContaining(["status", "metadata", "created_at"]),
		);

		expect(duplicateOutputColumns(joined(db).toSQL().sql)).toEqual([]);
	});

	it("preserves column decoding, which a bare sql template would lose", async () => {
		const db = setup();
		await db.insert(billingPlanVersions).values({
			id: "plan-1",
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
			maxTedis: 3,
			maxCronJobsPerTedi: 1,
			maxIterationsPerTask: 1,
			defaultDailyTokenLimit: 1,
			defaultDailyMessageLimit: 1,
			allowOverage: true,
			effectiveAt: "2026-01-01",
			createdAt: "2026-01-01",
		});
		await db.insert(billingAccounts).values({
			organizationId: "org-1",
			planVersionId: "plan-1",
			status: "trial",
			billingMode: "trial",
			periodStart: "2026-01-01",
			periodEnd: "2026-02-01",
			metadata: { provisionedWithOrganization: true },
			createdAt: "2026-01-01",
			updatedAt: "2026-01-01",
		});

		const [row] = await joined(db);

		// The fields that would decode from the other table without the prefix.
		expect(row?.account.status).toBe("trial");
		expect(row?.plan.status).toBe("active");
		expect(row?.account.organizationId).toBe("org-1");
		expect(row?.plan.planKey).toBe("starter");

		// mode:"boolean" and mode:"json" survive the aliasing.
		expect(row?.plan.allowOverage).toBe(true);
		expect(row?.account.metadata).toEqual({
			provisionedWithOrganization: true,
		});
	});
});

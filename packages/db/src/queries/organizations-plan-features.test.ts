import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { applyOrganizationPlanFeatures } from "./organizations";

describe("billing plan features preserve OS provisioning", () => {
	it.each([true, false, undefined])(
		"keeps the explicit provisioning value %s through plan changes",
		async (os) => {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec(schemaDdl(organizations));
			const db = createDbClient(createD1Facade(sqlite));
			try {
				await db.insert(organizations).values({
					id: "org-plan-change",
					name: "Plan change",
					slug: "plan-change",
					features: { os, maxApps: 999, customDomain: true },
				});
				for (const tier of ["business", "starter"] as const) {
					const updated = await applyOrganizationPlanFeatures(
						db,
						"org-plan-change",
						tier,
					);
					expect(updated.features?.os).toBe(os);
					expect(updated.features?.maxApps).toBe(tier === "business" ? 15 : 1);
					expect(updated.features?.customDomain).toBe(tier === "business");
				}
			} finally {
				sqlite.close();
			}
		},
	);
});

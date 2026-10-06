import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	organizations,
	type OrganizationMetadata,
} from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { setProviderOnboardingConfiguration } from "./organizations";
const config: NonNullable<OrganizationMetadata["providerOnboarding"]> = {
	enabled: true,
	providerAppId: "app",
	providerApiKeyId: "key",
	allowedOrigin: "https://host.example",
	hostTenantArgument: "companyId",
	hostTenantNamespace: "host",
	ownerUserId: "owner",
	ownerEmail: "owner@example.com",
	billingPlanKey: "business",
	sponsoredCapacity: {
		enabled: false,
		budgetRevision: 1,
		maxTransfersPerBudgetDay: 1,
		lowWatermarkTokens: 0,
		lowWatermarkSpendMicros: 0,
		transferTokens: 0,
		transferSpendMicros: 0,
	},
};
describe("provider onboarding metadata", () => {
	it("updates only the target's protected metadata path and preserves unrelated data", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations));
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(organizations).values([
			{
				id: "provider",
				name: "Provider",
				slug: "provider",
				descopeTenantId: "provider",
				metadata: { industryVertical: "automotive" },
			},
			{ id: "other", name: "Other", slug: "other", descopeTenantId: "other" },
		]);
		await expect(
			setProviderOnboardingConfiguration(db, "provider", config),
		).resolves.toEqual({ id: "provider" });
		await setProviderOnboardingConfiguration(db, "provider", {
			...config,
			enabled: false,
		});
		const rows = await db
			.select({ id: organizations.id, metadata: organizations.metadata })
			.from(organizations);
		expect(rows.find((row) => row.id === "provider")?.metadata).toEqual({
			industryVertical: "automotive",
			providerOnboarding: { ...config, enabled: false },
		});
		expect(
			rows.find((row) => row.id === "other")?.metadata?.providerOnboarding,
		).toBeUndefined();
		await expect(
			setProviderOnboardingConfiguration(db, "missing", config),
		).resolves.toBeNull();
		sqlite.close();
	});
});

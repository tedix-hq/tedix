import { expect, it, vi } from "vite-plus/test";
import { createDbClient, createDbSession } from "@tedix/db/client";
import { estimateProviderCostMicros } from "@tedix/db/queries/billing/reservations";
import {
	publishProviderModelRate,
	resolveDirectProviderUsagePrice,
} from "@tedix/db/queries/billing/provider-model-rates";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { resolveProviderModelRate } from "./provider-model-pricing";

it("shares one rate-table read across default, reservation and direct pricing", async () => {
	const sqlite = createMigratedSqlite();
	const binding = createD1Facade(sqlite);
	const db = createDbClient(binding);
	const identity = {
		provider: "provider",
		modelId: "native/model",
		deploymentScope: "account/region/deployment",
		occurredAt: "2026-10-01T00:00:00.000Z",
	};
	await publishProviderModelRate(db, {
		id: "rate",
		...identity,
		effectiveFrom: identity.occurredAt,
		inputMicrousdPerMillion: 1_000_000,
		outputMicrousdPerMillion: 2_000_000,
		cacheReadMicrousdPerMillion: 0,
		cacheWriteMicrousdPerMillion: 1_000_000,
		currency: "USD",
		evidenceUri: "https://evidence.test/rate",
		evidenceDigest: "a".repeat(64),
		verifiedAt: "2026-09-20T00:00:00.000Z",
		publishedAt: "2026-09-20T01:00:00.000Z",
		publishedBy: "operator",
		changeReason: "reviewed rate",
	});
	const prepare = vi.spyOn(sqlite, "prepare");
	try {
		await Promise.all(
			Array.from({ length: 3 }, async () => {
				expect(
					await resolveProviderModelRate(
						{
							DB: binding,
							TEDIX_FLEET_AUTHORITY_MODE: "co-located",
						},
						identity,
					),
				).toMatchObject({ status: "resolved", rate: { id: "rate" } });
				expect(
					await estimateProviderCostMicros(createDbSession(binding).db, {
						...identity,
						now: identity.occurredAt,
						estimatedInputTokens: 100,
						estimatedOutputTokens: 20,
					}),
				).toBe(140);
				expect(
					await resolveDirectProviderUsagePrice(binding, identity, {
						inputTokens: 100,
						outputTokens: 20,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					}),
				).toMatchObject({
					costUsd: 0.00014,
					rateVersionId: "rate",
					reason: null,
				});
			}),
		);
		expect(
			prepare.mock.calls.filter(([query]) =>
				/provider_model_rate_versions/i.test(query),
			),
		).toHaveLength(1);
	} finally {
		prepare.mockRestore();
		sqlite.close();
	}
});

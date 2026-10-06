import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { type NewProviderModelRateVersionRow } from "../../schema/provider-model-rates";
import { createD1Facade } from "../../test/d1-facade";
import {
	findProviderModelRates,
	listProviderModelRates,
	publishProviderModelRate,
} from "./provider-model-rates";

const optionalExpiryMigration = new URL(
	"../../../drizzle/20261003143639_open-provider-rate-intervals/migration.sql",
	import.meta.url,
);

const removalMigration = new URL(
	"../../../drizzle/20261004092342_remove-provider-rate-expiry/migration.sql",
	import.meta.url,
);

function fixture(migrate = true) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../drizzle/20260920063814_governed_provider_model_rates/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../drizzle/20260926193742_provider-model-context-rates/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	if (migrate) {
		sqlite.exec(readFileSync(optionalExpiryMigration, "utf8"));
		sqlite.exec(readFileSync(removalMigration, "utf8"));
	}
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
function rate(
	overrides: Partial<NewProviderModelRateVersionRow> = {},
): NewProviderModelRateVersionRow {
	return {
		id: crypto.randomUUID(),
		provider: "provider",
		modelId: "native/model",
		deploymentScope: "account/region/deployment",
		inputTokenMin: 0,
		inputTokenMax: null,
		effectiveFrom: "2026-10-01T00:00:00.000Z",

		inputMicrousdPerMillion: 1000000,
		outputMicrousdPerMillion: 2000000,
		cacheReadMicrousdPerMillion: 0,
		cacheWriteMicrousdPerMillion: 1000000,
		currency: "USD",
		evidenceUri: "https://evidence.test/retained",
		evidenceDigest: "a".repeat(64),
		verifiedAt: "2026-09-20T00:00:00.000Z",
		publishedAt: "2026-09-20T01:00:00.000Z",
		publishedBy: "operator",
		changeReason: "reviewed artifact",
		supersedesRateVersionId: null,
		...overrides,
	};
}
const lookup = {
	provider: "provider",
	modelId: "native/model",
	deploymentScope: "account/region/deployment",
	occurredAt: "2026-10-01T00:00:00.000Z",
};

describe("immutable provider rates", () => {
	it("migrates a populated correction chain without losing fields or references", async () => {
		const { sqlite, db } = fixture(false);
		try {
			const original = rate();
			const correction = rate({
				supersedesRateVersionId: original.id,
				inputMicrousdPerMillion: 7,
			});
			const insertLegacy = (row: NewProviderModelRateVersionRow) => {
				sqlite
					.prepare(`INSERT INTO provider_model_rate_versions (
     id, provider, model_id, deployment_scope, input_token_min, input_token_max, effective_from, effective_until,
     input_microusd_per_million, output_microusd_per_million, cache_read_microusd_per_million, cache_write_microusd_per_million,
     currency, evidence_uri, evidence_digest, verified_at, published_at, published_by, change_reason, supersedes_rate_version_id
    ) VALUES (${Array(20).fill("?").join(",")})`)
					.run(
						row.id,
						row.provider,
						row.modelId,
						row.deploymentScope,
						row.inputTokenMin!,
						row.inputTokenMax!,
						row.effectiveFrom,
						"2026-11-01T00:00:00.000Z",
						row.inputMicrousdPerMillion,
						row.outputMicrousdPerMillion,
						row.cacheReadMicrousdPerMillion,
						row.cacheWriteMicrousdPerMillion,
						row.currency,
						row.evidenceUri,
						row.evidenceDigest,
						row.verifiedAt,
						row.publishedAt,
						row.publishedBy,
						row.changeReason,
						row.supersedesRateVersionId!,
					);
			};
			insertLegacy(original);
			insertLegacy(correction);
			const history = [original, correction].sort((a, b) =>
				a.id.localeCompare(b.id),
			);
			sqlite.exec("BEGIN");
			sqlite.exec(readFileSync(optionalExpiryMigration, "utf8"));
			sqlite.exec(readFileSync(removalMigration, "utf8"));
			sqlite.exec("COMMIT");
			expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({
				foreign_keys: 1,
			});
			expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(await listProviderModelRates(db)).toEqual(history);
			expect(await findProviderModelRates(db, lookup)).toEqual([correction]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					occurredAt: "2040-01-01T00:00:00.000Z",
				}),
			).toEqual([correction]);
			expect(
				sqlite
					.prepare("PRAGMA table_info(provider_model_rate_versions)")
					.all()
					.some((row) => row.name === "effective_until"),
			).toBe(false);

			expect(() =>
				sqlite
					.prepare("DELETE FROM provider_model_rate_versions WHERE id = ?")
					.run(original.id),
			).toThrow();
			const open = rate({ modelId: "new/model" });
			expect(await publishProviderModelRate(db, open)).toEqual(open);
		} finally {
			sqlite.close();
		}
	});
	it("keeps an open-ended rate active without renewal", async () => {
		const { sqlite, db } = fixture();
		try {
			const original = rate();
			expect(await publishProviderModelRate(db, original)).toEqual(original);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					occurredAt: "2040-01-01T00:00:00.000Z",
				}),
			).toEqual([original]);
			expect(await publishProviderModelRate(db, rate())).toBeNull();
		} finally {
			sqlite.close();
		}
	});
	it("replaces future prices atomically while retaining earlier event-time prices", async () => {
		const { sqlite, db } = fixture();
		try {
			const original = rate();
			expect(await publishProviderModelRate(db, original)).toEqual(original);
			const replacement = rate({
				effectiveFrom: "2026-10-15T00:00:00.000Z",
				supersedesRateVersionId: original.id,
				inputMicrousdPerMillion: 3,
			});
			const outcomes = await Promise.all([
				publishProviderModelRate(db, replacement),
				publishProviderModelRate(db, {
					...replacement,
					id: crypto.randomUUID(),
				}),
			]);
			expect(outcomes.filter(Boolean)).toHaveLength(1);
			expect(
				await publishProviderModelRate(
					db,
					rate({
						effectiveFrom: "2026-10-05T00:00:00.000Z",
					}),
				),
			).toBeNull();
			expect(await findProviderModelRates(db, lookup)).toEqual([original]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					occurredAt: replacement.effectiveFrom,
				}),
			).toEqual([replacement]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					occurredAt: "2040-01-01T00:00:00.000Z",
				}),
			).toEqual([replacement]);
			const correction = rate({
				...replacement,
				id: crypto.randomUUID(),
				supersedesRateVersionId: replacement.id,
				inputMicrousdPerMillion: 4,
			});
			expect(await publishProviderModelRate(db, correction)).toEqual(
				correction,
			);
			expect(await findProviderModelRates(db, lookup)).toEqual([original]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					occurredAt: replacement.effectiveFrom,
				}),
			).toEqual([correction]);
			expect(
				(await listProviderModelRates(db)).find(
					(row) => row.id === original.id,
				),
			).toEqual(original);
		} finally {
			sqlite.close();
		}
	});
	it("selects adjacent context classes from total prompt tokens", async () => {
		const { sqlite, db } = fixture();
		try {
			const short = rate({ inputTokenMin: 0, inputTokenMax: 272001 });
			const long = rate({ inputTokenMin: 272001, inputTokenMax: null });
			expect(await publishProviderModelRate(db, short)).toEqual(short);
			expect(await publishProviderModelRate(db, long)).toEqual(long);
			expect(
				await publishProviderModelRate(
					db,
					rate({ inputTokenMin: 272000, inputTokenMax: null }),
				),
			).toBeNull();
			for (const [inputTokens, expected] of [
				[0, short.id],
				[272000, short.id],
				[272001, long.id],
			] as const)
				expect(
					(await findProviderModelRates(db, { ...lookup, inputTokens }))[0]?.id,
				).toBe(expected);
			expect(
				await publishProviderModelRate(
					db,
					rate({ supersedesRateVersionId: short.id, inputTokenMin: 272001 }),
				),
			).toBeNull();
		} finally {
			sqlite.close();
		}
	});
	it("retains reviewed fields, explicit zero and start-based event-time resolution", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(await findProviderModelRates(db, lookup)).toEqual([]);
			const input = rate();
			expect(await publishProviderModelRate(db, input)).toEqual(input);
			expect(
				(await findProviderModelRates(db, lookup)).map((row) => row.id),
			).toEqual([input.id]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					occurredAt: "2040-01-01T00:00:00.000Z",
				}),
			).toEqual([input]);
			expect(
				await findProviderModelRates(db, { ...lookup, provider: "other" }),
			).toEqual([]);
			expect(
				await findProviderModelRates(db, { ...lookup, modelId: "model" }),
			).toEqual([]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					deploymentScope: "other",
				}),
			).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
	it("fences duplicate publications, allows explicit replacements and paginates history", async () => {
		const { sqlite, db } = fixture();
		try {
			const outcomes = await Promise.all([
				publishProviderModelRate(db, rate()),
				publishProviderModelRate(db, rate()),
			]);
			expect(outcomes.filter(Boolean)).toHaveLength(1);
			const original = outcomes.find(Boolean)!;
			const replacement = rate({
				effectiveFrom: "2026-11-01T00:00:00.000Z",
				supersedesRateVersionId: original.id,
			});
			expect(
				await publishProviderModelRate(db, {
					...replacement,
					supersedesRateVersionId: null,
				}),
			).toBeNull();
			expect(await publishProviderModelRate(db, replacement)).toEqual(
				replacement,
			);
			const first = await listProviderModelRates(db, { limit: 1 });
			const second = await listProviderModelRates(db, {
				limit: 1,
				afterId: first[0]!.id,
			});
			expect(second).toHaveLength(1);
			expect(second[0]!.id).not.toBe(first[0]!.id);
		} finally {
			sqlite.close();
		}
	});
	it("corrects only an exact current leaf without changing historical versions", async () => {
		const { sqlite, db } = fixture();
		try {
			const original = rate();
			await publishProviderModelRate(db, original);
			expect(
				await publishProviderModelRate(
					db,
					rate({ supersedesRateVersionId: original.id, modelId: "other" }),
				),
			).toBeNull();
			expect(
				await publishProviderModelRate(
					db,
					rate({
						supersedesRateVersionId: original.id,
						effectiveFrom: "2026-09-01T00:00:00.000Z",
					}),
				),
			).toBeNull();
			const correction = rate({
				supersedesRateVersionId: original.id,
				inputMicrousdPerMillion: 0,
				publishedAt: "2026-12-01T00:00:00.000Z",
			});
			const outcomes = await Promise.all([
				publishProviderModelRate(db, correction),
				publishProviderModelRate(db, {
					...correction,
					id: crypto.randomUUID(),
				}),
			]);
			expect(outcomes.filter(Boolean)).toHaveLength(1);
			expect((await findProviderModelRates(db, lookup))[0]?.id).toBe(
				correction.id,
			);
			expect(
				(await listProviderModelRates(db)).find(
					(row) => row.id === original.id,
				),
			).toEqual(original);
			expect(
				await publishProviderModelRate(
					db,
					rate({ supersedesRateVersionId: original.id }),
				),
			).toBeNull();
		} finally {
			sqlite.close();
		}
	});
	it("rejects past ordinary publication and future verification; enforces rate bounds in D1", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(
				await publishProviderModelRate(
					db,
					rate({ publishedAt: "2026-12-01T00:00:00.000Z" }),
				),
			).toBeNull();
			expect(
				await publishProviderModelRate(
					db,
					rate({ verifiedAt: "2027-01-01T00:00:00.000Z" }),
				),
			).toBeNull();
			for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
				await expect(
					publishProviderModelRate(
						db,
						rate({ inputMicrousdPerMillion: amount }),
					),
				).rejects.toThrow();
			}
			expect(await listProviderModelRates(db)).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
	it("rejects malformed start timestamps in the generated D1 schema", async () => {
		const { sqlite, db } = fixture();
		try {
			const original = rate();
			await publishProviderModelRate(db, original);
			expect(() =>
				sqlite
					.prepare(
						"UPDATE provider_model_rate_versions SET effective_from = ? WHERE id = ?",
					)
					.run("invalid", original.id),
			).toThrow();
			expect((await listProviderModelRates(db))[0]).toEqual(original);
		} finally {
			sqlite.close();
		}
	});
	it("separates exact deployment scopes and rejects empty-scope publication/storage", async () => {
		const { sqlite, db } = fixture();
		try {
			const exact = rate();
			const other = rate({
				deploymentScope: "another-account/region/deployment",
			});
			await publishProviderModelRate(db, exact);
			await publishProviderModelRate(db, other);
			expect(
				(await findProviderModelRates(db, lookup)).map((row) => row.id),
			).toEqual([exact.id]);
			expect(
				await findProviderModelRates(db, {
					...lookup,
					deploymentScope: "missing-account",
				}),
			).toEqual([]);
			for (const deploymentScope of ["", "   ", "\t\n"]) {
				expect(
					await publishProviderModelRate(db, rate({ deploymentScope })),
				).toBeNull();
				expect(
					await findProviderModelRates(db, { ...lookup, deploymentScope }),
				).toEqual([]);
				expect(() =>
					sqlite
						.prepare(
							"UPDATE provider_model_rate_versions SET deployment_scope = ? WHERE id = ?",
						)
						.run(deploymentScope, exact.id),
				).toThrow();
			}
			expect(await listProviderModelRates(db)).toHaveLength(2);
		} finally {
			sqlite.close();
		}
	});
	it("resolves the latest correction leaf while retaining the whole exact-key chain", async () => {
		const { sqlite, db } = fixture();
		try {
			const original = rate();
			await publishProviderModelRate(db, original);
			const correctionA = rate({
				supersedesRateVersionId: original.id,
				inputMicrousdPerMillion: 2,
			});
			await publishProviderModelRate(db, correctionA);
			for (const mismatch of [
				{ provider: "other-provider" },
				{ deploymentScope: "other-scope" },
			]) {
				expect(
					await publishProviderModelRate(
						db,
						rate({ supersedesRateVersionId: correctionA.id, ...mismatch }),
					),
				).toBeNull();
			}
			const correctionB = rate({
				supersedesRateVersionId: correctionA.id,
				inputMicrousdPerMillion: 3,
			});
			expect(await publishProviderModelRate(db, correctionB)).toEqual(
				correctionB,
			);
			expect(
				await publishProviderModelRate(
					db,
					rate({ supersedesRateVersionId: correctionA.id }),
				),
			).toBeNull();
			expect(await findProviderModelRates(db, lookup)).toEqual([correctionB]);
			const history = await listProviderModelRates(db);
			expect(history).toHaveLength(3);
			for (const expected of [original, correctionA, correctionB])
				expect(history.find((row) => row.id === expected.id)).toEqual(expected);
		} finally {
			sqlite.close();
		}
	});
});

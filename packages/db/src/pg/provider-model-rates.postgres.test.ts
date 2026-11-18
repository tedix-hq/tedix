import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vite-plus/test";
import * as sqliteRates from "../queries/billing/provider-model-rates";
import { createDbQueryClient } from "../query-client";
import { providerModelRateVersions as sqliteTable } from "../schema/provider-model-rates";
import { createD1Facade } from "../test/d1-facade";
import * as rates from "./queries/billing/provider-model-rates";
import {
	providerModelRateVersions,
	type NewProviderModelRateVersionRow,
} from "./schema/provider-model-rates";

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
		inputMicrousdPerMillion: 1_000_000,
		outputMicrousdPerMillion: 2_000_000,
		cacheReadMicrousdPerMillion: 0,
		cacheWriteMicrousdPerMillion: 1_000_000,
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
const usage = {
	inputTokens: 7,
	outputTokens: 3,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
};

describe("Postgres provider model rates", () => {
	const pg = new PGlite();
	const db = drizzle({ client: pg });
	let sqlite: DatabaseSync;
	let sqliteDb: ReturnType<typeof createDbQueryClient>;
	beforeAll(async () => {
		const root = new URL("../../drizzle-pg/", import.meta.url);
		for (const directory of (await readdir(root))
			.filter((name) => /^\d{14}_/.test(name))
			.sort()) {
			const migration = await readFile(
				new URL(`${directory}/migration.sql`, root),
				"utf8",
			);
			await pg.exec(migration);
		}
	});
	beforeEach(async () => {
		await pg.exec("TRUNCATE provider_model_rate_versions CASCADE");
		sqlite?.close();
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON");
		for (const directory of [
			"20260920063814_governed_provider_model_rates",
			"20260926193742_provider-model-context-rates",
			"20261003143639_open-provider-rate-intervals",
			"20261004092342_remove-provider-rate-expiry",
		]) {
			sqlite.exec(
				readFileSync(
					new URL(`../../drizzle/${directory}/migration.sql`, import.meta.url),
					"utf8",
				),
			);
		}
		sqliteDb = createDbQueryClient(createD1Facade(sqlite));
	});
	afterAll(async () => {
		sqlite?.close();
		await pg.close();
	});
	async function publish(input: NewProviderModelRateVersionRow) {
		const actual = await rates.publishProviderModelRate(db, input);
		expect(actual).toEqual(
			await sqliteRates.publishProviderModelRate(sqliteDb, input),
		);
		return actual;
	}
	async function find(
		input: Parameters<typeof rates.findProviderModelRates>[1] = lookup,
	) {
		const actual = await rates.findProviderModelRates(db, input);
		expect(actual).toEqual(
			await sqliteRates.findProviderModelRates(sqliteDb, input),
		);
		return actual;
	}
	async function price(identity = lookup, counts = usage) {
		const actual = await rates.resolveDirectProviderUsagePrice(
			db,
			identity,
			counts,
		);
		expect(actual).toEqual(
			await sqliteRates.resolveDirectProviderUsagePrice(
				sqliteDb,
				identity,
				counts,
			),
		);
		return actual;
	}

	it("fences duplicate publication and retains exact history pagination", async () => {
		const first = rate({ id: "a" });
		expect(await publish(first)).toEqual(first);
		expect(await publish(first)).toBeNull();
		expect(await publish(rate({ id: "overlap" }))).toBeNull();
		const other = rate({ id: "b", deploymentScope: "another-account" });
		expect(await publish(other)).toEqual(other);
		expect(await find()).toEqual([first]);
		expect(
			await find({ ...lookup, occurredAt: "2040-01-01T00:00:00.000Z" }),
		).toEqual([first]);
		for (const input of [
			{ limit: 1 },
			{ afterId: "a", limit: 1 },
			{ provider: "missing" },
			{ modelId: "missing" },
			{ limit: 0 },
			{ limit: 500 },
		]) {
			expect(await rates.listProviderModelRates(db, input)).toEqual(
				await sqliteRates.listProviderModelRates(sqliteDb, input),
			);
		}
	});

	it("admits one competing publication and one correction without changing historical rows", async () => {
		const inputs = [rate({ id: "original-a" }), rate({ id: "original-b" })];
		const outcomes = await Promise.all(
			inputs.map((input) => rates.publishProviderModelRate(db, input)),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		const original = outcomes.find((row) => row !== null)!;
		expect(
			await sqliteRates.publishProviderModelRate(sqliteDb, original),
		).toEqual(original);
		const replacement = rate({
			id: "replacement",
			supersedesRateVersionId: original.id,
			effectiveFrom: "2026-10-15T00:00:00.000Z",
			inputMicrousdPerMillion: 3,
		});
		expect(await publish(replacement)).toEqual(replacement);
		expect(await find()).toEqual([original]);
		expect(
			await find({ ...lookup, occurredAt: replacement.effectiveFrom }),
		).toEqual([replacement]);
		const correction = rate({
			...replacement,
			id: "correction",
			supersedesRateVersionId: replacement.id,
			publishedAt: "2026-12-01T00:00:00.000Z",
			inputMicrousdPerMillion: 0,
		});
		const corrected = await Promise.all(
			[correction, { ...correction, id: "competing-correction" }].map((input) =>
				rates.publishProviderModelRate(db, input),
			),
		);
		expect(corrected.filter(Boolean)).toHaveLength(1);
		const leaf = corrected.find((row) => row !== null)!;
		expect(await sqliteRates.publishProviderModelRate(sqliteDb, leaf)).toEqual(
			leaf,
		);
		expect(
			await find({ ...lookup, occurredAt: replacement.effectiveFrom }),
		).toEqual([leaf]);
		expect(await find()).toEqual([original]);
		expect(
			await publish(rate({ supersedesRateVersionId: original.id })),
		).toBeNull();
		expect(await rates.listProviderModelRates(db)).toEqual(
			await sqliteRates.listProviderModelRates(sqliteDb),
		);
		expect(
			(await rates.listProviderModelRates(db)).find(
				(row) => row.id === original.id,
			),
		).toEqual(original);
	});

	it("rejects unreviewed starts, invalid classes, and corrections to a different key or interval", async () => {
		for (const overrides of [
			{ publishedAt: "2026-12-01T00:00:00.000Z" },
			{ verifiedAt: "2027-01-01T00:00:00.000Z" },
			{ deploymentScope: "\t\n " },
			{ inputTokenMin: -1 },
			{ inputTokenMin: 0.5 },
			{ inputTokenMax: 0 },
			{ inputTokenMax: 1.5 },
			{ inputTokenMax: Number.MAX_SAFE_INTEGER + 1 },
		])
			expect(await publish(rate(overrides))).toBeNull();
		const original = rate();
		await publish(original);
		for (const overrides of [
			{ provider: "other" },
			{ modelId: "other" },
			{ deploymentScope: "other" },
			{ inputTokenMin: 1 },
			{ inputTokenMax: 100 },
			{ effectiveFrom: "2026-09-01T00:00:00.000Z" },
			{
				effectiveFrom: "2026-10-02T00:00:00.000Z",
				publishedAt: "2026-12-01T00:00:00.000Z",
			},
			{ supersedesRateVersionId: "missing" },
		])
			expect(
				await publish(
					rate({ supersedesRateVersionId: original.id, ...overrides }),
				),
			).toBeNull();
		expect(await find()).toEqual([original]);
	});

	it("selects adjacent token classes and lists only effective correction leaves", async () => {
		const short = rate({ id: "short", inputTokenMax: 272001 });
		const long = rate({ id: "long", inputTokenMin: 272001 });
		await publish(short);
		await publish(long);
		expect(await publish(rate({ inputTokenMin: 272000 }))).toBeNull();
		for (const [inputTokens, expected] of [
			[0, short],
			[272000, short],
			[272001, long],
		] as const) {
			expect(await find({ ...lookup, inputTokens })).toEqual([expected]);
		}
		const correction = rate({
			...short,
			id: "corrected-short",
			supersedesRateVersionId: short.id,
		});
		await publish(correction);
		await publish(
			rate({ modelId: "future", effectiveFrom: "2027-01-01T00:00:00.000Z" }),
		);
		await publish(rate({ deploymentScope: "other" }));
		const effective = await rates.listEffectiveProviderModelRates(db, lookup);
		const sqliteEffective = await sqliteRates.listEffectiveProviderModelRates(
			sqliteDb,
			lookup,
		);
		expect(effective.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
			sqliteEffective.sort((a, b) => a.id.localeCompare(b.id)),
		);
		expect(effective.map((row) => row.id).sort()).toEqual(
			[correction.id, long.id].sort(),
		);
	});

	it("reports missing and ambiguous prices without fabricating a charge", async () => {
		expect(await price()).toEqual({
			costUsd: null,
			rateVersionId: null,
			reason: "missing_rate",
		});
		const original = rate({ id: "original" });
		await publish(original);
		for (const identity of [
			{ ...lookup, deploymentScope: "other" },
			{ ...lookup, deploymentScope: " " },
			{ ...lookup, occurredAt: "2026-09-01T00:00:00.000Z" },
		]) {
			expect((await price(identity)).reason).toBe("missing_rate");
		}
		// Existing conflicting evidence must remain ambiguous instead of choosing a row.
		const conflict = rate({ id: "conflict" });
		await db.insert(providerModelRateVersions).values(conflict);
		await sqliteDb.insert(sqliteTable).values(conflict);
		expect(await find()).toHaveLength(2);
		expect(await price()).toEqual({
			costUsd: null,
			rateVersionId: null,
			reason: "ambiguous_rate",
		});
	});

	it("rounds the summed token partitions once with exact integer arithmetic", async () => {
		const input = rate({
			inputMicrousdPerMillion: 333333,
			outputMicrousdPerMillion: 2000001,
			cacheReadMicrousdPerMillion: 17,
			cacheWriteMicrousdPerMillion: 999999,
		});
		await publish(input);
		// 4*333333 + 3*2000001 + 2*17 + 999999 = 8333368; ceil gives 9 micros.
		expect(await price()).toEqual({
			costUsd: 0.000009,
			rateVersionId: input.id,
			reason: null,
		});
		expect(
			(
				await price(lookup, {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				})
			).costUsd,
		).toBe(0);
		expect(
			(
				await price(lookup, {
					inputTokens: 1,
					outputTokens: 0,
					cacheReadTokens: 1,
					cacheWriteTokens: 0,
				})
			).costUsd,
		).toBe(0.000001);
		const free = rate({
			...input,
			id: "free",
			supersedesRateVersionId: input.id,
			inputMicrousdPerMillion: 0,
			outputMicrousdPerMillion: 0,
			cacheReadMicrousdPerMillion: 0,
			cacheWriteMicrousdPerMillion: 0,
		});
		await publish(free);
		expect((await price()).costUsd).toBe(0);
	});

	it("rejects invalid usage and prices beyond the safe integer range", async () => {
		for (const counts of [
			{ ...usage, inputTokens: -1 },
			{ ...usage, outputTokens: 0.5 },
			{ ...usage, cacheReadTokens: 8 },
			{ ...usage, cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			expect(await price(lookup, counts)).toEqual({
				costUsd: null,
				rateVersionId: null,
				reason: "invalid_usage",
			});
		}
		expect(
			await rates.resolveDirectProviderUsagePrice(db, lookup, {
				...usage,
				inputTokens: null,
			}),
		).toEqual(
			await sqliteRates.resolveDirectProviderUsagePrice(sqliteDb, lookup, {
				...usage,
				inputTokens: null,
			}),
		);
		const input = rate({ inputMicrousdPerMillion: Number.MAX_SAFE_INTEGER });
		await publish(input);
		expect(
			await price(lookup, {
				inputTokens: Number.MAX_SAFE_INTEGER,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		).toEqual({
			costUsd: null,
			rateVersionId: input.id,
			reason: "invalid_usage",
		});
	});
});

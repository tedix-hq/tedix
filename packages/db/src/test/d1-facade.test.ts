import { DatabaseSync } from "node:sqlite";
import { eq, getColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { prefixedColumns } from "../utils/select";
import { createD1Facade, D1_MAX_LIKE_PATTERN_BYTES } from "./d1-facade";
import { duplicateOutputColumns, outputColumnNames } from "./output-columns";
import { schemaDdl } from "./schema-ddl";

describe("D1 facade: LIKE/GLOB pattern cap", () => {
	let d1: D1Database;

	beforeEach(() => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
		sqlite.prepare("INSERT INTO t (title) VALUES (?)").run("x".repeat(80));
		d1 = createD1Facade(sqlite);
	});

	it("rejects a bound pattern over 50 bytes the way D1 does", () => {
		const pattern = `%${"x".repeat(D1_MAX_LIKE_PATTERN_BYTES - 1)}%`;
		expect(() =>
			d1
				.prepare("SELECT id FROM t WHERE title LIKE ? ESCAPE '\\'")
				.bind(pattern),
		).toThrow(/D1_ERROR: LIKE or GLOB pattern too complex/);
	});

	it("rejects an oversized literal pattern at prepare time", () => {
		expect(() =>
			d1.prepare(`SELECT id FROM t WHERE title GLOB '${"x".repeat(51)}'`),
		).toThrow(/D1_ERROR: LIKE or GLOB pattern too complex/);
	});

	it("counts bytes, not characters", () => {
		// 26 two-byte characters: under the cap by length, over it by bytes.
		const pattern = "é".repeat(26);
		expect(() =>
			d1.prepare("SELECT id FROM t WHERE title LIKE ?").bind(pattern),
		).toThrow(/52 bytes/);
	});

	it("accepts a pattern at the cap and ignores non-pattern parameters", async () => {
		const pattern = `%${"x".repeat(D1_MAX_LIKE_PATTERN_BYTES - 2)}%`;
		const result = await d1
			.prepare("SELECT id FROM t WHERE id >= ? AND title LIKE ? AND title <> ?")
			.bind(0, pattern, "y".repeat(500))
			.all();
		expect(result.results).toHaveLength(1);
	});

	it("leaves instr() substring matches uncapped", async () => {
		const result = await d1
			.prepare("SELECT id FROM t WHERE instr(title, ?) > 0")
			.bind("x".repeat(80))
			.all();
		expect(result.results).toHaveLength(1);
	});

	it("rechecks bindings and runs prepare hooks for repeated SQL without sharing bound values", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(
				"CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO t VALUES (1,'first'),(2,'second')",
			);
			let prepares = 0;
			const facade = createD1Facade(sqlite, {
				maxBoundParams: 1,
				onPrepare() {
					prepares++;
				},
			});
			const query = "select id from t where title LIKE ?";
			const first = facade.prepare(query).bind("first");
			const second = facade.withSession().prepare(query).bind("second");
			expect((await first.all()).results).toEqual([{ id: 1 }]);
			expect((await second.all()).results).toEqual([{ id: 2 }]);
			expect(() => facade.prepare(query).bind("x".repeat(51))).toThrow(
				/LIKE or GLOB pattern too complex/,
			);
			expect(() => facade.prepare(query).bind("first", "second")).toThrow(
				/too many SQL variables/,
			);
			expect(prepares).toBe(4);
			expect(() => facade.prepare("select id, id from t")).toThrow(
				/duplicate output column/,
			);
			sqlite.exec("DROP TABLE t");
			expect(() => facade.prepare(query)).toThrow(/no such table/);
		} finally {
			sqlite.close();
		}
	});
});

const db = createDbClient({} as D1Database);

describe("outputColumnNames", () => {
	it("reads unaliased and aliased columns alike", () => {
		expect(
			outputColumnNames(
				'select "a"."id", "b"."name" as "bName", count(*) as "n" from "a"',
			),
		).toEqual(["id", "bName", "n"]);
	});

	it("ignores commas inside function calls", () => {
		expect(
			outputColumnNames(
				'select coalesce("a"."x", "a"."y") as "z", "a"."id" from "a"',
			),
		).toEqual(["z", "id"]);
	});

	it("reports nothing for a statement with no select list", () => {
		expect(outputColumnNames('insert into "a" ("id") values (?)')).toEqual([]);
	});
});

describe("duplicate detection", () => {
	it("passes the explicitly projected getActiveFacts join", () => {
		const safe = db
			.select({
				...getColumns(memoryFacts),
				domainName: memoryDomains.name,
				domainDescription: memoryDomains.description,
			})
			.from(memoryFacts)
			.leftJoin(memoryDomains, eq(memoryFacts.domainId, memoryDomains.id));

		expect(duplicateOutputColumns(safe.toSQL().sql)).toEqual([]);
	});

	it("catches an explicit projection that reaches for id on both tables", () => {
		// Not a star select — the failure is about colliding output names, and
		// Drizzle emits no aliases, so the TS keys do not save this.
		const dangerous = db
			.select({
				factId: memoryFacts.id,
				domainId: memoryDomains.id,
			})
			.from(memoryFacts)
			.leftJoin(memoryDomains, eq(memoryFacts.domainId, memoryDomains.id));

		expect(duplicateOutputColumns(dangerous.toSQL().sql)).toEqual(["id"]);
	});
});

describe("the facade enforces this on every query a test runs", () => {
	it("rejects a colliding select before it can return wrong rows", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations, organizationMembers));
		const db = createDbClient(createD1Facade(sqlite));

		// Drizzle wraps the driver error, so the facade's own message — the one
		// that names the offending columns and the fix — lands on `cause`.
		const error = await db
			.select()
			.from(organizations)
			.innerJoin(
				organizationMembers,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.then(
				() => null,
				(caught: Error) => caught,
			);

		expect(error).toBeInstanceOf(Error);
		expect((error?.cause as Error | undefined)?.message).toMatch(
			/duplicate output column name\(s\): id, name, created_at, updated_at/,
		);
	});

	it("can be opted out of for a test that builds one deliberately", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations, organizationMembers));
		const db = createDbClient(
			createD1Facade(sqlite, { rejectDuplicateOutputColumns: false }),
		);

		await expect(
			db
				.select()
				.from(organizations)
				.innerJoin(
					organizationMembers,
					eq(organizations.id, organizationMembers.organizationId),
				),
		).resolves.toEqual([]);
	});
});

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
			maxTedis: 3,
			maxCronJobsPerTedi: 1,
			maxIterationsPerTask: 1,
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

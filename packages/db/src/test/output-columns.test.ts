import { DatabaseSync } from "node:sqlite";
import { eq, getColumns } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "./d1-facade";
import { duplicateOutputColumns, outputColumnNames } from "./output-columns";
import { schemaDdl } from "./schema-ddl";

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
	it("catches the star-select join that corrupted getPersonalOrganization", () => {
		const dangerous = db
			.select()
			.from(organizations)
			.innerJoin(
				organizationMembers,
				eq(organizations.id, organizationMembers.organizationId),
			);

		// The exact fields that decoded from the wrong table in production.
		expect(duplicateOutputColumns(dangerous.toSQL().sql)).toEqual(
			expect.arrayContaining(["id", "name", "created_at", "updated_at"]),
		);
	});

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

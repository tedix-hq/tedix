import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decryptAppSecret,
	decryptSecret,
	encryptAppSecret,
	encryptSecret,
	generateMasterKey,
} from "../../packages/db/src/utils/secrets-encryption";
import {
	type D1Runner,
	type D1StatementResult,
	ENCRYPTED_TABLES,
	localRotationCommand,
	parseCli,
	remoteDatabaseId,
	rotateAll,
	rotateTable,
} from "./rotate-master-key";

const newKey = generateMasterKey();
const oldKey = generateMasterKey();
const lostKey = generateMasterKey();
const orgTable = ENCRYPTED_TABLES[0]!;
const appTable = ENCRYPTED_TABLES[1]!;

describe("rotation transport", () => {
	const id = "00000000-0000-4000-8000-000000000001";

	test("resolves binding and resource names to the same explicit D1 UUID", () => {
		const directory = mkdtempSync(join(tmpdir(), "rotation-target-"));
		const config = join(directory, "wrangler.jsonc");
		try {
			writeFileSync(
				config,
				JSON.stringify({
					d1_databases: [
						{
							binding: "DB",
							database_name: "example-database",
							database_id: id,
						},
					],
				}),
			);
			expect(remoteDatabaseId(config, "DB")).toBe(id);
			expect(remoteDatabaseId(config, "example-database")).toBe(id);
			expect(() => remoteDatabaseId(config, "OTHER")).toThrow("exactly one");
			writeFileSync(
				config,
				JSON.stringify({
					d1_databases: [
						{ binding: "DB", database_id: id },
						{
							database_name: "DB",
							database_id: "00000000-0000-4000-8000-000000000002",
						},
					],
				}),
			);
			expect(() => remoteDatabaseId(config, "DB")).toThrow("exactly one");
			for (const database_id of [
				undefined,
				"placeholder",
				"00000000-0000-0000-0000-000000000000",
			]) {
				writeFileSync(
					config,
					JSON.stringify({ d1_databases: [{ binding: "DB", database_id }] }),
				);
				expect(() => remoteDatabaseId(config, "DB")).toThrow(
					"configured D1 database UUID",
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a remote database UUID needs no Wrangler binding lookup", () => {
		expect(remoteDatabaseId("/missing/config.jsonc", id)).toBe(id);
	});

	test("local rotation keeps its explicit Wrangler target", () => {
		const args = parseCli(["--local"]);
		const command = localRotationCommand(args, "DB");
		expect(command[0]).toEndWith("/node_modules/.bin/wrangler");
		expect(command.slice(1)).toEqual([
			"d1",
			"execute",
			"DB",
			"--local",
			"--config",
			args.config,
			"--json",
			"--command",
		]);
	});
});

type Row = { id: string; salt: string; value: string };

/**
 * In-memory D1 that understands exactly the two statement shapes the script
 * emits: the keyset SELECT and the optimistic UPDATE.
 */
function fakeD1(tables: Record<string, Row[]>): {
	run: D1Runner;
	statements: string[];
} {
	const statements: string[] = [];
	const run: D1Runner = async (sql) => {
		const results: D1StatementResult[] = [];
		for (const statement of sql.split(";\n")) {
			statements.push(statement);
			const select = statement.match(
				/^SELECT id, (\w+) AS salt, (\w+) AS value FROM (\w+) WHERE .*?(?:id > '([^']*)')? ORDER BY id LIMIT (\d+)$/,
			);
			if (select) {
				const [, , , table, afterId, limit] = select;
				const rows = (tables[table!] ?? [])
					.filter((r) => afterId === undefined || r.id > afterId)
					.sort((a, b) => (a.id < b.id ? -1 : 1))
					.slice(0, Number(limit));
				results.push({ results: rows });
				continue;
			}
			const update = statement.match(
				/^UPDATE (\w+) SET \w+ = '([^']*)' WHERE id = '([^']*)' AND \w+ = '([^']*)'$/,
			);
			if (update) {
				const [, table, next, id, previous] = update;
				const row = (tables[table!] ?? []).find(
					(r) => r.id === id && r.value === previous,
				);
				if (row) row.value = next!;
				results.push({ results: [], meta: { changes: row ? 1 : 0 } });
				continue;
			}
			throw new Error(`fake D1 cannot run: ${statement}`);
		}
		return results;
	};
	return { run, statements };
}

describe("rotate-master-key", () => {
	test("all rows readable with key[0]: nothing to do", async () => {
		const rows = [
			{
				id: "s1",
				salt: "org_a",
				value: await encryptSecret(newKey, "org_a", "a"),
			},
			{
				id: "s2",
				salt: "org_b",
				value: await encryptSecret(newKey, "org_b", "b"),
			},
		];
		const db = fakeD1({ organization_secrets: rows });
		const report = await rotateTable(db.run, orgTable, {
			keys: [newKey, oldKey],
			apply: true,
			limit: null,
		});
		expect(report).toMatchObject({
			total: 2,
			current: 2,
			staleByKey: {},
			unreadableIds: [],
			rewritten: 0,
			skipped: 0,
		});
		expect(db.statements.some((s) => s.startsWith("UPDATE"))).toBe(false);
	});

	test("a row readable only with key[1] is re-encrypted under key[0]", async () => {
		const rows = [
			{
				id: "s1",
				salt: "org_a",
				value: await encryptSecret(oldKey, "org_a", "hunter2"),
			},
		];
		const before = rows[0]!.value;
		const db = fakeD1({ organization_secrets: rows });

		const dry = await rotateTable(db.run, orgTable, {
			keys: [newKey, oldKey],
			apply: false,
			limit: null,
		});
		expect(dry.staleByKey).toEqual({ 1: 1 });
		expect(rows[0]!.value).toBe(before);

		const applied = await rotateTable(db.run, orgTable, {
			keys: [newKey, oldKey],
			apply: true,
			limit: null,
		});
		expect(applied).toMatchObject({
			staleByKey: { 1: 1 },
			rewritten: 1,
			skipped: 0,
		});
		expect(rows[0]!.value).not.toBe(before);
		await expect(decryptSecret(newKey, "org_a", rows[0]!.value)).resolves.toBe(
			"hunter2",
		);
		await expect(
			decryptSecret(oldKey, "org_a", rows[0]!.value),
		).rejects.toThrow();
	});

	test("an unreadable row is reported by id and left untouched", async () => {
		const value = await encryptSecret(lostKey, "org_a", "gone");
		const rows = [{ id: "s-lost", salt: "org_a", value }];
		const db = fakeD1({ organization_secrets: rows });
		const report = await rotateTable(db.run, orgTable, {
			keys: [newKey, oldKey],
			apply: true,
			limit: null,
		});
		expect(report.unreadableIds).toEqual(["s-lost"]);
		expect(report.rewritten).toBe(0);
		expect(rows[0]!.value).toBe(value);
	});

	test("an optimistic update mismatch is counted as skipped", async () => {
		const rows = [
			{
				id: "s1",
				salt: "org_a",
				value: await encryptSecret(oldKey, "org_a", "v1"),
			},
		];
		const db = fakeD1({ organization_secrets: rows });
		// Simulate a concurrent writer: the row changes between read and write.
		const run: D1Runner = async (sql) => {
			if (sql.startsWith("UPDATE")) {
				rows[0]!.value = await encryptSecret(newKey, "org_a", "v2");
			}
			return db.run(sql);
		};
		const report = await rotateTable(run, orgTable, {
			keys: [newKey, oldKey],
			apply: true,
			limit: null,
		});
		expect(report).toMatchObject({
			staleByKey: { 1: 1 },
			rewritten: 0,
			skipped: 1,
		});
		await expect(decryptSecret(newKey, "org_a", rows[0]!.value)).resolves.toBe(
			"v2",
		);
	});

	test("each table uses its own derive function and salt; pages and limit hold", async () => {
		const appRows = await Promise.all(
			Array.from({ length: 5 }, async (_, i) => ({
				id: `a${String(i)}`,
				salt: "app_x",
				value: await encryptAppSecret(oldKey, "app_x", `p${String(i)}`),
			})),
		);
		const db = fakeD1({ app_secrets: appRows, organization_secrets: [] });
		const reports = await rotateAll(db.run, {
			keys: [newKey, oldKey],
			apply: true,
			limit: 3,
			tables: [orgTable, appTable],
		});
		expect(reports.map((r) => [r.table, r.total, r.rewritten])).toEqual([
			["organization_secrets", 0, 0],
			["app_secrets", 3, 3],
		]);
		await expect(
			decryptAppSecret(newKey, "app_x", appRows[0]!.value),
		).resolves.toBe("p0");
		// Beyond --limit, untouched.
		await expect(
			decryptAppSecret(newKey, "app_x", appRows[4]!.value),
		).rejects.toThrow();
	});

	test.each(["1", "005", String(Number.MAX_SAFE_INTEGER)])(
		"parseCli accepts the positive decimal row limit %s",
		(value) => {
			expect(parseCli(["--local", "--limit", value]).limit).toBe(Number(value));
		},
	);

	test.each([
		"",
		" ",
		"0",
		"-1",
		"1.5",
		"1e3",
		"5junk",
		"0x10",
		"+5",
		" 5 ",
		"Infinity",
		"NaN",
		"9007199254740993",
	])("parseCli rejects the invalid row limit %j", (value) => {
		expect(() => parseCli(["--local", "--limit", value])).toThrow(
			"--limit must be a positive safe integer",
		);
	});

	test("parseCli requires a target and defaults to dry run", () => {
		expect(() => parseCli([])).toThrow("--remote or --local");
		expect(parseCli(["--remote", "--limit", "5"])).toMatchObject({
			apply: false,
			limit: 5,
			target: "--remote",
			database: null,
		});
		expect(parseCli(["--local", "--apply", "--database", "DB"])).toMatchObject({
			apply: true,
			database: "DB",
		});
		expect(() => parseCli(["--remote", "--limit", "0"])).toThrow();
	});

	test.each([
		["--local", "--remote"],
		["--remote", "--local"],
	])("parseCli rejects conflicting targets %s %s", (first, second) => {
		expect(() => parseCli([first, second])).toThrow(
			"only one of --remote or --local",
		);
	});
});

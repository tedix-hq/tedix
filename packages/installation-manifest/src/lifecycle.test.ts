import { describe, expect, test } from "bun:test";
import {
	applyD1Upgrade,
	exportD1Database,
	r2BackupRoundtrip,
	restoreD1Database,
	splitSqlStatements,
	verifyD1Restore,
} from "./lifecycle";

const ACCOUNT = "test-account";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("splitSqlStatements", () => {
	test("splits on semicolons outside strings and drops noise", () => {
		const sql = [
			"-- comment only",
			"BEGIN TRANSACTION;",
			"CREATE TABLE a (id TEXT);",
			"INSERT INTO a VALUES ('semi;colon; inside');",
			"INSERT INTO a VALUES ('it''s; escaped');",
			"COMMIT;",
		].join("\n");
		expect(splitSqlStatements(sql)).toEqual([
			"CREATE TABLE a (id TEXT)",
			"INSERT INTO a VALUES ('semi;colon; inside')",
			"INSERT INTO a VALUES ('it''s; escaped')",
		]);
	});

	test("keeps a trailing statement without a semicolon", () => {
		expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
	});
});

describe("exportD1Database", () => {
	test("polls with bookmarks until complete, then downloads the dump", async () => {
		const calls: string[] = [];
		let polls = 0;
		const fetchImplementation = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			calls.push(`${init?.method ?? "GET"} ${url}`);
			if (url.includes("/export")) {
				polls++;
				const body = JSON.parse(String(init?.body));
				if (polls === 1) {
					expect(body.current_bookmark).toBeUndefined();
					return jsonResponse(200, {
						success: true,
						result: { status: "active", at_bookmark: "bm-1" },
					});
				}
				expect(body.current_bookmark).toBe("bm-1");
				return jsonResponse(200, {
					success: true,
					result: {
						status: "complete",
						at_bookmark: "bm-1",
						result: {
							filename: "dump.sql",
							signed_url: "https://signed.example.invalid/dump.sql",
						},
					},
				});
			}
			return new Response("CREATE TABLE a (id TEXT);\n", { status: 200 });
		}) as typeof fetch;
		const result = await exportD1Database({
			accountId: ACCOUNT,
			apiToken: "t",
			databaseId: "db-1",
			fetchImplementation,
			sleep: async () => {},
		});
		expect(result.polls).toBe(2);
		expect(result.filename).toBe("dump.sql");
		expect(result.sql).toContain("CREATE TABLE a");
	});

	test("fails closed after maxPolls", async () => {
		const fetchImplementation = (async () =>
			jsonResponse(200, {
				success: true,
				result: { status: "active", at_bookmark: "bm" },
			})) as typeof fetch;
		await expect(
			exportD1Database({
				accountId: ACCOUNT,
				apiToken: "t",
				databaseId: "db-1",
				fetchImplementation,
				sleep: async () => {},
				maxPolls: 3,
			}),
		).rejects.toThrow("did not complete within 3 polls");
	});
});

describe("restoreD1Database", () => {
	test("executes split statements in order against the target", async () => {
		const executed: string[] = [];
		const fetchImplementation = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const body = JSON.parse(String(init?.body));
			executed.push(body.sql);
			return jsonResponse(200, { success: true, result: [] });
		}) as typeof fetch;
		const result = await restoreD1Database({
			accountId: ACCOUNT,
			apiToken: "t",
			targetDatabaseId: "db-2",
			sql: "CREATE TABLE a (id TEXT);\nINSERT INTO a VALUES ('x');",
			fetchImplementation,
		});
		expect(result).toEqual({ ok: true, executed: 2 });
		expect(executed).toEqual([
			"CREATE TABLE a (id TEXT)",
			"INSERT INTO a VALUES ('x')",
		]);
	});
});

describe("verifyD1Restore", () => {
	function verifyFetch(counts: Record<string, unknown>): typeof fetch {
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body));
			const db = url.includes("/db-src/") ? "src" : "tgt";
			if (String(body.sql).includes("sqlite_master")) {
				return jsonResponse(200, {
					success: true,
					result: [{ results: [{ name: "a" }, { name: "b" }] }],
				});
			}
			const table = /FROM "(\w+)"/.exec(String(body.sql))?.[1] ?? "?";
			const value = counts[`${db}.${table}`];
			if (value === undefined) {
				return jsonResponse(400, {
					success: false,
					errors: [{ code: 7500, message: "no such table" }],
				});
			}
			return jsonResponse(200, {
				success: true,
				result: [{ results: [{ "count(*)": value }] }],
			});
		}) as typeof fetch;
	}

	test("matching counts verify ok", async () => {
		const result = await verifyD1Restore({
			accountId: ACCOUNT,
			apiToken: "t",
			sourceDatabaseId: "db-src",
			targetDatabaseId: "db-tgt",
			fetchImplementation: verifyFetch({
				"src.a": 3,
				"tgt.a": 3,
				"src.b": 0,
				"tgt.b": 0,
			}),
		});
		expect(result.ok).toBe(true);
		expect(result.tables).toHaveLength(2);
	});

	test("a table missing from the target fails the verification", async () => {
		const result = await verifyD1Restore({
			accountId: ACCOUNT,
			apiToken: "t",
			sourceDatabaseId: "db-src",
			targetDatabaseId: "db-tgt",
			fetchImplementation: verifyFetch({
				"src.a": 3,
				"tgt.a": 3,
				"src.b": 2,
			}),
		});
		expect(result.ok).toBe(false);
		const missing = result.tables.find((t) => t.table === "b");
		expect(missing?.targetRows).toBeNull();
		expect(missing?.match).toBe(false);
	});
});

describe("r2BackupRoundtrip", () => {
	test("write, copy under prefix, read back, compare", async () => {
		const store = new Map<string, string>();
		const fetchImplementation = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = String(input);
			const key = decodeURIComponent(url.split("/objects/")[1] ?? "");
			if ((init?.method ?? "GET") === "PUT") {
				store.set(key, String(init?.body));
				return jsonResponse(200, { success: true });
			}
			const value = store.get(key);
			return value === undefined
				? new Response("missing", { status: 404 })
				: new Response(value, { status: 200 });
		}) as typeof fetch;
		const result = await r2BackupRoundtrip({
			accountId: ACCOUNT,
			apiToken: "t",
			bucketName: "bucket",
			key: "drill/data.json",
			payload: '{"probe":true}',
			fetchImplementation,
		});
		expect(result.ok).toBe(true);
		expect(result.backupKey).toBe("backups/drill/data.json");
		expect(store.get("backups/drill/data.json")).toBe('{"probe":true}');
	});
});

describe("applyD1Upgrade", () => {
	test("applies statements then verifies the schema condition", async () => {
		const executed: string[] = [];
		const fetchImplementation = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const body = JSON.parse(String(init?.body));
			executed.push(body.sql);
			if (String(body.sql).startsWith("SELECT")) {
				return jsonResponse(200, {
					success: true,
					result: [{ results: [{ n: 2 }] }],
				});
			}
			return jsonResponse(200, { success: true, result: [] });
		}) as typeof fetch;
		const result = await applyD1Upgrade({
			accountId: ACCOUNT,
			apiToken: "t",
			databaseId: "db-2",
			statements: ["ALTER TABLE a ADD COLUMN v INTEGER DEFAULT 1"],
			verifySql: "SELECT count(*) AS n FROM pragma_table_info('a')",
			expectValue: 2,
			fetchImplementation,
		});
		expect(result.ok).toBe(true);
		expect(result.executed).toBe(1);
		expect(executed[0]).toContain("ALTER TABLE");
	});
});

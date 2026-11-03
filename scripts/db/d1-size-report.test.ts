import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readD1StorageReport } from "@tedix/db/queries/d1-size";
import { createSizeReportClient } from "./d1-size-report";

describe("size report REST transport", () => {
	test("passes bound values separately, preserves size_after and audits reads without row contents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "d1-size-"));
		const log = join(dir, "audit.jsonl");
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('private-value')",
		);
		try {
			const db = createSizeReportClient({
				accountId: "example-account",
				databaseId: "example-db",
				apiToken: "example-token",
				env: { TEDIX_D1_AUDIT_LOG: log, TEDIX_AGENT_SESSION: "test:session" },
				fetchImplementation: async (_input, init) => {
					const request = JSON.parse(String(init?.body)) as {
						sql: string;
						params?: (string | number | null)[];
					};
					if (request.sql.includes("FROM dbstat"))
						return new Response(
							JSON.stringify({
								success: false,
								errors: [{ message: "no such table: dbstat" }],
							}),
						);
					const results = sqlite
						.prepare(request.sql)
						.all(...(request.params ?? []));
					return new Response(
						JSON.stringify({
							success: true,
							result: [
								{
									success: true,
									results,
									meta: { size_after: 8192, rows_written: 0 },
								},
							],
						}),
					);
				},
			});
			const report = await readD1StorageReport(db, {
				pageSize: 2,
				sampleSize: 1,
			});
			expect(report).toMatchObject({
				method: "estimate",
				sizeBefore: 8192,
				sizeAfter: 8192,
				attributedBytes: 13,
				unattributedBytes: 8179,
				complete: true,
			});
			expect(report.objects[0]).toMatchObject({
				name: "sample",
				rows: 1,
				bytes: 13,
			});
			const audit = readFileSync(log, "utf8");
			expect(audit).toContain("test:session");
			expect(audit).not.toContain("private-value");
			expect(audit).not.toContain("example-token");
		} finally {
			sqlite.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

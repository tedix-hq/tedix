import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { tediApprovalRequests } from "../../schema/approvals";
import { auditEvents } from "../../schema/audit-events";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listDecidedForYou } from "./delegated-approvals";

it("seeks decided-for-you rows by delegated owner instead of scanning every resolved request", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		for (const table of [
			tediApprovalRequests,
			workInteractions,
			workInteractionResponses,
			auditEvents,
		])
			sqlite.exec(schemaDdl(table));
		const statements: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					statements.push(statement);
				},
			}),
		);
		await listDecidedForYou(db, {
			orgId: "org-example",
			ownerId: "owner-example",
			limit: 20,
		});
		const plan = (needle: string) => {
			const query = statements.find((s) => s.includes(needle));
			expect(query).toBeDefined();
			const params = Array.from(
				{ length: (query!.match(/\?/g) ?? []).length },
				() => "org-example",
			);
			return sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all(...params)
				.map((row) => String(row.detail))
				.join(" | ");
		};
		const runtime = plan('from "tedi_approval_requests"');
		expect(runtime).toContain("idx_approval_requests_delegated_owner");
		expect(runtime).not.toMatch(/SCAN "?tedi_approval_requests"?\b/);
	} finally {
		sqlite.close();
	}
});

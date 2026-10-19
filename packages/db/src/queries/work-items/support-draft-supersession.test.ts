import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workInteractions } from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import { supersedeSupportDraftInteractions } from "./interactions";

it("expires only older open drafts for the same ticket, organization and recipient, retaining an audit trail", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions)}`);
		for (const org of ["org", "other-org"])
			sqlite
				.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?)")
				.run(org, org, org);
		const insert = sqlite.prepare(`INSERT INTO work_interactions
			(id,org_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,status,metadata)
			VALUES (?,?,'question','Draft','Original source reply','user','author','user',?,'2026-01-01T00:00:00.000Z',?,?)`);
		for (const [id, org, target, ticket, version, status, source] of [
			["older", "org", "robin", "ticket", 1, "open", "support-draft"],
			["latest", "org", "robin", "ticket", 3, "open", "support-draft"],
			["stale-retry", "org", "robin", "ticket", 2, "open", "support-draft"],
			["answered", "org", "robin", "ticket", 1, "resolved", "support-draft"],
			["other-ticket", "org", "robin", "elsewhere", 1, "open", "support-draft"],
			["other-user", "org", "sam", "ticket", 1, "open", "support-draft"],
			["other-org", "other-org", "robin", "ticket", 1, "open", "support-draft"],
			["other-source", "org", "robin", "ticket", 1, "open", "manual"],
		] as const)
			insert.run(
				id,
				org,
				target,
				status,
				JSON.stringify({
					source,
					supportTicketId: ticket,
					supportVersion: version,
					retained: "evidence",
				}),
			);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const input = {
			orgId: "org",
			targetId: "robin",
			ticketId: "ticket",
			now: "2026-10-19T12:00:00.000Z",
		};
		expect(
			(await supersedeSupportDraftInteractions(db, input))
				.map((row) => row.id)
				.sort(),
		).toEqual(["older", "stale-retry"]);
		expect(await supersedeSupportDraftInteractions(db, input)).toEqual([]);
		for (const id of ["older", "stale-retry"]) {
			const row = sqlite
				.prepare(
					"SELECT status,version,prompt,metadata FROM work_interactions WHERE id=?",
				)
				.get(id)!;
			expect(row).toMatchObject({
				status: "expired",
				version: 2,
				prompt: "Original source reply",
			});
			expect(JSON.parse(String(row.metadata))).toMatchObject({
				retained: "evidence",
				supersession: {
					reason: "newer_support_draft",
					supersededBy: "latest",
					at: input.now,
				},
			});
		}
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_interactions WHERE status='open'",
				)
				.get()?.count,
		).toBe(5);
	} finally {
		sqlite.close();
	}
});

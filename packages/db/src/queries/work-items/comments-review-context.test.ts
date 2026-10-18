import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workItemComments } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listRecentWorkItemComments } from "./comments";

describe("recent Work review observations", () => {
	it("scopes the latest comments before limiting and retains their authors", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(schemaDdl(workItemComments));
		const insert = sqlite.prepare(
			"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,created_at) VALUES(?,?,?,'external_agent','fictional-source-lane',?,?)",
		);
		for (let n = 0; n < 8; n++)
			insert.run(
				`comment-${n}`,
				"harbor",
				"reply",
				`Source ${n}`,
				`2026-10-17T10:00:0${n}.000Z`,
			);
		insert.run(
			"foreign",
			"other",
			"reply",
			"Foreign secret",
			"2026-10-17T11:00:00.000Z",
		);
		insert.run(
			"other-work",
			"harbor",
			"different",
			"Other Work secret",
			"2026-10-17T11:00:00.000Z",
		);
		insert.run("tie-a", "harbor", "reply", "Tie A", "2026-10-17T10:00:08.000Z");
		insert.run("tie-b", "harbor", "reply", "Tie B", "2026-10-17T10:00:08.000Z");
		try {
			const result = await listRecentWorkItemComments(
				createDbQueryClient(createD1Facade(sqlite)),
				{ orgId: "harbor", workItemId: "reply", limit: 3 },
			);
			expect(result.map((row) => row.id)).toEqual([
				"tie-b",
				"tie-a",
				"comment-7",
			]);
			expect(result[0]).toMatchObject({
				authorType: "external_agent",
				authorId: "fictional-source-lane",
				body: "Tie B",
				createdAt: "2026-10-17T10:00:08.000Z",
			});
		} finally {
			sqlite.close();
		}
	});
});

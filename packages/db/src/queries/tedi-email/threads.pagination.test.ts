import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { tediEmailMessages, tediEmailThreads } from "../../schema/tedi-email";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listTediEmailThreads } from "./threads";

const SCOPE = { tediId: "tedi-1", organizationId: "org-1" };
const AT = "2026-10-23T12:00:00Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tediEmailThreads, tediEmailMessages));
	const insert = sqlite.prepare(
		`INSERT INTO tedi_email_threads
		 (id, organization_id, tedi_id, subject_norm, last_message_at)
		 VALUES (?, ?, ?, 'hello', ?)`,
	);
	// Deliberately insert ties out of ID order.
	for (const id of ["b|thread", "a", "c"]) {
		insert.run(id, SCOPE.organizationId, SCOPE.tediId, AT);
	}
	insert.run("newest", "org-1", "tedi-1", "2026-10-24T12:00:00Z");
	insert.run("oldest", "org-1", "tedi-1", "2026-10-22T12:00:00Z");
	insert.run("foreign-org", "org-2", "tedi-1", AT);
	insert.run("foreign-tedi", "org-1", "tedi-2", AT);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("email thread keyset pagination", () => {
	it.each([1, 2, 3, 5])(
		"returns every authorized thread exactly once with page size %i",
		async (limit) => {
			const { db, sqlite } = fixture();
			try {
				const ids: string[] = [];
				let cursor: string | null = null;
				for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
					const page = await listTediEmailThreads(db, {
						...SCOPE,
						limit,
						cursor: cursor ?? undefined,
					});
					ids.push(...page.threads.map((thread) => thread.id));
					cursor = page.nextCursor;
					if (cursor === null) break;
				}
				expect(ids).toEqual(["newest", "c", "b|thread", "a", "oldest"]);
				expect(cursor).toBeNull();
			} finally {
				sqlite.close();
			}
		},
	);

	it("accepts legacy timestamp-only cursors with their strict older-than boundary", async () => {
		const { db, sqlite } = fixture();
		try {
			const page = await listTediEmailThreads(db, {
				...SCOPE,
				cursor: AT,
				limit: 2,
			});
			expect(page.threads.map((thread) => thread.id)).toEqual(["oldest"]);
			expect(page.nextCursor).toBeNull();
		} finally {
			sqlite.close();
		}
	});
});

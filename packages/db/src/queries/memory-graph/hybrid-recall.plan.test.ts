import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { recordRecallAccess } from "./hybrid-recall";

it("records recall access by fact id, not by walking the organization's facts", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.startsWith('update "memory_facts"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}) as never,
	);
	await recordRecallAccess(db as never, { organizationId: "org-example" }, [
		"fact-a",
		"fact-b",
	]);
	expect(plans.join("\n")).toMatch(
		/SEARCH memory_facts USING INDEX sqlite_autoindex_memory_facts_1 \(id=\?\)/,
	);
});

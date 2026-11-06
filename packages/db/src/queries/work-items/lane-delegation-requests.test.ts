import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workInteractionCardRevisions,
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	retireStaleLaneDelegationRequests,
	settleLaneDelegationRequests,
} from "./lane-delegation-requests";

const NOW = "2026-11-06T12:00:00.000Z";

/** The deployed update guards on work_interactions, latest definition each. */
function armGuards(sqlite: DatabaseSync) {
	const migrations = new URL("../../../drizzle/", import.meta.url);
	const guards = new Map<string, string>();
	for (const name of readdirSync(migrations).sort()) {
		if (!/^\d+_/.test(name)) continue;
		const text = readFileSync(
			new URL(`${name}/migration.sql`, migrations),
			"utf8",
		);
		for (const statement of text.split("--> statement-breakpoint")) {
			const drop = statement.match(
				/DROP TRIGGER(?: IF EXISTS)?\s+[`"]?([\w]+)[`"]?/i,
			);
			if (drop) guards.delete(drop[1]!);
			const create = statement.match(
				/CREATE TRIGGER\s+[`"]?([\w]+)[`"]?[\s\S]*?\bEND;/i,
			);
			if (
				create &&
				/BEFORE UPDATE ON\s+[`"]?work_interactions[`"]?(?:\s|$)/i.test(
					create[0],
				)
			)
				guards.set(create[1]!, create[0]);
		}
	}
	for (const guard of guards.values()) sqlite.exec(guard);
}

function fixture(answered = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions, workInteractionResponses, workInteractionCardRevisions, organizationMembers, tedis)}`,
	);
	sqlite.exec(
		"INSERT INTO organizations (id,name,slug) VALUES ('org','Org','org')",
	);
	const work = sqlite.prepare(
		"INSERT INTO work_items (id,org_id,title,disposition,version,metadata,created_at) VALUES (?,'org',?,?,?,?,?)",
	);
	work.run(
		"work",
		"Fictional task",
		"accepted",
		3,
		'{"executor":"codex"}',
		NOW,
	);
	work.run(
		"done",
		"Finished task",
		"completed",
		2,
		'{"executor":"codex"}',
		NOW,
	);
	work.run("other", "Other task", "accepted", 1, '{"executor":"codex"}', NOW);
	work.run(
		"handed",
		"Hand-delegated task",
		"accepted",
		1,
		'{"executor":"codex"}',
		NOW,
	);
	sqlite.exec(
		"UPDATE work_items SET accountable_owner_type='user', accountable_owner_id='owner'",
	);
	sqlite
		.prepare(
			"INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,author_id,body,created_at) VALUES ('note','org','handed','user','owner',?,?)",
		)
		.run(
			"Looks fine.\nDelegation: codex work-version=1 Rotate only the fictional staging key.",
			NOW,
		);
	const ask = sqlite.prepare(`INSERT INTO work_interactions
		(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,status,metadata,created_at)
		VALUES (?,'org',?,'question',?,'?','user',?,'user','owner',?,?,?)`);
	const lane = (version: number, executor = "codex") =>
		JSON.stringify({
			source: "lane-dispatch-blocker",
			laneBlocker: { kind: "owner_delegation", executor, workVersion: version },
		});
	ask.run(
		"old-version",
		"work",
		"A",
		"op-a",
		"open",
		lane(2),
		"2026-11-06T10:00:00.000Z",
	);
	ask.run(
		"current",
		"work",
		"B",
		"op-b",
		"open",
		lane(3),
		"2026-11-06T11:00:00.000Z",
	);
	ask.run(
		"current-dup",
		"work",
		"B2",
		"op-c",
		"open",
		lane(3),
		"2026-11-06T11:10:00.000Z",
	);
	ask.run(
		"hand-delegated",
		"handed",
		"G",
		"op-a",
		"open",
		lane(1),
		"2026-11-06T11:00:00.000Z",
	);
	ask.run(
		"finished",
		"done",
		"C",
		"op-a",
		"open",
		lane(2),
		"2026-11-06T11:00:00.000Z",
	);
	ask.run(
		"moved-lane",
		"other",
		"D",
		"op-a",
		"open",
		lane(1, "claude-code"),
		"2026-11-06T11:00:00.000Z",
	);
	ask.run(
		"kept",
		"other",
		"E",
		"op-a",
		"open",
		lane(1),
		"2026-11-06T11:00:00.000Z",
	);
	ask.run(
		"unrelated",
		"done",
		"F",
		"op-a",
		"open",
		"{}",
		"2026-11-06T11:00:00.000Z",
	);
	if (answered)
		sqlite.exec(
			"UPDATE work_interactions SET status='resolved', resolved_at='2026-11-06T11:30:00.000Z' WHERE id='current'",
		);
	armGuards(sqlite);
	const status = (id: string) =>
		(
			sqlite
				.prepare("SELECT status FROM work_interactions WHERE id=?")
				.get(id) as { status: string }
		).status;
	return { sqlite, status, db: createDbQueryClient(createD1Facade(sqlite)) };
}

it("keeps one lane permission card per task version, whichever login asks", async () => {
	const { db, status } = fixture();
	const result = await settleLaneDelegationRequests(db, {
		orgId: "org",
		workItemId: "work",
		workVersion: 3,
		targetType: "user",
		targetId: "owner",
		now: NOW,
	});
	expect(result.retired).toBe(2);
	expect(result.existing?.id).toBe("current");
	expect(status("old-version")).toBe("cancelled");
	expect(status("current-dup")).toBe("cancelled");
	expect(status("current")).toBe("open");
});

it("does not ask again once the same version was answered", async () => {
	const { db } = fixture(true);
	const result = await settleLaneDelegationRequests(db, {
		orgId: "org",
		workItemId: "work",
		workVersion: 3,
		targetType: "user",
		targetId: "owner",
		now: NOW,
	});
	expect(result.existing?.id).toBe("current");
});

it("retires lane permission cards whose task finished, changed, moved, was already delegated or is asked twice", async () => {
	const { db, status } = fixture();
	expect(await retireStaleLaneDelegationRequests(db, { now: NOW })).toBe(5);
	expect(status("current-dup")).toBe("cancelled");
	expect(status("hand-delegated")).toBe("cancelled");
	expect(status("old-version")).toBe("cancelled");
	expect(status("finished")).toBe("cancelled");
	expect(status("moved-lane")).toBe("cancelled");
	expect(status("current")).toBe("open");
	expect(status("kept")).toBe("open");
	expect(status("unrelated")).toBe("open");
});

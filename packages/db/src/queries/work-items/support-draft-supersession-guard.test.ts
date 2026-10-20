import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import {
	workInteractions,
	workInteractionCardRevisions,
	workInteractionResponses,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import { sweepSupersededSupportDraftInteractions } from "./interactions";

function fixture(
	latest: { targetId?: string; source?: string; version?: number } = {},
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				workInteractions,
				workInteractionCardRevisions,
				workInteractionResponses,
				organizationMembers,
				tedis,
			),
	);
	sqlite
		.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES('orchard','Orchard','orchard')",
		)
		.run();
	for (const [id, version, source] of [
		["older", 2, "support-draft"],
		["adapter", 2, "night-source-adapter"],
		["latest", 3, "support-draft"],
	] as const) {
		const metadata = {
			source: id === "latest" ? (latest.source ?? source) : source,
			supportTicketId: "ticket",
			supportVersion: id === "latest" ? (latest.version ?? version) : version,
			...(source === "night-source-adapter"
				? {
						originalSource: "support-work-draft",
						sourceKey: `support-draft:ticket:${version}`,
						decisionDeck: { classId: "support.reply", kind: "outbound" },
					}
				: {}),
		};
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,status,metadata) VALUES(?,'orchard','question','Draft','Retained reply','user','author','user',?,'2026-10-19T00:00:00Z','open',?)",
			)
			.run(
				id,
				id === "latest" ? (latest.targetId ?? "river") : "river",
				JSON.stringify(metadata),
			);
	}
	// Exercise the effective migration guards, including later replacements.
	const migrations = new URL("../../../drizzle/", import.meta.url);
	const guards = new Map<string, string>();
	for (const name of readdirSync(migrations).sort()) {
		if (!/^\d+_/.test(name)) continue;
		const sql = readFileSync(
			new URL(`${name}/migration.sql`, migrations),
			"utf8",
		);
		for (const statement of sql.split("--> statement-breakpoint")) {
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
	expect(guards.has("work_interaction_delegation_guard")).toBe(true);
	for (const sql of guards.values()) sqlite.exec(sql);
	return sqlite;
}

it("supersedes both producer forms under the deployed guards without answering or changing source content", async () => {
	const sqlite = fixture();
	try {
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(
			await sweepSupersededSupportDraftInteractions(db, {
				orgId: "orchard",
				targetId: "river",
				now: "2026-10-20T08:00:00.000Z",
				limit: 50,
			}),
		).toEqual({ superseded: 2, scanned: 2, hasMore: false });
		for (const id of ["older", "adapter"]) {
			expect(
				sqlite
					.prepare(
						"SELECT status,prompt,version,json_extract(metadata,'$.supersession.supersededBy') AS successor FROM work_interactions WHERE id=?",
					)
					.get(id),
			).toEqual({
				status: "expired",
				prompt: "Retained reply",
				version: 2,
				successor: "latest",
			});
		}
		expect(
			sqlite
				.prepare("SELECT status FROM work_interactions WHERE id='latest'")
				.get(),
		).toEqual({ status: "open" });
		expect(
			sqlite
				.prepare("SELECT count(*) AS count FROM work_interaction_responses")
				.get(),
		).toEqual({ count: 0 });
	} finally {
		sqlite.close();
	}
});

it.each([
	["prompt", "prompt='Changed reply',"],
	["recipient", "target_id='other-person',"],
	["resolution", "resolved_at='2026-10-20T08:00:00.000Z',"],
	["cancellation", "cancelled_at='2026-10-20T08:00:00.000Z',"],
])("rejects %s changes disguised as supersession", (_name, extra) => {
	const sqlite = fixture();
	try {
		expect(() =>
			sqlite
				.prepare(
					`UPDATE work_interactions SET ${extra} status='expired',version=version+1,resolution_fence='new-fence',expired_at='2026-10-20T08:00:00.000Z',metadata=json_set(metadata,'$.supersession',json(?)) WHERE id='older'`,
				)
				.run(
					JSON.stringify({
						reason: "newer_support_draft",
						supersededBy: "latest",
						at: "2026-10-20T08:00:00.000Z",
					}),
				),
		).toThrow();
	} finally {
		sqlite.close();
	}
});

it.each([
	"missing",
	"wrong-person",
	"wrong-version",
	"wrong-source",
	"wrong-time",
])("rejects an invalid successor or timestamp: %s", (variant) => {
	const sqlite = fixture({
		...(variant === "wrong-person" ? { targetId: "other-person" } : {}),
		...(variant === "wrong-version" ? { version: 2 } : {}),
		...(variant === "wrong-source" ? { source: "manual" } : {}),
	});
	try {
		const successor = variant === "missing" ? "missing" : "latest";
		expect(() =>
			sqlite
				.prepare(
					"UPDATE work_interactions SET status='expired',version=version+1,resolution_fence='new-fence',expired_at='2026-10-20T08:00:00.000Z',metadata=json_set(metadata,'$.supersession',json(?)) WHERE id='older'",
				)
				.run(
					JSON.stringify({
						reason: "newer_support_draft",
						supersededBy: successor,
						at:
							variant === "wrong-time"
								? "2026-10-21T08:00:00.000Z"
								: "2026-10-20T08:00:00.000Z",
					}),
				),
		).toThrow();
	} finally {
		sqlite.close();
	}
});

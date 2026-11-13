import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { workItems, workItemComments } from "@tedix/db/schema/work-items";
import {
	tediEmailThreads,
	tediEmailMessages,
} from "@tedix/db/schema/tedi-email";
import { osOutputs } from "@tedix/db/schema/os-workspaces";
import { expect, it } from "vite-plus/test";
import { decisionSourcesCurrent } from "@tedix/db/queries/work-items/decision-sources";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { refreshDecisionSourceCards } from "./decision-sources";

const orgId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const at = "2026-10-21T17:16:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workItemComments,
			tediEmailThreads,
			tediEmailMessages,
			osOutputs,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const check = (sources: unknown, subject = "Delete the paused copy?") =>
		decisionSourcesCurrent(db, orgId, {
			creatorType: "external_agent",
			creatorId: "asking-agent",
			createdAt: at,
			status: "open",
			targetType: "user",
			subject,
			prompt: "Review the current facts.",
			metadata: sources === undefined ? {} : { decisionSources: sources },
		});
	return { sqlite, check };
}

it("keeps the pinned historical comment count while exempting new progress", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,created_at) VALUES (?,?,'Copy',?)",
			)
			.run(id, orgId, at);
		const comment = sqlite.prepare(
			"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,metadata,created_at) VALUES (?,?,?,'external_agent','asking-agent',?,?,?)",
		);
		comment.run("old", orgId, id, "Earlier findings", "{}", at);
		const source = { kind: "work", id, version: 1, commentCount: 1 };
		comment.run(
			"progress",
			orgId,
			id,
			"Waiting for your answer",
			'{"decisionImpact":"progress"}',
			"2026-10-22T10:00:00.000Z",
		);
		expect(await check([source])).toBe(true);
		comment.run(
			"fact",
			orgId,
			id,
			"Credits approved",
			"{}",
			"2026-10-21T18:00:00.000Z",
		);
		expect(await check([source])).toBe(false);
		// A pin refreshed after card creation cannot reuse the original baseline.
		expect(await check([{ ...source, commentCount: 2 }])).toBe(false);
		// A backdated fact still invalidates a count pin.
		sqlite
			.prepare("UPDATE work_item_comments SET created_at=? WHERE id='fact'")
			.run(at);
		expect(await check([source])).toBe(false);
	} finally {
		sqlite.close();
	}
});

it.each([
	["external_agent", "asking-agent", { decisionImpact: "progress" }, true],
	["external_agent", "asking-agent", {}, false],
	["external_agent", "asking-agent", { decisionImpact: "facts" }, false],
	["external_agent", "other-agent", { decisionImpact: "progress" }, false],
	["tedi", "asking-agent", { decisionImpact: "progress" }, false],
	["user", "asking-agent", { decisionImpact: "progress" }, false],
])(
	"keeps reviewable comments on a card after %s/%s posts %j (current: %s)",
	async (authorType, authorId, metadata, current) => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const db = createDbClient(createD1Facade(sqlite));
		try {
			sqlite
				.prepare(
					"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES ('member',?,'person','person','person@example.test','active')",
				)
				.run(orgId);
			sqlite
				.prepare(
					"INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id) VALUES ('asking-agent',?,'asking-agent','Asking agent','api_key','key','user','person')",
				)
				.run(orgId);
			sqlite
				.prepare(
					"INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,started_at,last_seen_at) VALUES ('session',?,'asking-agent','test-session','test','1','test','test','test','explicit',?,?)",
				)
				.run(orgId, at, at);
			sqlite
				.prepare(
					"INSERT INTO work_items(id,org_id,title,created_at,admission_spec_revision) VALUES (?,?,'Copy',?,'revision-1')",
				)
				.run(id, orgId, at);
			sqlite
				.prepare(
					"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,creator_session_id,creator_external_session_key,target_type,target_id,created_at,metadata) VALUES ('card',?,?,'question','Delete the copy?','Review facts','external_agent','asking-agent','session','test-session','user','person',?,?)",
				)
				.run(
					orgId,
					id,
					at,
					JSON.stringify({
						decisionSources: [
							{ kind: "work", id, version: 1, commentCount: 0 },
						],
					}),
				);
			sqlite
				.prepare(
					"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,metadata,created_at) VALUES ('note',?,?,?,?,?,?,?)",
				)
				.run(
					orgId,
					id,
					authorType,
					authorId,
					current ? "Still working; waiting for your answer." : "Updated facts",
					JSON.stringify(metadata),
					"2026-10-22T10:00:00.000Z",
				);
			expect(await refreshDecisionSourceCards(db, orgId, "person")).toEqual({
				scanned: 1,
				superseded: 0,
				hasMore: false,
			});
			expect(
				sqlite
					.prepare("SELECT status FROM work_interactions WHERE id='card'")
					.get(),
			).toMatchObject({ status: "open" });
			// The question remains answerable after review; the freshness gate
			// still rejects an answer that has not reviewed a newer fact.
			expect(
				await decisionSourcesCurrent(db, orgId, {
					creatorType: "external_agent",
					creatorId: "asking-agent",
					createdAt: at,
					status: "open",
					kind: "question",
					targetType: "user",
					subject: "Delete the copy?",
					prompt: "Review facts",
					metadata: {
						decisionSources: [
							{ kind: "work", id, version: 1, commentCount: 0 },
						],
					},
				}),
			).toBe(current);
			const receipts = sqlite
				.prepare(
					"SELECT metadata FROM audit_events WHERE resource_id='card' AND action='decision.sources.expired'",
				)
				.all();
			expect(receipts).toHaveLength(0);
			expect(
				await refreshDecisionSourceCards(db, orgId, "person"),
			).toMatchObject({ superseded: 0 });
		} finally {
			sqlite.close();
		}
	},
);

it.each([
	undefined,
	[],
	[{ kind: "external_resource", id }],
	[{ kind: "work", id, version: "1", commentCount: 0 }],
])(
	"withholds irreversible legacy cards with missing or invalid evidence: %j",
	async (sources) => {
		const { sqlite, check } = fixture();
		try {
			expect(await check(sources)).toBe(false);
		} finally {
			sqlite.close();
		}
	},
);

it("keeps a source-free preference question answerable", async () => {
	const { sqlite, check } = fixture();
	try {
		expect(await check(undefined, "Which colour do you prefer?")).toBe(true);
	} finally {
		sqlite.close();
	}
});

it("rechecks Work versions and comments, including comments sharing a timestamp", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
			)
			.run(id, orgId, "Review the service", at);
		const source = { kind: "work", id, version: 1, commentCount: 0 };
		expect(await check([source])).toBe(true);
		sqlite
			.prepare(
				"INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,body,created_at) VALUES (?,?,?,'user',?,?)",
			)
			.run("comment-z", orgId, id, "Credits approved", at);
		expect(await check([source])).toBe(false);
		expect(await check([{ ...source, commentCount: 1 }])).toBe(true);
		sqlite
			.prepare(
				"INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,body,created_at) VALUES (?,?,?,'user',?,?)",
			)
			.run("comment-a", orgId, id, "Credits applied", at);
		expect(await check([{ ...source, commentCount: 1 }])).toBe(false);
		sqlite.prepare("UPDATE work_items SET version=2 WHERE id=?").run(id);
		expect(await check([{ ...source, commentCount: 2 }])).toBe(false);
		expect(await check([{ ...source, version: 2, commentCount: 2 }])).toBe(
			true,
		);
	} finally {
		sqlite.close();
	}
});

it("checks every source and rejects missing or cross-organization Work", async () => {
	const { sqlite, check } = fixture();
	try {
		const source = { kind: "work", id, version: 1, commentCount: 0 };
		expect(await check([source])).toBe(false);
		sqlite
			.prepare(
				"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
			)
			.run(id, "other-org", "Private task", at);
		expect(await check([source])).toBe(false);
		sqlite.prepare("UPDATE work_items SET org_id=? WHERE id=?").run(orgId, id);
		expect(await check([source, { kind: "output", id, revisionId }])).toBe(
			false,
		);
	} finally {
		sqlite.close();
	}
});

it("withholds revised, archived and cross-organization outputs", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO os_outputs (id,organization_id,kind,title,current_revision_id,created_by_kind,created_by_id,created_at,updated_at) VALUES (?,?,'document','Resource state',?,'user','owner',?,?)",
			)
			.run(id, orgId, revisionId, at, at);
		const sources = [{ kind: "output", id, revisionId }];
		expect(await check(sources)).toBe(true);
		sqlite
			.prepare("UPDATE os_outputs SET current_revision_id=? WHERE id=?")
			.run(id, id);
		expect(await check(sources)).toBe(false);
		sqlite
			.prepare(
				"UPDATE os_outputs SET current_revision_id=?,status='archived' WHERE id=?",
			)
			.run(revisionId, id);
		expect(await check(sources)).toBe(false);
		sqlite
			.prepare(
				"UPDATE os_outputs SET status='active',organization_id='other-org' WHERE id=?",
			)
			.run(id);
		expect(await check(sources)).toBe(false);
	} finally {
		sqlite.close();
	}
});

it("detects delayed email even when thread timestamps have not advanced", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO tedi_email_threads (id,organization_id,tedi_id,subject_norm,last_message_at,updated_at) VALUES (?,?,?,'credit request',?,?)",
			)
			.run(id, orgId, id, at, at);
		const source = {
			kind: "email_thread",
			id,
			tediId: id,
			updatedAt: at,
			lastMessageAt: at,
			messageCount: 0,
		};
		expect(await check([source])).toBe(true);
		sqlite
			.prepare(
				"INSERT INTO tedi_email_messages (id,thread_id,organization_id,tedi_id,direction,from_addr,to_json,subject,status,created_at) VALUES (?,?,?,?,'inbound','support@vendor.test','[]','Credits approved','received',?)",
			)
			.run("delayed-reply", id, orgId, id, "2026-10-20T12:00:00.000Z");
		expect(await check([source])).toBe(false);
		expect(await check([{ ...source, messageCount: 1 }])).toBe(true);
		expect(
			await check([{ ...source, messageCount: 1, tediId: revisionId }]),
		).toBe(false);
		sqlite
			.prepare(
				"UPDATE tedi_email_threads SET organization_id='other-org' WHERE id=?",
			)
			.run(id);
		expect(await check([{ ...source, messageCount: 1 }])).toBe(false);
	} finally {
		sqlite.close();
	}
});

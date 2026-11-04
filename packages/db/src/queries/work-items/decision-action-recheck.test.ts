import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workItems,
	workItemComments,
	workItemRelations,
} from "../../schema/work-items";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	decisionActionChange,
	decisionActionChangeDetail,
} from "./decision-action-recheck";

const orgId = "org";
const workId = "00000000-0000-4000-8000-000000000001";
const createdAt = "2026-10-20T10:00:00.000Z";
const later = "2026-10-21T10:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workItemComments,
			workItemRelations,
			workInteractions,
			workInteractionResponses,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,created_at) VALUES (?,?,'Database copy',?)",
		)
		.run(workId, orgId, createdAt);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const request = {
		id: "card",
		workItemId: workId,
		createdAt,
		status: "resolved",
		kind: "question",
		targetType: "user",
		targetId: "person",
		subject: "Delete the paused database copy?",
		prompt: "Delete before it resumes?",
		metadata: {
			decisionSources: [
				{ kind: "work", id: workId, version: 1, commentCount: 0 },
			],
		},
	};
	return {
		sqlite,
		request,
		check: () => decisionActionChange(db, orgId, request),
		detail: (reviewedThrough?: string) =>
			decisionActionChangeDetail(
				db,
				orgId,
				{ ...request, status: "open" },
				{ reviewedThrough },
			),
	};
}

it("allows a current delete approval at continuation time", async () => {
	const { sqlite, check } = fixture();
	try {
		expect(await check()).toBeNull();
	} finally {
		sqlite.close();
	}
});

it.each(["completed", "cancelled"])(
	"blocks a delete approval after Work is %s",
	async (disposition) => {
		const { sqlite, check } = fixture();
		try {
			sqlite
				.prepare("UPDATE work_items SET disposition=? WHERE id=?")
				.run(disposition, workId);
			expect(await check()).toContain(disposition);
		} finally {
			sqlite.close();
		}
	},
);

it("blocks a delete approval after a new credit comment", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,body,created_at) VALUES ('credit',?,?,'user','Credits granted; this is production.',?)",
			)
			.run(orgId, workId, later);
		expect(await check()).toContain("Credits granted; this is production.");
	} finally {
		sqlite.close();
	}
});

it("lets the person answer against a newer comment they have read, and no newer", async () => {
	const { sqlite, detail } = fixture();
	const comment = (id: string, at: string) =>
		sqlite
			.prepare(
				"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,body,created_at) VALUES (?,?,?,'tedi','Checks are green.',?)",
			)
			.run(id, orgId, workId, at);
	try {
		comment("progress", later);
		expect(await detail()).toEqual({
			text: "The linked Work has a newer comment: Checks are green.",
			reviewableThrough: later,
			note: "Checks are green.",
		});
		expect(await detail(later)).toBeNull();
		comment("after", "2026-10-22T10:00:00.000Z");
		expect((await detail(later))?.reviewableThrough).toBe(
			"2026-10-22T10:00:00.000Z",
		);
	} finally {
		sqlite.close();
	}
});

it("keeps honouring the reviewed version stored on a resolving answer", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,body,created_at) VALUES ('progress',?,?,'tedi','Checks are green.',?)",
			)
			.run(orgId, workId, later);
		expect(await check()).toContain("Checks are green.");
		sqlite
			.prepare(
				"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at) VALUES ('answer',?,'card',1,'fence','user','person','Yes','answer',1,?,?)",
			)
			.run(orgId, JSON.stringify({ reviewedChangesThrough: later }), later);
		expect(await check()).toBeNull();
	} finally {
		sqlite.close();
	}
});

it("blocks superseded Work without relying on a version bump", async () => {
	const { sqlite, check } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES ('replacement',?,'new-work',?,'supersedes',?)",
			)
			.run(orgId, workId, later);
		expect(await check()).toContain("superseded");
	} finally {
		sqlite.close();
	}
});

it("blocks a newer card for the same subject, with a tenant fence", async () => {
	const { sqlite, check } = fixture();
	try {
		const insert = sqlite.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES (?, ?, ?, 'question', 'Keep the production database?', 'Credits renewed', 'system', 'tedix', 'user', 'person', ?)",
		);
		insert.run("foreign", "other-org", workId, later);
		expect(await check()).toBeNull();
		insert.run("newer", orgId, workId, later);
		expect(await check()).toContain("newer");
	} finally {
		sqlite.close();
	}
});

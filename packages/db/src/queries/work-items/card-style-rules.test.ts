import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import { learningImprovementProposals } from "../../schema/learning-feedback";
import { memoryFacts } from "../../schema/memory-graph";
import { organizationMembers } from "../../schema/organization-members";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	getPersonalCardStyleProposal,
	getPersonalCardStyleRule,
	listPersonalCardStyleRules,
	resolveCardStyleOwner,
	reviewPersonalCardStyleRule,
} from "./card-style-rules";

const ORG = "org-fictional";
const OTHER_ORG = "org-elsewhere";
const OWNER = "subject-ada";

let sqlite: DatabaseSync;
let db: DbQueryClient;

function member(
	id: string,
	fields: {
		org?: string;
		userId?: string | null;
		subject: string;
		status?: string;
		kind?: string;
		representedUserId?: string | null;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO organization_members
				(id, organization_id, user_id, descope_user_id, email, status, kind, represented_user_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			fields.org ?? ORG,
			fields.userId ?? null,
			fields.subject,
			`${id}@example.test`,
			fields.status ?? "active",
			fields.kind ?? "human",
			fields.representedUserId ?? null,
		);
}

function rule(
	id: string,
	fields: {
		org?: string;
		owner?: string;
		reviewStatus?: string;
		usePolicy?: string;
		archivedAt?: string | null;
		visibility?: string;
		cardStyleVersion?: number;
		updatedAt?: string;
	} = {},
) {
	sqlite
		.prepare(
			`INSERT INTO memory_facts
				(id, organization_id, content, fact_type, confidence, status,
				 review_status, use_policy, archived_at, visibility, metadata, updated_at)
			VALUES (?, ?, ?, 'preference', 1, 'active', ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			fields.org ?? ORG,
			`For all email drafts: Prefer short sentences (${id}).`,
			fields.reviewStatus ?? "confirmed",
			fields.usePolicy ?? "can_use_as_instruction",
			fields.archivedAt ?? null,
			fields.visibility ?? "private",
			JSON.stringify({
				cardStyle: { version: fields.cardStyleVersion ?? 1 },
				learningFeed: { ownerUserId: fields.owner ?? OWNER },
			}),
			fields.updatedAt ?? "2026-10-01T00:00:00.000Z",
		);
}

function proposal(
	id: string,
	fields: {
		org?: string;
		scopeKind?: string;
		scopeId?: string;
		subjectKind?: string;
		subjectId: string;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO learning_improvement_proposals
				(id, organization_id, client_proposal_id, scope_kind, scope_id, issue_key,
				 subject_kind, subject_id, promotion_route, recommendation, evidence_event_ids,
				 certification_evidence_refs, proposed_by_type, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'card-style:email', ?, ?, 'personal_memory', 'Prefer short sentences.', '[]', '[]', 'user',
				'2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
		)
		.run(
			id,
			fields.org ?? ORG,
			`client-${id}`,
			fields.scopeKind ?? "personal",
			fields.scopeId ?? OWNER,
			fields.subjectKind ?? "directive",
			fields.subjectId,
		);
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(organizationMembers, memoryFacts, learningImprovementProposals),
	);
	db = createDbQueryClient(createD1Facade(sqlite));
});

describe("resolveCardStyleOwner", () => {
	it("resolves a person by user id or subject to their stable subject", async () => {
		member("m-ada", { userId: "user-ada", subject: OWNER });
		expect(await resolveCardStyleOwner(db, ORG, "user-ada")).toBe(OWNER);
		expect(await resolveCardStyleOwner(db, ORG, OWNER)).toBe(OWNER);
	});

	it("resolves the person a tedi acts for, never the tedi's own membership", async () => {
		member("m-ada", { userId: "user-ada", subject: OWNER });
		member("m-agent", {
			userId: "user-agent",
			subject: "subject-agent",
			kind: "external_agent",
			representedUserId: "user-ada",
		});
		expect(await resolveCardStyleOwner(db, ORG, "user-ada")).toBe(OWNER);
	});

	it("ignores inactive members and other organizations", async () => {
		member("m-gone", {
			userId: "user-gone",
			subject: "subject-gone",
			status: "removed",
		});
		member("m-else", {
			org: OTHER_ORG,
			userId: "user-else",
			subject: "subject-else",
		});
		expect(await resolveCardStyleOwner(db, ORG, "user-gone")).toBe("user-gone");
		expect(await resolveCardStyleOwner(db, ORG, "user-else")).toBe("user-else");
	});

	it("refuses an ambiguous owner", async () => {
		member("m-one", { userId: "shared", subject: "subject-one" });
		member("m-two", { userId: "user-two", subject: "shared" });
		await expect(resolveCardStyleOwner(db, ORG, "shared")).rejects.toThrow(
			"ambiguous",
		);
	});
});

describe("personal card style rules", () => {
	it("lists only the owner's accepted, current rules in the organization", async () => {
		rule("kept-old", { updatedAt: "2026-10-01T00:00:00.000Z" });
		rule("kept-new", { updatedAt: "2026-10-02T00:00:00.000Z" });
		rule("pending", { reviewStatus: "unreviewed" });
		rule("evidence-only", { usePolicy: "can_use_as_evidence" });
		rule("archived", { archivedAt: "2026-10-03T00:00:00.000Z" });
		rule("someone-else", { owner: "subject-grace" });
		rule("other-org", { org: OTHER_ORG });
		rule("shared", { visibility: "org" });
		rule("not-a-style", { cardStyleVersion: 2 });

		const rows = await listPersonalCardStyleRules(db, ORG, OWNER);
		expect(rows.map((row) => row.id)).toEqual(["kept-new", "kept-old"]);
	});

	it("gets a rule only within the owner and organization scope", async () => {
		rule("mine");
		rule("theirs", { owner: "subject-grace" });
		rule("elsewhere", { org: OTHER_ORG });

		expect((await getPersonalCardStyleRule(db, ORG, OWNER, "mine"))?.id).toBe(
			"mine",
		);
		expect(await getPersonalCardStyleRule(db, ORG, OWNER, "theirs")).toBeNull();
		expect(
			await getPersonalCardStyleRule(db, ORG, OWNER, "elsewhere"),
		).toBeNull();
		expect(
			await getPersonalCardStyleRule(db, OTHER_ORG, OWNER, "mine"),
		).toBeNull();
	});

	it("keeps and rejects a rule, and a rejected rule cannot be reviewed again", async () => {
		rule("rule-1", {
			reviewStatus: "unreviewed",
			usePolicy: "can_use_as_evidence",
		});

		const kept = await reviewPersonalCardStyleRule(
			db,
			ORG,
			OWNER,
			"rule-1",
			true,
		);
		expect(kept).toMatchObject({
			reviewStatus: "confirmed",
			usePolicy: "can_use_as_instruction",
			archivedAt: null,
		});
		expect(kept?.lastVerifiedAt).not.toBeNull();

		const keptAgain = await reviewPersonalCardStyleRule(
			db,
			ORG,
			OWNER,
			"rule-1",
			true,
		);
		expect(keptAgain?.reviewStatus).toBe("confirmed");

		const rejected = await reviewPersonalCardStyleRule(
			db,
			ORG,
			OWNER,
			"rule-1",
			false,
		);
		expect(rejected).toMatchObject({
			reviewStatus: "rejected",
			usePolicy: "can_use_as_evidence",
		});
		expect(rejected?.archivedAt).not.toBeNull();

		expect(
			await reviewPersonalCardStyleRule(db, ORG, OWNER, "rule-1", true),
		).toBeNull();
		expect(await listPersonalCardStyleRules(db, ORG, OWNER)).toEqual([]);
	});

	it("never reviews another person's or organization's rule", async () => {
		rule("theirs", { owner: "subject-grace", reviewStatus: "unreviewed" });
		rule("elsewhere", { org: OTHER_ORG, reviewStatus: "unreviewed" });

		expect(
			await reviewPersonalCardStyleRule(db, ORG, OWNER, "theirs", true),
		).toBeNull();
		expect(
			await reviewPersonalCardStyleRule(db, ORG, OWNER, "elsewhere", true),
		).toBeNull();
		const untouched = sqlite
			.prepare("SELECT review_status FROM memory_facts ORDER BY id")
			.all()
			.map((row) => row.review_status);
		expect(untouched).toEqual(["unreviewed", "unreviewed"]);
	});

	it("finds the owner's personal directive proposal for an event", async () => {
		proposal("p-mine", { subjectId: "event-1" });
		proposal("p-theirs", { subjectId: "event-2", scopeId: "subject-grace" });
		proposal("p-org", {
			subjectId: "event-3",
			scopeKind: "organization",
			scopeId: ORG,
		});
		proposal("p-lesson", { subjectId: "event-4", subjectKind: "lesson" });
		proposal("p-elsewhere", { subjectId: "event-5", org: OTHER_ORG });

		expect(
			(await getPersonalCardStyleProposal(db, ORG, OWNER, "event-1"))?.id,
		).toBe("p-mine");
		for (const eventId of ["event-2", "event-3", "event-4", "event-5"]) {
			expect(
				await getPersonalCardStyleProposal(db, ORG, OWNER, eventId),
			).toBeNull();
		}
	});
});

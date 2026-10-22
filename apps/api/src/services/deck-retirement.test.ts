import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import type { BaseContext } from "../rpc/orpc";
import { reviseCardContent } from "./card-revisions";
import { mergeDeckCards, retireDeckCard } from "./deck-retirement";

describe.each([false, true])(
	"retirement graph writer (graph unavailable: %s)",
	(broken) => {
		it("records same_as for each successful merge without failing retirement", async () => {
			const f = fixture();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				f.insert(card, "Same ask");
				f.insert(twin, "Same ask");
				if (broken)
					f.sqlite.exec(
						"CREATE TRIGGER broken_graph BEFORE INSERT ON decision_edges BEGIN SELECT RAISE(ABORT,'unavailable'); END;",
					);
				await mergeDeckCards(f.owner, {
					keepId: twin,
					duplicateIds: [card],
					note: "Same Work",
					evidenceRefs: evidence,
				});
				expect(f.state(card)).toMatchObject({ status: "cancelled" });
				const edges = f.sqlite
					.prepare("SELECT kind,from_id,to_id FROM decision_edges")
					.all();
				if (broken) {
					expect(warn).toHaveBeenCalled();
					expect(edges).toEqual([]);
				} else
					expect(edges).toEqual([
						expect.objectContaining({
							kind: "same_as",
							from_id: card,
							to_id: twin,
						}),
					]);
			} finally {
				warn.mockRestore();
				f.sqlite.close();
			}
		});
		it("points supersedes from the newer card to the successfully retired card", async () => {
			const f = fixture();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				f.insert(card, "Old ask");
				f.insert(twin, "New ask");
				if (broken)
					f.sqlite.exec(
						"CREATE TRIGGER broken_graph BEFORE INSERT ON decision_edges BEGIN SELECT RAISE(ABORT,'unavailable'); END;",
					);
				await retireDeckCard(f.owner, {
					requestId: card,
					reason: "superseded",
					successorId: twin,
					note: "Replaced",
				});
				expect(f.state(card)).toMatchObject({ status: "cancelled" });
				const edges = f.sqlite
					.prepare("SELECT kind,from_id,to_id FROM decision_edges")
					.all();
				if (broken) {
					expect(warn).toHaveBeenCalled();
					expect(edges).toEqual([]);
				} else
					expect(edges).toEqual([
						expect.objectContaining({
							kind: "supersedes",
							from_id: twin,
							to_id: card,
						}),
					]);
			} finally {
				warn.mockRestore();
				f.sqlite.close();
			}
		});
	},
);

const org = "11111111-1111-4111-8111-111111111111";
const work = "22222222-2222-4222-8222-222222222222";
const otherWork = "66666666-6666-4666-8666-666666666666";
const agent = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
const twin = "55555555-5555-4555-8555-555555555555";
const evidence = ["https://example.test/work/evidence"];

function fixture() {
	const sqlite = createMigratedSqlite();
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES('${org}','Fictional','fictional'); INSERT INTO users(id,email) VALUES('person','person@example.test'),('other','other@example.test'); INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('member','${org}','person-sub','person','person@example.test','active','owner'),('other-member','${org}','other-sub','other','other@example.test','active','member'); INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${agent}','${org}','Draft author','draft-author','active'); INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('${work}','${org}','Draft','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z'),('${otherWork}','${org}','Other','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z');`,
	);
	const insert = (
		id: string,
		subject: string,
		metadata: Record<string, unknown> = {},
		workItemId = work,
	) =>
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				id,
				org,
				workItemId,
				"question",
				subject,
				"Original text",
				"tedi",
				agent,
				"user",
				"person",
				"2026-10-19T00:00:00.000Z",
				JSON.stringify(metadata),
			);
	const db = createDbClient(createD1Facade(sqlite));
	const base = {
		db,
		env: { AUTOMATION_EVENTS: { send: async () => {} } },
		headers: new Headers(),
		organizationId: org,
		url: new URL("https://api.example.test/rpc"),
	};
	const user = (id: string) =>
		({
			...base,
			authType: "user",
			userId: id,
			userRole: id === "person" ? "owner" : "member",
			user: { sub: `${id}-sub` },
		}) as BaseContext;
	return {
		sqlite,
		insert,
		agentContext: {
			...base,
			authType: "service-binding",
			tediId: agent,
			tediScopes: ["mcp:messaging.read", "mcp:messaging.write"],
			headers: new Headers({ "X-Service-Binding": "true" }),
		} as BaseContext,
		owner: user("person"),
		other: user("other"),
		state: (id: string) =>
			sqlite
				.prepare("SELECT status,version FROM work_interactions WHERE id=?")
				.get(id),
		responses: () =>
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get(),
	};
}

it("copies the migrated fixture without replaying DDL for each card", () => {
	fixture().sqlite.close();
	const exec = vi.spyOn(DatabaseSync.prototype, "exec");
	try {
		fixture().sqlite.close();
		expect(
			exec.mock.calls.some(([sql]) => /\b(?:CREATE|ALTER|DROP)\b/i.test(sql)),
		).toBe(false);
	} finally {
		exec.mockRestore();
	}
});

it("lets the recipient retire a card without a successor, without answering it, and undo it", async () => {
	const f = fixture();
	try {
		f.insert(card, "Confirm the VAT filing?");
		const result = await retireDeckCard(f.owner, {
			requestId: card,
			reason: "handled_elsewhere",
			note: "Confirmed with the accountant by phone",
		});
		expect(result).toMatchObject({
			requestId: card,
			reason: "handled_elsewhere",
			undo: { restoreRevision: result.revision - 1 },
		});
		expect(f.state(card)).toMatchObject({ status: "cancelled" });
		expect(f.responses()).toMatchObject({ n: 0 });
		const curation = JSON.parse(
			String(
				(
					f.sqlite
						.prepare("SELECT metadata FROM work_interactions WHERE id=?")
						.get(card) as { metadata: string }
				).metadata,
			),
		).curation;
		expect(curation.retirement).toEqual({
			reason: "handled_elsewhere",
			workItemId: null,
		});
		await reviseCardContent(f.owner, result.undo);
		expect(f.state(card)).toMatchObject({ status: "open" });
	} finally {
		f.sqlite.close();
	}
});

it("lets the owning agent retire its non-critical card with evidence only", async () => {
	const f = fixture();
	try {
		f.insert(card, "Review the weekly summary?");
		await expect(
			retireDeckCard(f.agentContext, {
				requestId: card,
				reason: "expired",
				note: "The test link expired on 18 October",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await retireDeckCard(f.agentContext, {
			requestId: card,
			reason: "expired",
			note: "The test link expired on 18 October",
			evidenceRefs: evidence,
		});
		expect(f.state(card)).toMatchObject({ status: "cancelled" });
	} finally {
		f.sqlite.close();
	}
});

it("keeps critical cards with the recipient but lets an agent fold its protected duplicate", async () => {
	const f = fixture();
	try {
		f.insert(card, "Approve the payment?", { protectedEffects: ["money"] });
		f.insert(twin, "Approve the payment?", { protectedEffects: ["money"] });
		await expect(
			retireDeckCard(f.agentContext, {
				requestId: card,
				reason: "no_longer_relevant",
				note: "Looks stale",
				evidenceRefs: evidence,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const merged = await mergeDeckCards(f.agentContext, {
			keepId: twin,
			duplicateIds: [card],
			note: "Deadline automation asked twice",
			evidenceRefs: evidence,
		});
		expect(merged.keptId).toBe(twin);
		expect(f.state(card)).toMatchObject({ status: "cancelled" });
		expect(f.state(twin)).toMatchObject({ status: "open" });
		await retireDeckCard(f.owner, {
			requestId: twin,
			reason: "no_longer_relevant",
			note: "Paid by bank transfer",
		});
		expect(f.state(twin)).toMatchObject({ status: "cancelled" });
	} finally {
		f.sqlite.close();
	}
});

it("refuses merges that would drop protection or join different asks", async () => {
	const f = fixture();
	try {
		f.insert(card, "Approve the payment?", { protectedEffects: ["money"] });
		f.insert(twin, "Review the summary?");
		await expect(
			mergeDeckCards(f.owner, {
				keepId: twin,
				duplicateIds: [card],
				note: "Same ask",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const third = "77777777-7777-4777-8777-777777777777";
		f.insert(third, "Review the summary?", {}, otherWork);
		await expect(
			mergeDeckCards(f.owner, {
				keepId: third,
				duplicateIds: [twin],
				note: "Same ask",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			retireDeckCard(f.other, {
				requestId: twin,
				reason: "no_longer_relevant",
				note: "Not mine",
				evidenceRefs: evidence,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(f.state(twin)).toMatchObject({ status: "open" });
	} finally {
		f.sqlite.close();
	}
});

it("lets an agent retire its own protected ask once the ask has hard-expired", async () => {
	const f = fixture();
	try {
		const decision = (expiresAt: string) => ({
			decisionDeck: {
				version: 1,
				kind: "decision",
				classId: "auth.test-link",
				proposal: "Generate a test sign-in link",
				whyNow: "A test needs a sign-in link",
				recommendation: "Let the link expire",
				reversibility: "two_way",
				protectedEffects: ["consent"],
				blastRadius: "One fictional test account",
				confidence: null,
				costOfWaiting: "None",
				expiresAt,
				reasoning: "A test needs a sign-in link",
				options: ["approve", "reject"].map((intent) => ({
					id: intent,
					label: intent,
					intent,
					consequence: "Fictional",
					cost: "None",
				})),
			},
		});
		f.insert(
			card,
			"Retire the expired test sign-in request?",
			decision("2026-10-18T12:00:00.000Z"),
		);
		f.insert(
			twin,
			"Approve the test sign-in request?",
			decision("2999-01-01T00:00:00.000Z"),
		);
		await expect(
			retireDeckCard(f.agentContext, {
				requestId: twin,
				reason: "expired",
				note: "Not expired yet",
				evidenceRefs: evidence,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await retireDeckCard(f.agentContext, {
			requestId: card,
			reason: "expired",
			note: "The test link expired on 18 October",
			evidenceRefs: evidence,
		});
		expect(f.state(card)).toMatchObject({ status: "cancelled" });
	} finally {
		f.sqlite.close();
	}
});

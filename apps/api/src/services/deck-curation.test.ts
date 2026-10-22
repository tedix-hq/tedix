import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	curateDeckCard,
	curationInbox,
	rankCurationInbox,
} from "./deck-curation";
import { reviseCardContent } from "./card-revisions";

const org = "11111111-1111-4111-8111-111111111111";
const work = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
function fixture(metadata: Record<string, unknown> = {}) {
	const sqlite = createMigratedSqlite();
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES('${org}','Fictional','fictional'); INSERT INTO users(id,email) VALUES('person','person@example.test'),('other','other@example.test'); INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('member','${org}','person-sub','person','person@example.test','active','owner'),('other-member','${org}','other-sub','other','other@example.test','active','member'); INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${agent}','${org}','Draft author','draft-author','active'); INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('${work}','${org}','Draft','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z'); INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('${card}','${org}','${work}','question','Review this draft?','Original text','tedi','${agent}','user','person','2026-10-19T00:00:00.000Z');`,
	);
	sqlite.prepare("UPDATE organizations SET metadata=? WHERE id=?").run(
		JSON.stringify({
			decisionLearning: {
				deckCurators: [
					{
						tediId: agent,
						recipientId: "person",
						gadgetId: work,
						enabled: true,
					},
				],
			},
		}),
		org,
	);
	if (Object.keys(metadata).length) {
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				successor,
				org,
				work,
				"question",
				"Critical decision?",
				"Money requires you",
				"tedi",
				agent,
				"user",
				"person",
				"2026-10-19T00:00:00.000Z",
				JSON.stringify(metadata),
			);
	}
	const db = createDbClient(createD1Facade(sqlite));
	const sent: unknown[] = [];
	const base = {
		db,
		env: {
			AUTOMATION_EVENTS: {
				send: async (event: unknown) => {
					sent.push(event);
				},
			},
		},
		headers: new Headers(),
		organizationId: org,
		url: new URL("https://api.example.test/rpc"),
	};
	return {
		sqlite,
		context: {
			...base,
			authType: "service-binding",
			tediId: agent,
			tediScopes: ["mcp:messaging.read", "mcp:messaging.write"],
			headers: new Headers({ "X-Service-Binding": "true" }),
		} as BaseContext,
		humanContext: {
			...base,
			authType: "user",
			userId: "person",
			userRole: "owner",
			user: { sub: "person-sub" },
		} as BaseContext,
		sent,
	};
}
const scope = { recipientId: "person", gadgetId: work };
const input = {
	...scope,
	requestId: card,
	expectedRequestVersion: 1,
	expectedRevision: 0,
	reason: "A newer template replaces this draft",
	evidenceRefs: ["https://example.test/new-template"],
};
const successor = "55555555-5555-4555-8555-555555555555";
it("skips recently revised cards during writes and ranking", async () => {
	const { sqlite, context } = fixture();
	try {
		await curateDeckCard(context, { ...input, body: "Reviewed story." });
		const cutoff = new Date(Date.now() - 3600000).toISOString();
		await expect(
			curateDeckCard(context, {
				...input,
				expectedRequestVersion: 2,
				expectedRevision: 2,
				skipRevisedSince: cutoff,
				body: "Do not overwrite the morning review.",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const result = await rankCurationInbox(context, {
			...scope,
			skipRevisedSince: cutoff,
		});
		expect(result.signals).toEqual([
			{
				cardId: card,
				label: null,
				penalty: 0,
				reason: "recently_revised",
				exampleIds: [],
			},
		]);
		expect(result.reservedMicros).toBe(0);
	} finally {
		sqlite.close();
	}
});
it("enforces the active recipient and gadget grant, and withholds decision actions", async () => {
	const { sqlite, context } = fixture();
	try {
		const inbox = await curationInbox(context, scope);
		expect(inbox.complete).toBe(true);
		expect(inbox.items).toHaveLength(1);
		expect(inbox.items[0]).toMatchObject({
			canRespond: false,
			canCancel: false,
		});
		await expect(
			curateDeckCard(context, {
				...input,
				gadgetId: successor,
				body: "Short story.",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			curateDeckCard(context, {
				...input,
				recipientId: "other",
				body: "Short story.",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite
			.prepare("UPDATE organizations SET metadata='{}' WHERE id=?")
			.run(org);
		await expect(
			curateDeckCard(context, { ...input, body: "Short story." }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
it("supersedes without responding and restores through immutable card history", async () => {
	const { sqlite, context, humanContext } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) SELECT ?,org_id,work_item_id,kind,'Newer template','The replacement template',creator_type,creator_id,target_type,target_id,created_at FROM work_interactions WHERE id=?",
			)
			.run(successor, card);
		const revision = await curateDeckCard(context, {
			...input,
			body: "The team needs one current template. Recommend the linked replacement because it supersedes this draft today.",
			successorId: successor,
		});
		expect(revision.revision).toBe(2);
		expect(JSON.parse(revision.instruction!).successorId).toBe(successor);
		expect(
			sqlite
				.prepare("SELECT status,version FROM work_interactions WHERE id=?")
				.get(card),
		).toMatchObject({ status: "cancelled", version: 2 });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get(),
		).toMatchObject({ n: 0 });
		await expect(
			curateDeckCard(context, { ...input, body: "Stale write." }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const restored = await reviseCardContent(humanContext, {
			requestId: card,
			expectedRequestVersion: 2,
			expectedRevision: 2,
			restoreRevision: 1,
		});
		expect(restored).toMatchObject({
			revision: 3,
			body: "Original text",
			cause: "restore",
		});
		expect(
			sqlite
				.prepare("SELECT status,version FROM work_interactions WHERE id=?")
				.get(card),
		).toMatchObject({ status: "open", version: 3 });
		expect((await curationInbox(context, scope)).items).toHaveLength(2);
	} finally {
		sqlite.close();
	}
});
it("preserves the latest human draft when curation resumes after an edit", async () => {
	const { sqlite, context, humanContext } = fixture();
	try {
		const first = await curateDeckCard(context, {
			...input,
			body: "First summary.",
		});
		expect(JSON.parse(first.instruction!).draftBody).toBe("Original text");
		await reviseCardContent(humanContext, {
			requestId: card,
			expectedRequestVersion: 2,
			expectedRevision: 2,
			body: "Human edited draft",
		});
		const next = await curateDeckCard(context, {
			...input,
			expectedRequestVersion: 3,
			expectedRevision: 3,
			body: "New summary.",
		});
		expect(JSON.parse(next.instruction!).draftBody).toBe("Human edited draft");
	} finally {
		sqlite.close();
	}
});

it("refuses critical supersession and long stories", async () => {
	const { sqlite, context } = fixture({ protectedEffects: ["money"] });
	try {
		await expect(
			curateDeckCard(context, {
				...input,
				body: Array(61).fill("word").join(" "),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			curateDeckCard(context, {
				...input,
				requestId: successor,
				successorId: card,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});

const editedFace = {
	version: 2 as const,
	title: "Review the account access?",
	context: "Only you can change the account settings.",
	body: "Keeps the remaining manual steps visible.",
	recommendation: "Check the audit before making changes.",
};
it("lets the recipient correct a credential card's face without a gadget grant or creator session, with audit", async () => {
	const { sqlite, humanContext } = fixture({
		secureAction: true,
		deadlineBasis: "Owner triage/review target; no source deadline.",
	});
	try {
		sqlite
			.prepare("UPDATE organizations SET metadata='{}' WHERE id=?")
			.run(org);
		const { gadgetId: _, ...baseInput } = input;
		const ownerInput = { ...baseInput, requestId: successor };
		const revision = await curateDeckCard(humanContext, {
			...ownerInput,
			presentation: editedFace,
		});
		expect(revision).toMatchObject({
			cause: "agent_rewrite",
			actorType: "user",
			actorId: "person",
			revision: 2,
		});
		expect(JSON.parse(revision.summary!)).toMatchObject({
			faceAfter: editedFace,
		});
		const stored = sqlite
			.prepare(
				"SELECT subject,prompt,status,version,metadata FROM work_interactions WHERE id=?",
			)
			.get(successor)!;
		expect(stored).toMatchObject({
			subject: "Critical decision?",
			prompt: "Money requires you",
			status: "open",
			version: 2,
		});
		expect(JSON.parse(String(stored.metadata))).toMatchObject({
			secureAction: true,
		});
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get()?.n,
		).toBe(0);
		const { prepareDeckCardFaces } = await import("./deck-card-face");
		const { requestOutput } = await import("../rpc/routers/work-interactions");
		const { getWorkInteraction } =
			await import("@tedix/db/queries/work-items/interactions");
		const request = await getWorkInteraction(humanContext.db, {
			orgId: org,
			interactionId: successor,
		});
		const { listDecisionCardPresentations } =
			await import("@tedix/db/queries/work-items/card-presentation");
		const faces = await listDecisionCardPresentations(humanContext.db, {
			orgId: org,
			personId: "person",
			requests: [request!],
		});
		const [display] = await prepareDeckCardFaces(humanContext, [
			{
				id: successor,
				requestedAt: request!.createdAt,
				label: request!.subject,
				kind: "question",
				decision: null,
				dueAt: null,
				project: work,
				score: 0,
				urgency: "later",
				source: "/work",
				interaction: {
					request: requestOutput(
						request!,
						undefined,
						undefined,
						faces[0]!.presentation,
					),
					effectiveState: "open",
					canRespond: true,
					canCancel: false,
					workItem: null,
					responseCount: 0,
				},
			},
		]);
		expect(display?.presentation).toMatchObject(editedFace);
		expect(display?.faceText).toContain(editedFace.body);
		await expect(
			curateDeckCard(humanContext, { ...ownerInput, presentation: editedFace }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	} finally {
		sqlite.close();
	}
});
it("allows a scoped curator to edit ordinary faces but protects credential cards and foreign recipients", async () => {
	const { sqlite, context, humanContext } = fixture({ secureAction: true });
	try {
		await curateDeckCard(context, { ...input, presentation: editedFace });
		expect(
			JSON.parse(
				String(
					sqlite
						.prepare(
							"SELECT presentation FROM work_interaction_card_presentations WHERE interaction_id=?",
						)
						.get(card)?.presentation,
				),
			),
		).toMatchObject(editedFace);
		await expect(
			curateDeckCard(context, {
				...input,
				requestId: successor,
				presentation: editedFace,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			curateDeckCard(humanContext, {
				...input,
				recipientId: "other",
				presentation: editedFace,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
it("rejects secrets and executable changes in a face correction before writing a revision", async () => {
	const { sqlite, humanContext } = fixture();
	try {
		await expect(
			curateDeckCard(humanContext, {
				...input,
				presentation: { ...editedFace, body: `sk-${"fictional".repeat(5)}` },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			curateDeckCard(humanContext, {
				...input,
				presentation: editedFace,
				handleInternally: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			curateDeckCard(humanContext, {
				...input,
				presentation: editedFace,
				body: "Replace the underlying action.",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_card_revisions")
				.get()?.n,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});

it("preserves the curated source snapshot when the recipient directly corrects the face", async () => {
	const { sqlite, context, humanContext } = fixture();
	try {
		await curateDeckCard(context, {
			...input,
			body: "A shorter story for the card.",
		});
		const { gadgetId: _, ...ownerInput } = input;
		await curateDeckCard(humanContext, {
			...ownerInput,
			expectedRequestVersion: 2,
			expectedRevision: 2,
			presentation: editedFace,
		});
		const metadata = JSON.parse(
			String(
				sqlite
					.prepare("SELECT metadata FROM work_interactions WHERE id=?")
					.get(card)?.metadata,
			),
		);
		const { currentDeckCuration } =
			await import("@tedix/api-contract/utils/deck-curator");
		expect(currentDeckCuration(metadata)).toMatchObject({
			revision: 3,
			draftBody: "Original text",
			status: "open",
		});
		expect(metadata.cardContent).toBe("A shorter story for the card.");
	} finally {
		sqlite.close();
	}
});

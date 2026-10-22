import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { workItems } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { setDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import {
	RecordAgentDecisionInputSchema,
	RecordAgentDecisionOutcomeInputSchema,
	type RecordAgentDecisionInput,
} from "@tedix/api-contract/schemas/agent-decisions";
import type { BaseContext } from "../rpc/orpc";
import {
	AGENT_MISTAKE_SURFACE,
	agentDecisionFeed,
	listAgentDecisions,
	recordAgentDecision,
	recordAgentDecisionOutcome,
	runAgentDecisionMorningReview,
} from "./agent-decision-journal";
import { WORK_FIX_LEARNING_SURFACE } from "./learning-feed-miner";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const WORK = "00000000-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-22T07:20:00.000Z");

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			decisionEdges,
			learningInteractionEvents,
			workItems,
			workInteractions,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?)")
		.run(ORG, "Harbor", "harbor");
	const db = createDbQueryClient(createD1Facade(sqlite));
	const context = {
		db,
		authType: "user",
		user: { sub: "river-sub" },
	} as unknown as BaseContext;
	return { sqlite, db, context };
}

async function seed(f: ReturnType<typeof fixture>) {
	await f.db.insert(organizationMembers).values({
		id: "member",
		organizationId: ORG,
		userId: "river",
		descopeUserId: "river-sub",
		email: "river@harbor.test",
		role: "owner",
		status: "active",
	});
	await f.db.insert(workItems).values({
		id: WORK,
		orgId: ORG,
		title: "Fictional release train",
		createdAt: NOW.toISOString(),
	});
}

function decisionInput(
	overrides: Partial<RecordAgentDecisionInput> = {},
): RecordAgentDecisionInput {
	return RecordAgentDecisionInputSchema.parse({
		agentSession: "claude-code:11111111-2222-4333-8444-555566667777",
		agentName: "Lead",
		decisionClass: "lane.pause",
		question: "Pause the idle review lane?",
		options: [
			{ id: "pause", label: "Pause it" },
			{ id: "keep", label: "Keep it running" },
		],
		chosen: "pause",
		reason: "Idle for an hour while holding two slots.",
		reversibility: "two_way",
		confidence: 0.85,
		workItemId: WORK,
		commitShas: ["abc1234def"],
		occurredAt: "2026-10-22T02:00:00.000Z",
		...overrides,
	});
}

describe("agent decision journal", () => {
	it("records a decision as a learning event and graph links, idempotently", async () => {
		const f = fixture();
		await seed(f);
		const first = await recordAgentDecision(
			f.context,
			ORG,
			decisionInput(),
			NOW,
		);
		expect(first).toMatchObject({
			duplicate: false,
			classId: "agent:lead:lane.pause",
			needsPerson: false,
			askable: false,
			edgesWritten: 3,
			notice: null,
		});
		const again = await recordAgentDecision(
			f.context,
			ORG,
			decisionInput(),
			NOW,
		);
		expect(again).toMatchObject({
			decisionId: first.decisionId,
			duplicate: true,
		});

		const [event] = await f.db.select().from(learningInteractionEvents);
		expect(event).toMatchObject({
			id: first.decisionId,
			eventKind: "decided",
			surface: "agent_decision",
			issueKey: "agent:lead:lane.pause",
			actorType: "user",
			actorId: "river-sub",
			threadId: "claude-code:11111111-2222-4333-8444-555566667777",
			scopeKind: "organization",
		});
		expect(event?.metadata).toMatchObject({
			decision: { kind: "decision", recommendation: "Chose: Pause it" },
		});
		const edges = await f.db.select().from(decisionEdges);
		expect(
			edges.map((edge) => `${edge.kind}:${edge.toKind}:${edge.toId}`).sort(),
		).toEqual([
			"about:work_item:" + WORK,
			"decided_by:agent:lead",
			"evidence:commit:abc1234def",
		]);
		expect(edges.every((edge) => edge.fromId === first.decisionId)).toBe(true);
		f.sqlite.close();
	});

	it("flags decisions that need a person without granting anything and links a superseded one", async () => {
		const f = fixture();
		await seed(f);
		const prior = await recordAgentDecision(
			f.context,
			ORG,
			decisionInput(),
			NOW,
		);
		const result = await recordAgentDecision(
			f.context,
			ORG,
			decisionInput({
				decisionClass: "deploy.canary",
				question: "Run the canary on production now?",
				options: [
					{ id: "run", label: "Run now" },
					{ id: "wait", label: "Wait" },
				],
				chosen: "run",
				protectedEffects: ["production"],
				reversibility: "one_way",
				priorDecisionId: prior.decisionId,
				priorRelation: "supersedes",
				commitShas: [],
			}),
			NOW,
		);
		expect(result).toMatchObject({ needsPerson: true, askable: true });
		expect(result.notice).toContain("ask through an approval");
		const supersedes = await f.db.select().from(decisionEdges);
		expect(supersedes.find((edge) => edge.kind === "supersedes")).toMatchObject(
			{ fromId: result.decisionId, toId: prior.decisionId },
		);
		expect(await f.db.select().from(workInteractions)).toHaveLength(0);
		f.sqlite.close();
	});

	it("rejects unknown Work, foreign earlier decisions and far backdates", async () => {
		const f = fixture();
		await seed(f);
		await expect(
			recordAgentDecision(
				f.context,
				ORG,
				decisionInput({ workItemId: "00000000-0000-4000-8000-0000000000cc" }),
				NOW,
			),
		).rejects.toThrow(/Work item not found/);
		await expect(
			recordAgentDecision(
				f.context,
				ORG,
				decisionInput({
					priorDecisionId: "00000000-0000-4000-8000-0000000000dd",
				}),
				NOW,
			),
		).rejects.toThrow(/Earlier decision not found/);
		await expect(
			recordAgentDecision(
				f.context,
				ORG,
				decisionInput({ occurredAt: "2026-08-01T00:00:00.000Z" }),
				NOW,
			),
		).rejects.toThrow(/last 30 days/);
		f.sqlite.close();
	});

	it("rate-limits one Agent-Session per hour by the organization's config", async () => {
		const f = fixture();
		await seed(f);
		await setDecisionLearningConfig(
			f.db,
			ORG,
			DecisionLearningConfigSchema.parse({
				agentDecisions: { perSessionHourlyLimit: 2 },
			}),
		);
		const now = new Date();
		for (const question of ["One?", "Two?"])
			await recordAgentDecision(
				f.context,
				ORG,
				decisionInput({ question, occurredAt: undefined }),
				now,
			);
		await expect(
			recordAgentDecision(
				f.context,
				ORG,
				decisionInput({ question: "Three?", occurredAt: undefined }),
				now,
			),
		).rejects.toThrow(/last hour/);
		await recordAgentDecision(
			f.context,
			ORG,
			decisionInput({
				question: "Other session?",
				occurredAt: undefined,
				agentSession: "codex:other-session",
			}),
			now,
		);
		f.sqlite.close();
	});

	it("records a person's undo as a correction and an agent-mistake signal", async () => {
		const f = fixture();
		await seed(f);
		const { decisionId } = await recordAgentDecision(
			f.context,
			ORG,
			decisionInput(),
			NOW,
		);
		const outcome = await recordAgentDecisionOutcome(
			f.context,
			ORG,
			RecordAgentDecisionOutcomeInputSchema.parse({
				decisionId,
				outcome: "reverted",
				evidence: "Restarted the lane by hand; the queue needed it.",
				by: "person",
				commitShas: ["fedcba98"],
				occurredAt: "2026-10-22T06:00:00.000Z",
			}),
			NOW,
		);
		expect(outcome).toMatchObject({ correction: true, mistakeRecorded: true });
		expect(AGENT_MISTAKE_SURFACE).toBe(WORK_FIX_LEARNING_SURFACE);
		const events = await f.db.select().from(learningInteractionEvents);
		expect(events.find((e) => e.surface === "work_fix")).toMatchObject({
			eventKind: "undone",
			issueKey: "agent-mistake:lane.pause",
			targetId: decisionId,
		});
		expect(events.find((e) => e.id === outcome.outcomeEventId)).toMatchObject({
			eventKind: "undone",
			targetType: "agent_decision",
		});
		const listed = await listAgentDecisions(f.context, ORG, { limit: 10 }, NOW);
		expect(listed.decisions[0]?.outcome).toMatchObject({
			outcome: "reverted",
			by: "person",
		});
		expect(listed.classes[0]).toMatchObject({
			classId: "agent:lead:lane.pause",
			status: "corrected",
			corrections: 1,
		});
		await expect(
			recordAgentDecisionOutcome(
				f.context,
				ORG,
				RecordAgentDecisionOutcomeInputSchema.parse({
					decisionId: "00000000-0000-4000-8000-0000000000ee",
					outcome: "worked",
					evidence: "n/a",
				}),
				NOW,
			),
		).rejects.toThrow(/not found/);
		f.sqlite.close();
	});

	it("puts the viewer's own agents' decisions in their Feed", async () => {
		const f = fixture();
		await seed(f);
		await recordAgentDecision(f.context, ORG, decisionInput(), NOW);
		const items = await agentDecisionFeed(f.context, ORG, NOW);
		expect(items).toEqual([
			expect.objectContaining({
				kind: "result",
				needsAction: false,
				sentence: expect.stringContaining("Decided by Lead"),
			}),
		]);
		const other = {
			...f.context,
			user: { sub: "someone-else" },
		} as unknown as BaseContext;
		expect(await agentDecisionFeed(other, ORG, NOW)).toEqual([]);
		f.sqlite.close();
	});

	it("creates one morning review card per person and day, only when something needs a look", async () => {
		const f = fixture();
		await seed(f);
		await recordAgentDecision(f.context, ORG, decisionInput(), NOW);
		const early = new Date("2026-10-22T06:00:00.000Z");
		expect(await runAgentDecisionMorningReview(f.db, early)).toEqual({
			agentDecisionReviews: 0,
		});
		// Only routine decisions: Feed digest, no card.
		expect(await runAgentDecisionMorningReview(f.db, NOW)).toEqual({
			agentDecisionReviews: 0,
		});
		await recordAgentDecision(
			f.context,
			ORG,
			decisionInput({
				question: "Raise the lane cap to 24?",
				confidence: 0.4,
				occurredAt: "2026-10-22T03:00:00.000Z",
			}),
			NOW,
		);
		// Off the ten-minute grid: skipped.
		expect(
			await runAgentDecisionMorningReview(
				f.db,
				new Date("2026-10-22T07:25:00.000Z"),
			),
		).toEqual({ agentDecisionReviews: 0 });
		expect(await runAgentDecisionMorningReview(f.db, NOW)).toEqual({
			agentDecisionReviews: 1,
		});
		expect(
			await runAgentDecisionMorningReview(
				f.db,
				new Date("2026-10-22T09:00:00.000Z"),
			),
		).toEqual({ agentDecisionReviews: 0 });
		const cards = await f.db.select().from(workInteractions);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			kind: "question",
			targetType: "user",
			targetId: "river",
			workItemId: WORK,
		});
		expect(cards[0]?.metadata).toMatchObject({
			source: "agent-decision-review",
			decisionDeck: { classId: "agent-decisions.review", protectedEffects: [] },
		});
		const prompt = String(cards[0]?.prompt ?? "");
		expect(prompt.split("\n\n")[0]!.split(/\s+/).length).toBeLessThanOrEqual(
			60,
		);
		f.sqlite.close();
	});
});

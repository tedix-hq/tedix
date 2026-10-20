import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { projects } from "@tedix/db/schema/projects";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { agentSessionRequests } from "@tedix/db/schema/agent-session-requests";
import {
	learningInteractionEvents,
	learningImprovementProposals,
} from "@tedix/db/schema/learning-feedback";
import { recordAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "@tedix/db/schema/external-agent-identity";
import {
	workItems,
	workEvents,
	workItemComments,
	workAttempts,
} from "@tedix/db/schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
	workInteractionReplyDrafts,
} from "@tedix/db/schema/work-factory";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	createWorkInteraction,
	respondToWorkInteraction,
	type RespondWorkInteractionParams,
} from "@tedix/db/queries/work-items/interactions";
import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { executeDecisionCardEffect } from "./decision-card-effects";

const org = "00000000-0000-4000-8000-000000000001";
const work = "00000000-0000-4000-8000-000000000002";
const otherWork = "00000000-0000-4000-8000-000000000003";
const envelope: DecisionEnvelope = {
	version: 1,
	kind: "adr",
	classId: "architecture.contract",
	proposal: "Keep the reviewed contract boundary",
	whyNow: "The contract shipped today",
	recommendation: "Approve the documented boundary",
	reversibility: "one_way",
	tasteOrStrategy: true,
	protectedEffects: ["contract"],
	blastRadius: "Public clients",
	confidence: 0.9,
	costOfWaiting: "Future changes lack a recorded rationale",
	reasoning: "The immutable source documents the boundary",
	lessons: [],
	options: [
		{
			id: "approve",
			label: "Approve",
			intent: "approve",
			consequence: "Record this architecture approval",
			cost: "None",
			effect: {
				kind: "record_adr",
				workItemId: work,
				commitSha: "a".repeat(40),
			},
		},
		{
			id: "later",
			label: "Later",
			intent: "later",
			consequence: "Leave the decision open",
			cost: "Review later",
		},
	],
};

async function fixture(decision = envelope, cardContent?: string) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workItemComments,
			workAttempts,
			projects,
			userConfigs,
			agentSessionRequests,
			learningInteractionEvents,
			learningImprovementProposals,
			workInteractions,
			workInteractionResponses,
			organizationMembers,
			tedis,
		),
	);
	sqlite.exec(
		schemaDdl(
			workInteractionReplyDrafts,
			externalAgentPrincipals,
			externalAgentSessions,
		),
	);
	const migration = readFileSync(
		new URL(
			"../../../../packages/db/drizzle/20261010144722_auto_reply_resolves_question/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	for (const name of [
		"work_interaction_response_insert_guard",
		"work_interaction_response_apply",
	]) {
		const statement = migration
			.split("--> statement-breakpoint")
			.find((s) => s.trimStart().startsWith(`CREATE TRIGGER \`${name}\``));
		if (!statement) throw new Error(`Missing production trigger: ${name}`);
		sqlite.exec(statement);
	}
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
		)
		.run(work, org, "Acme contract", "2026-10-17T00:00:00.000Z");
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
		)
		.run(
			otherWork,
			"other-org",
			"Other tenant contract",
			"2026-10-17T00:00:00.000Z",
		);
	sqlite
		.prepare(
			"INSERT INTO organization_members (id,organization_id,user_id,descope_user_id,email,role,status) VALUES (?,?,?,?,?,?,'active')",
		)
		.run("membership", org, "person", "subject", "person@acme.test", "owner");
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	const context = {
		db,
		env: {
			DB: facade,
			ENVIRONMENT: "test",
			AUTOMATION_EVENTS: { send: async () => {} },
		},
		authType: "user",
		userId: "person",
		userRole: "owner",
		user: { sub: "subject" },
		headers: new Headers(),
		url: new URL("https://api.acme.test/rpc"),
		organizationId: org,
	} as BaseContext;
	const request = await createWorkInteraction(db, {
		id: crypto.randomUUID(),
		orgId: org,
		workItemId: work,
		kind: "question",
		subject: decision.proposal,
		prompt: decision.reasoning,
		creator: { type: "user", id: "person" },
		targetType: "user",
		targetId: "person",
		metadata: {
			decisionDeck: decision,
			...(cardContent ? { cardContent } : {}),
		},
		now: new Date().toISOString(),
	});
	const input: Omit<RespondWorkInteractionParams, "id" | "now"> = {
		orgId: org,
		interactionId: request.id,
		expectedVersion: 1,
		responder: { type: "user", id: "person" },
		responseKind: "answer",
		body: "Approved the boundary",
		resolvesRequest: true,
		metadata: {
			source: "os-decision-card",
			cardAction: "approve",
			decisionChoice: "approve",
			feedbackSignal: "approve-as-is",
		},
	};
	return { sqlite, db, context, input };
}

describe("decision card effects", () => {
	it("refuses to execute an old effect after the written proposal is revised", async () => {
		const f = await fixture(
			envelope,
			"A revised proposal that needs a source review",
		);
		await expect(
			executeDecisionCardEffect(f.context, f.input),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get()?.n,
		).toBe(0);
		f.sqlite.close();
	});
	it("creates an owner task with the unsent draft and never sends a message", async () => {
		const decision = structuredClone(envelope);
		decision.kind = "proposal";
		decision.options[0]!.effect = {
			kind: "create_owner_task",
			workItemId: work,
			title: "Send the follow-up to Morgan",
			description:
				"Draft for Morgan: Shall we catch up next week? Send manually after checking the profile.",
		};
		const f = await fixture(decision);
		f.sqlite
			.prepare(
				"update work_items set work_class='maintenance', purpose_exception_expires_at=? where id=?",
			)
			.run(new Date(Date.now() + 86400000).toISOString(), work);
		const result = await executeDecisionCardEffect(f.context, f.input);
		expect(result.metadata?.decisionEffect).toMatchObject({
			kind: "create_owner_task",
			status: "succeeded",
			state: "proposed",
		});
		const task = f.sqlite
			.prepare("select * from work_items where parent_work_item_id=?")
			.get(work);
		expect(task).toMatchObject({
			accountable_owner_type: "user",
			accountable_owner_id: "person",
			disposition: "proposed",
			title: "Send the follow-up to Morgan",
		});
		expect(task?.description).toContain("Draft for Morgan");
		await expect(
			executeDecisionCardEffect(f.context, { ...f.input, expectedVersion: 2 }),
		).rejects.toThrow();
		expect(
			f.sqlite
				.prepare(
					"select count(*) as n from work_items where parent_work_item_id=?",
				)
				.get(work)?.n,
		).toBe(1);
		f.sqlite.close();
	});
	it.each(["accept_work", "complete_work"] as const)(
		"executes %s through the existing Work lifecycle",
		async (kind) => {
			const decision = structuredClone(envelope);
			decision.options[0]!.effect =
				kind === "accept_work"
					? {
							kind,
							workItemId: work,
							doneLooksLike: "The supplier summary is reviewed",
						}
					: { kind, workItemId: work };
			const f = await fixture(decision);
			if (kind === "complete_work")
				f.sqlite
					.prepare("update work_items set disposition='accepted' where id=?")
					.run(work);
			const result = await executeDecisionCardEffect(f.context, f.input);
			expect(result.metadata?.decisionEffect).toMatchObject({
				kind,
				status: "succeeded",
				state: kind === "accept_work" ? "accepted" : "completed",
			});
			expect(
				f.sqlite
					.prepare("select disposition from work_items where id=?")
					.get(work)?.disposition,
			).toBe(kind === "accept_work" ? "accepted" : "completed");
			f.sqlite.close();
		},
	);
	it("corrects a private filing and leaves a learning proposal", async () => {
		const projectId = "00000000-0000-4000-8000-000000000004";
		const requestId = "00000000-0000-4000-8000-000000000005";
		const decision = structuredClone(envelope);
		decision.options[0]!.effect = {
			kind: "file_request",
			requestId,
			projectId: null,
			expectedProjectId: projectId,
		};
		const f = await fixture(decision);
		await f.db.insert(projects).values({
			id: projectId,
			orgId: org,
			key: "DOCS",
			name: "Acme Docs",
			createdAt: new Date().toISOString(),
		});
		const [row] = await recordAgentSessionRequests(f.db, {
			organizationId: org,
			userId: "person",
			harness: "codex",
			sessionKey: "acme-session",
			sourceKey: "acme-request",
			sourceAt: new Date().toISOString(),
			now: new Date().toISOString(),
			requests: [{ kind: "request", text: "Review the supplier destination" }],
		});
		f.sqlite
			.prepare("update agent_session_requests set id=?,project_id=? where id=?")
			.run(requestId, projectId, row!.id);
		const result = await executeDecisionCardEffect(f.context, f.input);
		expect(result.metadata?.decisionEffect).toMatchObject({
			kind: "file_request",
			status: "succeeded",
			projectId: null,
		});
		expect(
			f.sqlite
				.prepare("select project_id from agent_session_requests where id=?")
				.get(requestId)?.project_id,
		).toBeNull();
		expect(
			f.sqlite
				.prepare("select count(*) as n from learning_improvement_proposals")
				.get()?.n,
		).toBe(1);
		f.sqlite.close();
	});
	it("records an actual ADR approval and returns its server receipt before resolving", async () => {
		const f = await fixture();
		const result = await executeDecisionCardEffect(f.context, f.input);
		expect(result.expectedVersion).toBe(2);
		expect(result.metadata?.decisionEffect).toMatchObject({
			kind: "record_adr",
			state: "approved",
			status: "succeeded",
			targetId: work,
		});
		const comment = f.sqlite
			.prepare("select metadata from work_item_comments")
			.get();
		expect(JSON.parse(String(comment?.metadata))).toMatchObject({
			decision: "approved",
			commitSha: "a".repeat(40),
		});
		await respondToWorkInteraction(f.db, {
			...result,
			id: crypto.randomUUID(),
			now: new Date().toISOString(),
		});
		expect(
			f.sqlite.prepare("select status from work_interactions").get()?.status,
		).toBe("resolved");
		f.sqlite.close();
	});
	it.each([
		{ feedbackSignal: "edited" },
		{ editedBody: "A different proposal" },
	])(
		"refuses edited approval metadata before claiming or executing: %j",
		async (metadata) => {
			const f = await fixture();
			try {
				await expect(
					executeDecisionCardEffect(f.context, {
						...f.input,
						metadata: { ...f.input.metadata, ...metadata },
					}),
				).rejects.toMatchObject({ code: "CONFLICT" });
				expect(
					f.sqlite.prepare("select count(*) as n from work_item_comments").get()
						?.n,
				).toBe(0);
				expect(
					f.sqlite
						.prepare("select count(*) as n from work_interaction_responses")
						.get()?.n,
				).toBe(0);
				expect(
					f.sqlite.prepare("select version from work_interactions").get()
						?.version,
				).toBe(1);
			} finally {
				f.sqlite.close();
			}
		},
	);
	it("Later saves no effect and an invented action cannot dispatch", async () => {
		const f = await fixture();
		const later = await executeDecisionCardEffect(f.context, {
			...f.input,
			resolvesRequest: false,
			metadata: {
				cardAction: "later",
				decisionChoice: "later",
				decisionEffect: { status: "forged" },
			},
		});
		expect(later.metadata?.decisionEffect).toBeUndefined();
		expect(
			f.sqlite.prepare("select count(*) as n from work_item_comments").get()?.n,
		).toBe(0);
		await expect(
			executeDecisionCardEffect(f.context, {
				...f.input,
				metadata: { cardAction: "send_anything", decisionChoice: "approve" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		f.sqlite.close();
	});
	it("only one concurrent approval executes, and its saved claim prevents replay", async () => {
		const f = await fixture();
		const results = await Promise.allSettled([
			executeDecisionCardEffect(f.context, f.input),
			executeDecisionCardEffect(f.context, f.input),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			f.sqlite.prepare("select count(*) as n from work_item_comments").get()?.n,
		).toBe(1);
		await expect(
			executeDecisionCardEffect(f.context, { ...f.input, expectedVersion: 2 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		f.sqlite.close();
	});
	it("keeps a failed cross-tenant effect open with an unconfirmed receipt and forbids replay", async () => {
		const decision = structuredClone(envelope);
		decision.options[0]!.effect = {
			kind: "record_adr",
			workItemId: otherWork,
			commitSha: "a".repeat(40),
		};
		const f = await fixture(decision);
		await expect(
			executeDecisionCardEffect(f.context, f.input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			f.sqlite.prepare("select status from work_interactions").get()?.status,
		).toBe("open");
		expect(
			f.sqlite.prepare("select count(*) as n from work_item_comments").get()?.n,
		).toBe(0);
		expect(
			f.sqlite
				.prepare("select count(*) as n from work_interaction_responses")
				.get()?.n,
		).toBe(2);
		await expect(
			executeDecisionCardEffect(f.context, { ...f.input, expectedVersion: 3 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		f.sqlite.close();
	});
	it("rejects machine actors and another person's click", async () => {
		const f = await fixture();
		await expect(
			executeDecisionCardEffect(
				{ ...f.context, authType: "tedi", tediId: "worker" },
				f.input,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			executeDecisionCardEffect(f.context, {
				...f.input,
				responder: { type: "user", id: "someone-else" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		f.sqlite.close();
	});
	it("does not accept arbitrary tool dispatch in the card schema", () => {
		const decision = structuredClone(envelope);
		Object.assign(decision.options[0]!, {
			effect: { kind: "execute_tool", callable: "gmail.send" },
		});
		expect(DecisionEnvelopeSchema.safeParse(decision).success).toBe(false);
	});
});

it("records the default decline without executing the proposed effect", async () => {
	const f = await fixture();
	const input = {
		...f.input,
		body: "No / Not needed",
		metadata: {
			...f.input.metadata,
			cardAction: "not-needed",
			decisionChoice: "reject",
			feedbackSignal: "rejected",
		},
	};
	const result = await executeDecisionCardEffect(f.context, input);
	expect(result.metadata).not.toHaveProperty("decisionEffect");
	expect(
		f.sqlite.prepare("SELECT count(*) AS count FROM work_item_comments").get()
			?.count,
	).toBe(0);
	f.sqlite.close();
});

import {
	ListWorkInteractionCliInboxInputSchema,
	ListWorkInteractionCliInboxResultSchema,
	WorkInteractionInboxRowSchema,
	ProposedWorkSchema,
	WORK_PROPOSAL_SCHEMA,
	WorkProposalMetadataSchema,
	WorkInteractionReplyDraftSchema,
} from "../schemas/work-interactions";
import { describe, expect, it } from "vite-plus/test";
import {
	CreateWorkInteractionInputSchema,
	ListWorkInteractionInboxInputSchema,
	RespondToWorkInteractionInputSchema,
} from "../schemas/work-interactions";
import { workInteractionsContract } from "./work-interactions";

describe("Work interactions contract", () => {
	it("accepts Work disposition in full and CLI inbox summaries without loosening validation", () => {
		const item = {
			id: "00000000-0000-4000-8000-000000000001",
			title: "Check compatibility",
			projectId: null,
		};
		const schemas = [
			WorkInteractionInboxRowSchema.shape.workItem,
			ListWorkInteractionCliInboxResultSchema.shape.data.element.shape.workItem,
		];
		for (const schema of schemas) {
			for (const disposition of [
				"proposed",
				"accepted",
				"completed",
				"cancelled",
			]) {
				const value = { ...item, disposition };
				expect(schema.parse(value)).toEqual(value);
			}
			expect(schema.parse(item)).toEqual(item);
			expect(schema.parse(null)).toBeNull();
			expect(
				schema.safeParse({ ...item, disposition: "running" }).success,
			).toBe(false);
			expect(schema.safeParse({ ...item, disposition: null }).success).toBe(
				false,
			);
			expect(schema.safeParse({ ...item, unexpected: true }).success).toBe(
				false,
			);
		}
	});

	it("parses bounded Work proposals while ignoring surrounding evidence", () => {
		const item = { title: " Task ", sourceIntentId: " intent-1 " };
		const proposal = { key: "proposal-1", item };
		expect(
			WorkProposalMetadataSchema.parse({
				schema: WORK_PROPOSAL_SCHEMA,
				proposal,
				source: "chat",
				citations: [],
			}),
		).toEqual({
			schema: WORK_PROPOSAL_SCHEMA,
			proposal: {
				key: "proposal-1",
				item: { title: "Task", sourceIntentId: "intent-1" },
				children: [],
			},
		});
		for (const invalid of [
			{ ...item, title: " " },
			{ ...item, title: "x".repeat(301) },
			{ ...item, sourceIntentId: " " },
			{ ...item, sourceIntentId: "x".repeat(301) },
			{ ...item, description: "x".repeat(8_001) },
			{ ...item, extra: true },
		])
			expect(ProposedWorkSchema.safeParse(invalid).success).toBe(false);
		for (const invalid of [
			{ ...proposal, key: "" },
			{ ...proposal, key: "x".repeat(201) },
			{ ...proposal, projectId: "invalid" },
			{ ...proposal, parentWorkItemId: "invalid" },
			{ ...proposal, extra: true },
			{ ...proposal, children: Array.from({ length: 26 }, () => item) },
		])
			expect(
				WorkProposalMetadataSchema.safeParse({
					schema: WORK_PROPOSAL_SCHEMA,
					proposal: invalid,
				}).success,
			).toBe(false);
	});

	it("exposes structured request, immutable response, cancellation, detail, and inbox operations", () => {
		expect(Object.keys(workInteractionsContract)).toEqual([
			"outbound",
			"rememberCardStyle",
			"reviewCardStyleRule",
			"cardHistory",
			"listCardVersions",
			"requestCardChanges",
			"reviseCard",
			"refreshDecisionSources",
			"regenerateCard",
			"listCliInboxProjection",
			"delegate",
			"create",
			"respond",
			"cancel",
			"review",
			"get",
			"listInbox",
			"listOutbox",
			"listAudit",
			"listUndelivered",
			"ackDelivery",
			"recordDraftDelivery",
		]);
	});

	it("requires a concrete target and makes inbox scope server-owned", () => {
		expect(
			CreateWorkInteractionInputSchema.safeParse({
				workItemId: "00000000-0000-4000-8000-000000000001",
				kind: "question",
				subject: "Need a concrete target",
				prompt: "Who must answer?",
			}).success,
		).toBe(false);
		expect(
			ListWorkInteractionInboxInputSchema.safeParse({
				targetedToCaller: false,
			}).success,
		).toBe(false);
	});

	it("accepts an optional now/later urgency filter and rejects other values", () => {
		expect(ListWorkInteractionInboxInputSchema.parse({})).not.toHaveProperty(
			"urgency",
		);
		for (const urgency of ["now", "later"] as const)
			expect(
				ListWorkInteractionInboxInputSchema.parse({ urgency }),
			).toMatchObject({ urgency });
		expect(
			ListWorkInteractionInboxInputSchema.safeParse({ urgency: "soon" })
				.success,
		).toBe(false);
	});

	it("accepts every artifact-neutral request kind", () => {
		for (const kind of [
			"question",
			"input",
			"handoff",
			"coordination",
		] as const) {
			expect(
				CreateWorkInteractionInputSchema.parse({
					workItemId: "00000000-0000-4000-8000-000000000001",
					kind,
					subject: "Need durable coordination",
					prompt: "Provide the requested information.",
					requestedFrom: { type: "tedi", id: "research-lead" },
				}),
			).toMatchObject({ kind, metadata: {} });
		}
	});

	it("requires a plain reason before a question or input reaches a person", () => {
		const ask = {
			workItemId: "00000000-0000-4000-8000-000000000001",
			subject: "Pick the launch date",
			prompt: "Tuesday or Thursday?",
			requestedFrom: { type: "user", id: "user-fictional-1" },
		} as const;
		for (const kind of ["question", "input"] as const) {
			const missing = CreateWorkInteractionInputSchema.safeParse({
				...ask,
				kind,
			});
			expect(missing.success).toBe(false);
			expect(missing.error?.issues[0]?.path).toEqual(["reason"]);
			expect(
				CreateWorkInteractionInputSchema.parse({
					...ask,
					kind,
					reason: "Only the owner can set the launch date.",
				}),
			).toMatchObject({ reason: "Only the owner can set the launch date." });
		}
		// A captured agent turn is triaged server-side; a proposal states its own why.
		expect(
			CreateWorkInteractionInputSchema.safeParse({
				...ask,
				kind: "question",
				metadata: { schema: "tedix.decision-capture.v1" },
			}).success,
		).toBe(true);
		expect(
			CreateWorkInteractionInputSchema.safeParse({ ...ask, kind: "handoff" })
				.success,
		).toBe(true);
	});

	it("rejects unroutable team and system strings as direct targets", () => {
		for (const type of ["team", "system"] as const) {
			expect(() =>
				CreateWorkInteractionInputSchema.parse({
					workItemId: "00000000-0000-4000-8000-000000000001",
					kind: "question",
					subject: "Need a concrete target",
					prompt: "Resolve the team to an active principal first.",
					requestedFrom: { type, id: "arbitrary" },
				}),
			).toThrow();
		}
	});

	it("requires a complete artifact identity on responses", () => {
		expect(() =>
			RespondToWorkInteractionInputSchema.parse({
				requestId: "00000000-0000-4000-8000-000000000001",
				expectedRequestVersion: 1,
				responseKind: "answer",
				body: "See the attached artifact.",
				artifactRef: "provider:record:42",
			}),
		).toThrow(/artifactRef and artifactVersion/);
	});

	it("keeps server-only resolution fences off public response and cancellation inputs", () => {
		const requestId = "00000000-0000-4000-8000-000000000001";
		expect(
			RespondToWorkInteractionInputSchema.safeParse({
				requestId,
				expectedRequestVersion: 1,
				responseKind: "answer",
				body: "Answer",
				resolutionFence: "00000000-0000-4000-8000-000000000099",
			}).success,
		).toBe(false);
		const cancelInput =
			workInteractionsContract.cancel["~orpc"].inputSchemas[0]!;
		expect(
			cancelInput.safeParse({
				requestId,
				expectedRequestVersion: 1,
				resolutionFence: "00000000-0000-4000-8000-000000000099",
			}).success,
		).toBe(false);
	});

	it("bounds request and response metadata cost", () => {
		const oversized = { body: "x".repeat(32_769) };
		expect(
			CreateWorkInteractionInputSchema.safeParse({
				workItemId: "00000000-0000-4000-8000-000000000001",
				kind: "question",
				subject: "Bounded metadata",
				prompt: "Validate this request",
				requestedFrom: { type: "tedi", id: "research-lead" },
				metadata: oversized,
			}).success,
		).toBe(false);
		expect(
			RespondToWorkInteractionInputSchema.safeParse({
				requestId: "00000000-0000-4000-8000-000000000001",
				expectedRequestVersion: 1,
				responseKind: "answer",
				body: "Answer",
				metadata: oversized,
			}).success,
		).toBe(false);
	});
});

it("bounds the canonical inbox and keeps current full review/auto draft fields", () => {
	expect(ListWorkInteractionCliInboxInputSchema.parse({})).toMatchObject({
		states: ["open"],
		limit: 5,
	});
	for (const value of [
		{ limit: 6 },
		{ states: ["answered"] },
		{ targetedToCaller: false },
	])
		expect(
			ListWorkInteractionCliInboxInputSchema.safeParse(value).success,
		).toBe(false);
	const draft = {
		id: "00000000-0000-4000-8000-000000000001",
		body: "Reply",
		rationale: "Reason",
		drafterId: "drafter",
		drafterName: null,
		createdAt: "2026-10-07T00:00:00.000Z",
		turnType: null,
		gate: null,
	};
	for (const delivery of ["auto", "review"])
		expect(
			WorkInteractionReplyDraftSchema.parse({ ...draft, delivery }),
		).toEqual({ ...draft, delivery });
	expect(WorkInteractionReplyDraftSchema.safeParse(draft).success).toBe(false);
	expect(
		WorkInteractionReplyDraftSchema.safeParse({ ...draft, delivery: "other" })
			.success,
	).toBe(false);
});

import {
	ListWorkInteractionCliInboxInputSchema,
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
	it("exposes structured request, immutable response, cancellation, detail, and inbox operations", () => {
		expect(Object.keys(workInteractionsContract)).toEqual([
			"listCliInboxProjection",
			"delegate",
			"create",
			"respond",
			"cancel",
			"get",
			"listInbox",
			"listOutbox",
			"listAudit",
			"listUndelivered",
			"ackDelivery",
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

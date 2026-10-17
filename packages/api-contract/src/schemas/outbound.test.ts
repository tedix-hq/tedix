import { describe, expect, it } from "vite-plus/test";
import {
	chooseOutboundReviewer,
	reviewedOutbound,
	OutboundStateSchema,
	summarizeOutboundStyle,
} from "./outbound";
import { WorkItemKindSchema } from "./work-items";

const reviewer = "11111111-1111-4111-8111-111111111111";
const specialist = "22222222-2222-4222-8222-222222222222";
describe("outbound routing and pinned review", () => {
	it("shares only aggregate style hints from imported sent mail", () => {
		const hints = summarizeOutboundStyle([
			{ body: "Private invoice number 123456.\n\nThanks!" },
		]);
		expect(hints.join(" ")).toContain("1 sent emails");
		expect(hints.join(" ")).not.toContain("123456");
		expect(hints.join(" ")).not.toContain("Private invoice");
		expect(summarizeOutboundStyle([])).toEqual([]);
	});
	it("routes by tenant configuration, preferring the topic; no match stays unconfigured", () => {
		const policy = {
			routes: [
				{ channel: "email", reviewerTediId: reviewer },
				{ channel: "email", topic: "partners", reviewerTediId: specialist },
			],
		};
		expect(
			chooseOutboundReviewer(policy, { channel: "email", topic: "partners" }),
		).toBe(specialist);
		expect(
			chooseOutboundReviewer(policy, { channel: "email", topic: "support" }),
		).toBe(reviewer);
		expect(
			chooseOutboundReviewer(policy, { channel: "post", topic: "launch" }),
		).toBeNull();
		expect(WorkItemKindSchema.parse("outbound")).toBe("outbound");
	});
	it("requires the exact current revision and configured reviewer", () => {
		const state = OutboundStateSchema.parse({
			schema: "tedix.outbound.v1",
			draft: {
				channel: "proposal",
				topic: "partners",
				recipient: "Lina",
				body: "A fictional proposal",
				reasoning: "Requested scope",
				sources: [],
			},
			draftRevision: 2,
			author: { type: "external_agent", id: "local-session" },
			ownerUserId: "rosa",
			reviewerTediId: reviewer,
			interactionId: specialist,
			status: "waiting_on_you",
			review: {
				draftRevision: 2,
				verdict: "ready",
				notes: "Ready",
				voice: "Matches examples",
				grounding: "Sources checked",
				risks: "No new commitments",
				reviewerTediId: reviewer,
				reviewedAt: "2026-10-17T10:00:00Z",
			},
		});
		expect(reviewedOutbound(state)).toBe(true);
		expect(reviewedOutbound({ ...state, draftRevision: 3 })).toBe(false);
		expect(reviewedOutbound({ ...state, reviewerTediId: specialist })).toBe(
			false,
		);
		expect(reviewedOutbound({ ...state, status: "sending" })).toBe(false);
	});
});

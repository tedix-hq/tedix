import type { OutboundRecord } from "@tedix/api-contract/schemas/outbound";

export const LOCAL_OUTBOUND: OutboundRecord = {
	workItemId: "00000090-0000-4000-8000-000000000001",
	projectId: null,
	title: "Lina: partnership follow-up",
	version: 3,
	outbound: {
		schema: "tedix.outbound.v1",
		draft: {
			channel: "email",
			topic: "partners",
			recipient: "lina@example.test",
			subject: "Our workshop idea",
			body: "Hi Lina,\n\nThanks for the conversation yesterday. A short workshop on how your team keeps decisions current sounds useful.\n\nWe could walk through a fictional project together, then decide whether there is a next step. Does that direction work for you?\n\nBest,\nRosa",
			reasoning:
				"Lina asked for a short workshop outline. Keep the next step exploratory, with no delivery date or commercial commitment.",
			sources: [
				{
					uri: "work://fictional-partner-meeting",
					fact: "Lina asked for an outline after the meeting.",
				},
			],
			risks: ["No price, deadline or delivery promise is included."],
		},
		draftRevision: 1,
		author: { type: "external_agent", id: "fictional-local-session" },
		ownerUserId: "local-owner",
		reviewerTediId: "00000010-0000-4000-8000-000000000001",
		interactionId: "00000091-0000-4000-8000-000000000001",
		status: "waiting_on_you",
		review: {
			draftRevision: 1,
			verdict: "ready",
			notes:
				"Ready for your review. The ask is clear and leaves the next step open.",
			voice: "Short paragraphs, direct wording and a friendly closing.",
			grounding: "The workshop request is traced to the meeting Work.",
			risks: "No new date, price or commitment.",
			reviewerTediId: "00000010-0000-4000-8000-000000000001",
			reviewedAt: "2026-10-17T10:00:00Z",
		},
	},
};

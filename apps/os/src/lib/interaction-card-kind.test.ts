import { expect, it } from "vite-plus/test";
import { interactionCardKind } from "./interaction-card-kind";

it("uses the typed approval operation and target instead of a question fallback", () => {
	expect(
		interactionCardKind({
			kind: "question",
			metadata: {
				approvalOperation: "tests_write.CreateTestLink",
				approvalTarget: "viewer@example.com",
			},
		}),
	).toBe("approval");
	expect(
		interactionCardKind({
			kind: "question",
			metadata: { approvalOperation: "tests_write.CreateTestLink" },
		}),
	).toBe("question");
	expect(
		interactionCardKind({
			kind: "question",
			metadata: { approvalOperation: "", approvalTarget: "viewer@example.com" },
		}),
	).toBe("question");
	expect(interactionCardKind({ kind: "question", metadata: {} })).toBe(
		"question",
	);
	expect(interactionCardKind({ kind: "handoff" })).toBe("proposal");
});

it("keeps raw operation and target arguments out of the loading summary", async () => {
	const { connectorApprovalSummary } = await import("./interaction-card-kind");
	expect(
		connectorApprovalSummary(
			{
				metadata: {
					approvalOperation: "tests_write.GenerateMagicLinkForTestUser",
					approvalTarget: "viewer@example.com",
				},
				prompt:
					"Prepared args: viewer@example.com. This returns a non-delivered test-only link.",
			},
			"Codex session",
		),
	).toBe(
		"Let Codex sign in a made-up test user to check the reported fix. The test link stays with the agent; no email is sent.",
	);
});

it("preserves an approval envelope's request type", async () => {
	const { DECISION_DECK_EXAMPLES } =
		await import("../../dev/decision-deck-fixture");
	const approval = DECISION_DECK_EXAMPLES.find(
		(card) => card.kind === "approval",
	)!;
	expect(
		interactionCardKind({
			kind: "question",
			metadata: { decisionDeck: approval },
		}),
	).toBe("approval");
});

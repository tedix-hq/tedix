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

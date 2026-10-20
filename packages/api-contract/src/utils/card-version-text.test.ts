import { expect, it } from "vite-plus/test";
import {
	CardRevisionSchema,
	RequestCardChangesInputSchema,
} from "../schemas/card-revisions";
import { cardVersionsText } from "./card-version-text";
const revision = (n: number, body: string) =>
	CardRevisionSchema.parse({
		id: crypto.randomUUID(),
		orgId: "fictional",
		requestId: "11111111-1111-4111-8111-111111111111",
		revision: n,
		body,
		cause: n === 1 ? "initial" : "agent_rewrite",
		actorType: "tedi",
		actorId: "draft-author",
		actorSessionId: null,
		instruction: null,
		responseId: null,
		createdAt: "2030-01-01T00:00:00.000Z",
	});
it("prints a complete multiline fallback plus unresolved anchored comments", () => {
	const before = revision(1, "Hello\n\nOriginal wording.");
	const after = {
		...revision(2, "Hello\n\nShort wording."),
		summary: "Shortened the wording.",
		anchors: [
			{
				field: "draft" as const,
				quote: "Original wording.",
				prefix: "Hello\n\n",
				suffix: "",
				chip: "Shorter",
			},
		],
		anchorsResolved: [
			{
				index: 0,
				status: "declined" as const,
				note: "Please confirm this detail",
			},
		],
	};
	const text = cardVersionsText([before, after], true);
	expect(text).toContain("What changed: Shortened the wording.");
	expect(text).toContain("@@ -1,3 +1,3 @@");
	expect(text).toContain("-Original wording.");
	expect(text).toContain("+Short wording.");
	expect(text).toContain(
		"Unresolved comments\n1. “Original wording.” — Shorter (Please confirm this detail)",
	);
	expect(text).toContain("Revising…");
	expect(
		cardVersionsText(
			[before, { ...after, anchorsResolved: [{ index: 0, status: "done" }] }],
			false,
		),
	).not.toContain("Unresolved comments");
});
it("does not claim a rewrite when no versions or only the original exists", () => {
	expect(cardVersionsText([], false)).toContain("No saved versions yet");
	expect(cardVersionsText([revision(1, "Original")], false)).toContain(
		"Original",
	);
	expect(cardVersionsText([revision(1, "Original")], false)).not.toContain(
		"```diff",
	);
});

it("bounds the whole feedback batch and checks secret-like text in every anchor field", () => {
	const base = {
		requestId: "11111111-1111-4111-8111-111111111111",
		expectedRequestVersion: 1,
		instruction: "Shorter",
	};
	const anchor = {
		quote: "Original wording",
		prefix: "",
		suffix: "",
		field: "draft" as const,
		note: "Shorter",
	};
	for (const field of ["quote", "prefix", "suffix", "note", "chip"])
		expect(
			RequestCardChangesInputSchema.safeParse({
				...base,
				anchors: [{ ...anchor, [field]: "sk-" + "x".repeat(24) }],
			}).success,
		).toBe(false);
	expect(
		RequestCardChangesInputSchema.safeParse({
			...base,
			anchors: Array.from({ length: 20 }, () => ({
				...anchor,
				quote: "a".repeat(1000),
			})),
		}).success,
	).toBe(false);
	expect(
		RequestCardChangesInputSchema.safeParse({
			...base,
			anchors: [anchor],
			chips: ["Shorter"],
		}).success,
	).toBe(true);
});

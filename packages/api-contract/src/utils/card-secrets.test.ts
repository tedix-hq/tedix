import { expect, it } from "vite-plus/test";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
	credentialCard,
} from "./card-secrets";
import { RespondToWorkInteractionInputSchema } from "../schemas/work-interactions";
import { RecordLearningInteractionInputSchema } from "../schemas/learning-feedback";

it.each([
	"sk-" + "fictional".repeat(5),
	"fc-" + "fictional".repeat(5),
	"ghp_" + "fictional".repeat(5),
	"Bearer " + "fictional".repeat(5),
	"api_key=" + "fictional".repeat(5),
	"-----BEGIN " + "PRIVATE KEY-----",
])("refuses a credential format without echoing it", (secret) => {
	expect(containsCardSecret(secret)).toBe(true);
	const result = RespondToWorkInteractionInputSchema.safeParse({
		requestId: "11111111-1111-4111-8111-111111111111",
		expectedRequestVersion: 1,
		responseKind: "answer",
		body: secret,
	});
	expect(result.success).toBe(false);
	if (!result.success)
		expect(
			result.error.issues.some(
				(issue) => issue.message === CARD_SECRET_MESSAGE,
			),
		).toBe(true);
});
it("keeps ordinary feedback, links, hashes and UUIDs usable", () => {
	for (const text of [
		"Shorten the introduction and use a warmer tone.",
		"Replace the Firecrawl key in connection settings.",
		"https://example.test/doc/0123456789abcdef0123456789abcdef",
		"11111111-1111-4111-8111-111111111111",
	])
		expect(containsCardSecret(text)).toBe(false);
	expect(credentialCard("Replace the Firecrawl key for the radar?")).toBe(true);
	expect(credentialCard("Improve the partner email?")).toBe(false);
});

it("refuses secrets in nested card comments and feedback metadata", () => {
	const metadata = {
		reaction: "comment",
		comment: { apiKey: "fictional".repeat(5) },
	};
	expect(containsCardSecret(metadata)).toBe(true);
	expect(
		RecordLearningInteractionInputSchema.safeParse({
			clientEventId: "comment",
			eventKind: "answered",
			scope: { kind: "personal" },
			surface: "decision_deck",
			metadata,
		}).success,
	).toBe(false);
});

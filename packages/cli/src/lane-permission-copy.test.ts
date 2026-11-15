import { expect, it } from "bun:test";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import { checkDecisionCardCopy } from "@tedix/api-contract/utils/decision-card-copy";
import { lanePermissionCopy } from "./lane-permission-copy";
import {
	laneReservedActionMatches,
	laneReservedActions,
} from "./lane-reserved-actions";
import { dispatchSkip, laneDelegationRequest } from "./lane-serve";

it("gives a 431a1b29-style permission card a concrete story despite a long task title", () => {
	const sentence =
		"Publish the visitor review app on https://reviews.example.com for Acme so guests can rate cards.";
	const work = {
		id: "11111111-1111-4111-8111-111111111111",
		title:
			"Make the visitor review experience understandable on small screens and ready for people outside the team",
		description: `Build the app using sample content. ${sentence}\nDo not send email to customers.`,
		version: 4,
		metadata: { executor: "codex" },
		accountableOwnerType: "user" as const,
		accountableOwnerId: "fictional-owner",
		workKind: "coding" as const,
		startAt: null,
		acceptanceContract: null,
		disposition: "accepted" as const,
		projectId: "22222222-2222-4222-8222-222222222222",
	};
	const request = laneDelegationRequest(work, dispatchSkip(work)!, undefined)!;
	const deck = DecisionEnvelopeSchema.parse(request.metadata.decisionDeck);
	const face = DecisionCardPresentationSchema.parse(
		request.metadata.cardPresentation,
	);
	if (face.version !== 2) throw new Error("Expected story presentation");
	expect(face.story).toBe(
		`Codex needs permission: “${sentence.slice(0, -1)}”. Allow records permission for this task version, then Codex can proceed.`,
	);
	expect(face.story!.split(/\s+/u).length).toBeLessThanOrEqual(60);
	expect(checkDecisionCardCopy(face)).toEqual([]);
	expect(face.whyMe).toBe("You own this task.");
	expect(deck.preview?.body).toContain(sentence);
	expect(deck.preview?.body).not.toContain("Do not send email");
	expect(deck.reversibility).toBe("one_way");
	expect(request.prompt).toContain(
		"Public copies may remain after unpublishing.",
	);
	expect(deck.options[0]?.effect).toMatchObject({
		kind: "delegate_work",
		workVersion: 4,
	});
	expect(request.metadata.laneBlocker).toMatchObject({
		matchedActions: [{ action: "public_publish", sentence }],
	});
});

it.each([
	["Send the renewal email to customers via Gmail.", "one_way", "recalled"],
	[
		"Permanently delete the live records from the Acme org.",
		"one_way",
		"restore path",
	],
	["Delete the old records from the Acme org.", "unknown", "restore path"],
	["Delete old records from Acme, not permanently.", "unknown", "restore path"],
	["Change the customer's live configuration in Acme.", "unknown", "rollback"],
])("explains undo limits for %s", (text, reversibility, explanation) => {
	const copy = lanePermissionCopy(text, "Claude Code");
	expect(copy.reversibility).toBe(reversibility);
	expect(copy.undo).toContain(explanation);
	expect(copy.story).toContain(text.slice(0, -1));
});

it("keeps every matched action and target, ignoring negated instructions", () => {
	const text =
		"Do not publish the draft. Send an email to customers via Gmail.\nDelete old records from Acme.";
	expect(laneReservedActionMatches(text)).toEqual([
		{
			action: "external_message",
			sentence: "Send an email to customers via Gmail.",
		},
		{ action: "delete_data", sentence: "Delete old records from Acme." },
	]);
	expect(laneReservedActions(text)).toEqual([
		"external_message",
		"delete_data",
	]);
});

it("bounds long stories while keeping full source and the target in Details", () => {
	const sentence = `Publish the review app with ${"sample content ".repeat(50)}on https://reviews.example.com for Acme.`;
	const copy = lanePermissionCopy(sentence, "Codex");
	expect(copy.story.split(/\s+/u).length).toBeLessThanOrEqual(60);
	expect(copy.story.length).toBeLessThanOrEqual(600);
	expect(copy.story).toContain("https://reviews.example.com for Acme");
	expect(copy.sentences).toEqual([sentence]);
});

import { describe, expect, it } from "vite-plus/test";
import {
	DecisionDeckConfigSchema,
	decisionNeedsPerson,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { OsGadgetManifestWriteSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import {
	workIsUnowned,
	classReadiness,
	decisionEnvelope,
	decisionFeedbackMetadata,
	type DecisionLearningReceipt,
} from "./decision-deck";

describe("decision deck policy projection", () => {
	it("keeps protected effects and uncertainty in review, while reversible implementation leaves the deck", () => {
		const adr = DECISION_DECK_EXAMPLES[5]!;
		for (const kind of ["outbound", "approval"] as const)
			expect(
				decisionNeedsPerson({
					...adr,
					kind,
					protectedEffects: [],
					reversibility: "two_way",
				}),
			).toBe(true);
		expect(decisionNeedsPerson({ ...adr, reversibility: "two_way" })).toBe(
			true,
		);
		expect(
			decisionNeedsPerson({
				...adr,
				protectedEffects: [],
				reversibility: "unknown",
			}),
		).toBe(true);
		expect(
			decisionNeedsPerson({
				...adr,
				protectedEffects: [],
				reversibility: "two_way",
			}),
		).toBe(false);
		expect(
			decisionNeedsPerson({
				...adr,
				protectedEffects: [],
				reversibility: "two_way",
				tasteOrStrategy: true,
			}),
		).toBe(true);
	});
	it("uses distinct evidence, resets on a rejection and never treats delegation or edits as unchanged approval", () => {
		const receipt = (
			id: string,
			signal = "approve-as-is",
			choice = "approve",
		): DecisionLearningReceipt => ({
			id,
			classId: "architecture",
			signal,
			choice,
			at: `2026-10-17T10:0${id}:00Z`,
		});
		const receipts = [receipt("1"), receipt("2"), receipt("2")];
		expect(classReadiness(receipts, "architecture", 2)).toMatchObject({
			unchanged: 2,
			ready: true,
		});
		for (const row of [
			receipt("3", "rejected", "reject"),
			receipt("3", "edited", "change"),
			receipt("3", "answer", "delegate"),
		])
			expect(
				classReadiness([...receipts, row], "architecture", 2),
			).toMatchObject({ unchanged: 0, ready: false });
		expect(classReadiness(receipts, "marketing", 2).unchanged).toBe(0);
	});
	it("preserves edits and elapsed time without learning approval from Later or Decide for me", () => {
		const feedback = {
			action: "delegate",
			body: "Short",
			originalBody: "A longer draft",
			signal: "approve-as-is" as const,
		};
		expect(
			decisionFeedbackMetadata(feedback, "acme-style", "delegate", 12.7),
		).toMatchObject({
			feedbackSignal: "answer",
			elapsedMs: 13,
			originalBody: "A longer draft",
			editedBody: "Short",
		});
		expect(
			decisionFeedbackMetadata(feedback, "acme-style", "change", 0).editRatio,
		).toBeGreaterThan(0);
	});
	it("validates a tenant-neutral manifest with all six kinds and bounded organization settings", () => {
		const config = DecisionDeckConfigSchema.parse({
			version: 1,
			examples: DECISION_DECK_EXAMPLES,
		});
		expect(
			OsGadgetManifestWriteSchema.parse({
				entry: "tedix:app/decision-deck",
				config,
			}).config,
		).toEqual(config);
		for (const dailyAttentionBudget of [0, 101])
			expect(
				OsGadgetManifestWriteSchema.safeParse({
					entry: "tedix:app/decision-deck",
					config: { ...config, dailyAttentionBudget },
				}).success,
			).toBe(false);
		expect(decisionEnvelope({ decisionDeck: { kind: "adr" } })).toBeNull();
	});
});

it("distinguishes nobody carrying an outcome from a live Attempt or an unknown read", () => {
	expect(workIsUnowned(undefined)).toBe(false);
	expect(workIsUnowned({ accountableOwnerId: null })).toBe(false);
	expect(
		workIsUnowned({
			accountableOwnerId: null,
			activeAttempt: { executorId: "fictional-worker" },
		}),
	).toBe(false);
	expect(
		workIsUnowned({
			accountableOwnerId: "fictional-owner",
			activeAttempt: null,
		}),
	).toBe(false);
	expect(workIsUnowned({ accountableOwnerId: null, activeAttempt: null })).toBe(
		true,
	);
});

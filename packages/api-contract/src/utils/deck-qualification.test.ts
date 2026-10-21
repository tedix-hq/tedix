import { describe, expect, it } from "vite-plus/test";
import { DeckPipelineConfigSchema } from "../schemas/deck-pipeline";
import { classifyDeckAsk } from "./deck-qualification";

const config = DeckPipelineConfigSchema.parse({}).qualification;
describe("Deck ask qualification", () => {
	it("offers yes/no for a closed question and text for an open question", () => {
		expect(
			classifyDeckAsk({ subject: "Should Maple renew the booth?" }, config),
		).toMatchObject({
			responseKind: "choice",
			responseOptions: [
				{ id: "yes", label: "Yes" },
				{ id: "no", label: "No" },
			],
		});
		expect(
			classifyDeckAsk(
				{ subject: "Which supplier details are missing?" },
				config,
			).responseKind,
		).toBe("open");
	});
	it("keeps named options instead of inventing yes/no", () => {
		expect(
			classifyDeckAsk(
				{
					subject: "Which venue?",
					metadata: { suggestedAnswers: ["Maple Hall", "Orchard Park"] },
				},
				config,
			).responseOptions.map((o) => o.label),
		).toEqual(["Maple Hall", "Orchard Park"]);
	});
	it("identifies owner chores and requires concrete steps and duration", () => {
		const subject =
			"Sign in to Maple settings with your MFA to revoke the old token";
		expect(classifyDeckAsk({ subject }, config)).toMatchObject({
			responseKind: "task",
			ownerTask: null,
		});
		const ownerTask = {
			presence: "mfa",
			steps: [
				"Open Maple settings",
				"Sign in and complete MFA",
				"Revoke the old token",
			],
			estimatedMinutes: 3,
		};
		expect(
			classifyDeckAsk({ subject, metadata: { ownerTask } }, config),
		).toMatchObject({ responseKind: "task", responseOptions: [], ownerTask });
	});
	it("uses organization patterns rather than product or card identities", () => {
		const custom = DeckPipelineConfigSchema.parse({
			qualification: { yesNoPattern: "^Proceed with orchard renewal\\?$" },
		}).qualification;
		expect(
			classifyDeckAsk({ subject: "Proceed with orchard renewal?" }, custom)
				.responseKind,
		).toBe("choice");
		expect(
			classifyDeckAsk({ subject: "Should Maple renew the booth?" }, custom)
				.responseKind,
		).toBe("open");
	});
});

it("preserves exact numbered source steps and its stated duration", () => {
	const result = classifyDeckAsk(
		{
			subject: "Maple tokens: your Maple login (about 15 min)",
			prompt: "1. Sign in with MFA.\n2. Revoke the retired token.",
		},
		config,
	);
	expect(result).toMatchObject({
		responseKind: "task",
		ownerTask: {
			presence: "mfa",
			steps: ["Sign in with MFA.", "Revoke the retired token."],
			estimatedMinutes: 15,
		},
	});
});

it("turns a one-step owner permission chore into a timed task", () => {
	expect(
		classifyDeckAsk(
			{
				subject: "Maple activity permission (1 min)",
				prompt:
					"The board cannot read activity until you allow it.\nStep: Open Maple settings and grant activity consent.",
			},
			config,
		),
	).toMatchObject({
		responseKind: "task",
		ownerTask: {
			presence: "consent",
			steps: ["Open Maple settings and grant activity consent."],
			estimatedMinutes: 1,
		},
	});
});

it("returns an invalid typed owner task for repair rather than converting it to an open answer", () => {
	expect(
		classifyDeckAsk(
			{
				subject: "Complete Maple setup",
				metadata: { ownerTask: { steps: [], estimatedMinutes: 0 } },
			},
			config,
		),
	).toMatchObject({ responseKind: "task", ownerTask: null });
});

it("keeps questions about sign-in policy as decisions", () => {
	expect(
		classifyDeckAsk(
			{
				subject: "Should Maple require users to sign in?",
				prompt: "I recommend retaining the current policy.",
			},
			config,
		),
	).toMatchObject({ responseKind: "choice", ownerTask: null });
	expect(
		classifyDeckAsk(
			{ subject: "Should Maple enable two-factor authentication?" },
			config,
		).responseKind,
	).toBe("choice");
});

import { expect, it } from "vite-plus/test";
import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
import { missingDecisionFaceFacts } from "./decision-card-face-facts";

const option = (intent: string, cost: string) => ({
	id: intent,
	label: intent,
	intent,
	consequence: "Records the choice.",
	cost,
});

// Decision facts as each producer writes them (fictional values).
const producers = [
	{
		producer: "deadline-decisions",
		decision: {
			costOfWaiting: "The deadline is 2026-11-03.",
			options: [option("approve", "None"), option("later", "Less time")],
		},
		covered: {
			context: "You own this task; the deadline is 2026-11-03.",
			body: "Saves your review on this task.",
		},
	},
	{
		producer: "personal-agent-inbound",
		decision: {
			costOfWaiting: "The opportunity remains unexplored.",
			options: [
				option("approve", "Your review time"),
				option("reject", "None"),
			],
		},
		covered: {
			context:
				"Your research helper found this; otherwise it stays unexplored.",
			body: "Adds the finding to your tasks; needs some review time.",
		},
	},
	{
		producer: "support-draft-decision",
		decision: {
			costOfWaiting: ATTENTION_COPY.supportDraftWaitingCost,
			options: [
				option("approve", ATTENTION_COPY.noCost),
				option("reject", ATTENTION_COPY.supportDraftRejectCost),
			],
		},
		covered: {
			context: "The reporter cannot see the answer until you publish it.",
			body: "Publishes this reviewed reply on the ticket.",
		},
	},
	{
		producer: "agent interaction (Codex decisionDeck)",
		decision: {
			costOfWaiting: "The vendor quote of EUR 1,200 expires on 2026-11-01.",
			options: [
				option("approve", "EUR 1,200 per year."),
				option("reject", "None"),
			],
		},
		covered: {
			context: "The vendor quote expires on 2026-11-01.",
			body: "Buys the yearly plan for EUR 1,200.",
		},
	},
];

const face = {
	title: "Accept this choice?",
	recommendation: "It matches the source.",
};

it.each(producers)(
	"$producer: accepts a face that restates why now, waiting and yes costs",
	({ decision, covered }) => {
		expect(missingDecisionFaceFacts({ ...face, ...covered }, decision)).toEqual(
			[],
		);
	},
);

it.each(producers)(
	"$producer: rejects a face that drops what waiting costs",
	({ decision, covered }) => {
		expect(
			missingDecisionFaceFacts(
				{ ...face, ...covered, context: "Someone asked for this." },
				decision,
			).map(({ check }) => check),
		).toContain("cost_of_waiting");
	},
);

it("rejects a face that drops a real cost of saying yes, naming the source fact", () => {
	const [, , , codex] = producers;
	expect(
		missingDecisionFaceFacts(
			{
				...face,
				context: codex!.covered.context,
				body: "Buys the plan.",
			},
			codex!.decision,
		),
	).toEqual([{ check: "option_cost", source: "EUR 1,200 per year." }]);
});

it("requires context for every producer, with or without decision facts", () => {
	for (const decision of [undefined, null, {}, producers[0]!.decision])
		expect(
			missingDecisionFaceFacts(
				{ ...face, body: "Saves a task." },
				decision,
			).map(({ check }) => check),
		).toContain("context");
});

it("leaves translated sources to the writer instead of matching words", () => {
	expect(
		missingDecisionFaceFacts(
			{ ...face, context: "Needed this week.", body: "Saves a task." },
			{
				costOfWaiting: "Se pierde el descuento del proveedor.",
				options: [option("approve", "Tiempo de revisión")],
			},
		),
	).toEqual([]);
});

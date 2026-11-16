import { z } from "zod";
import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "../schemas/os-decision-deck";

const holdRequest = z.object({
	source: z.literal("lane-dispatch-blocker"),
	laneBlocker: z.object({
		kind: z.enum(["execution_hold", "result_unverified", "accountable_owner"]),
		executor: z.enum(["codex", "claude-code", "opencode", "devin"]),
		workVersion: z.number().int().positive(),
	}),
});

const AGENTS = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
};

const later = {
	id: "later",
	label: "Later",
	intent: "later" as const,
	consequence: "Keeps this card; the task waits.",
	cost: "No agent works on the task meanwhile.",
};

/**
 * The answers a person can give a runner that stopped starting a task: try
 * again, hand it to another agent, close it, complete it, or become its
 * owner. The runner files such a request as plain text; this gives it the
 * same one-click answers as a permission card, for requests already filed
 * too. Null for every other request, and for one that carries its own card.
 */
export function laneHoldDecision(request: {
	subject: string;
	prompt: string;
	workItemId?: string | null;
	metadata: Record<string, unknown>;
}): DecisionEnvelope | null {
	const parsed = holdRequest.safeParse(request.metadata);
	if (
		!parsed.success ||
		!request.workItemId ||
		request.metadata.decisionDeck !== undefined
	)
		return null;
	const { kind, executor, workVersion } = parsed.data.laneBlocker;
	const workItemId = request.workItemId;
	const agent = AGENTS[executor];
	// What happened, then the runner's own note when it sent one. Its closing
	// instructions ("The task stays accepted…") give way to the answers below.
	const [first, ...rest] = request.prompt
		.split("\n\nThe task stays accepted")[0]!
		.split("\n\n");
	const whatHappened = first?.trim() || request.subject;
	const note = rest.join("\n\n").trim();
	const restart = {
		kind: "restart_work" as const,
		workItemId,
		executor,
		workVersion,
	};
	const shared = {
		version: 1,
		kind: "decision",
		classId: `lane-hold.${kind}`,
		proposal: request.subject.slice(0, 500),
		whyNow: whatHappened.slice(0, 2000),
		tasteOrStrategy: true,
		protectedEffects: [],
		confidence: null,
		costOfWaiting: "The task stays accepted and no agent works on it.",
		// What happened first, then the runner's own words.
		...(note
			? { preview: { body: `${whatHappened}\n\n${note}`.slice(0, 40000) } }
			: {}),
		reasoning:
			"A runner starts a task only while it is ready. This one stays parked until a person answers or edits the task; the card closes by itself when the task changes or finishes.",
	};
	if (kind === "accountable_owner")
		return (
			DecisionEnvelopeSchema.safeParse({
				...shared,
				recommendation:
					"Make yourself the owner if you can answer for this task.",
				reversibility: "two_way",
				blastRadius: "Only this task. Its owner can be changed again.",
				options: [
					{
						id: "own",
						label: "Make me the owner",
						intent: "approve",
						consequence:
							"You become the task's accountable owner. The runner then asks you to allow or refuse the step.",
						cost: "You answer for this task.",
						effect: { kind: "own_work", workItemId, workVersion },
					},
					{
						id: "not-me",
						label: "Not me",
						intent: "reject",
						consequence:
							"Closes this card. The task stays paused until an owner or admin names a person as its owner.",
						cost: "No agent works on this task.",
					},
					later,
				],
			}).data ?? null
		);
	if (kind === "result_unverified")
		return (
			DecisionEnvelopeSchema.safeParse({
				...shared,
				recommendation:
					"Check the change, then complete the task. If the result is wrong, run it again.",
				reversibility: "one_way",
				blastRadius: "Only this task. A completed task stays completed.",
				options: [
					{
						id: "complete",
						label: "Complete the task",
						intent: "approve",
						consequence:
							"Marks the task done as it stands. No agent starts it again.",
						cost: "If the result is wrong, nobody is working on it.",
						effect: { kind: "complete_work", workItemId },
					},
					{
						id: "retry",
						label: "Run it again",
						intent: "approve",
						consequence: `${agent} starts this task again on its next check.`,
						cost: "Agent time. The change already on main stays there.",
						effect: restart,
					},
					{
						id: "leave",
						label: "Leave it parked",
						intent: "reject",
						consequence:
							"Closes this card. The task stays accepted and no agent starts it until someone edits it.",
						cost: "The result stays unchecked.",
					},
					later,
				],
			}).data ?? null
		);
	const other = executor === "claude-code" ? "codex" : "claude-code";
	return (
		DecisionEnvelopeSchema.safeParse({
			...shared,
			recommendation:
				"Try again if the cause was a one-off. If the task itself is unclear, edit the task instead; that also starts it again.",
			reversibility: "two_way",
			blastRadius: "Only this task. Closing it cannot be undone.",
			options: [
				{
					id: "retry",
					label: "Try again",
					intent: "approve",
					consequence: `${agent} starts this task again on its next check, with a fresh set of runs.`,
					cost: "Agent time. The same problem can come back.",
					effect: restart,
				},
				{
					id: "hand-over",
					label: `Give it to ${AGENTS[other]}`,
					intent: "approve",
					consequence: `${AGENTS[other]} takes the task over and starts it on its next check.`,
					cost: `Needs a running ${AGENTS[other]} runner; until one checks, the task waits.`,
					effect: { ...restart, executor: other },
				},
				{
					id: "close",
					label: "Close the task",
					intent: "reject",
					consequence:
						"Cancels the task. No agent works on it again, and a cancelled task stays cancelled.",
					cost: "The work is not done. File a new task if it is still needed.",
					effect: { kind: "cancel_work", workItemId, workVersion },
				},
				later,
			],
		}).data ?? null
	);
}

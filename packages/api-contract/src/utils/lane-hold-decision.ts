import { z } from "zod";
import type { DecisionCardPresentation } from "../schemas/decision-card-presentation";
import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "../schemas/os-decision-deck";
import { checkDecisionCardCopy } from "./decision-card-copy";

const holdRequest = z.object({
	source: z.literal("lane-dispatch-blocker"),
	laneBlocker: z.object({
		kind: z.enum(["execution_hold", "result_unverified", "accountable_owner"]),
		executor: z.enum(["codex", "claude-code", "opencode", "devin", "tedi"]),
		workVersion: z.number().int().positive(),
	}),
});

const AGENTS = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
	tedi: "Tedi",
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

type HoldFace = Extract<DecisionCardPresentation, { version: 2 }>;

function holdFace(
	kind: z.infer<typeof holdRequest>["laneBlocker"]["kind"],
	agent: string,
	task: string,
	reason?: string,
): HoldFace {
	if (kind === "accountable_owner")
		return {
			version: 2,
			title: `Will you be the owner of ${task}?`,
			context: "The task is paused until a person owns it.",
			story: `${agent} paused this task. It needs permission from an owner, and the task has none.`,
			whyMe: "Only a person can own a task.",
			body: "You become the owner; the agent then asks you to allow or refuse the step.",
			recommendation:
				"Make yourself the owner if you can answer for this task.",
			effectStatus: "known",
		};
	if (kind === "result_unverified")
		return {
			version: 2,
			title: `Is the result of ${task} right?`,
			context: "The change is on main and nobody has confirmed the result.",
			story: `${agent} changed main but could not confirm the result. The task waits for you.`,
			whyMe: "Only a person can judge the result.",
			body: "Marks the task done as it stands; no agent starts it again.",
			recommendation:
				"Check the change, then complete the task if it is right.",
			effectStatus: "known",
		};
	return {
		version: 2,
		title: `Restart ${task}?`,
		context: "No agent works on this task until someone answers.",
		story: reason
			? `${agent} paused the task. ${reason}`
			: `${agent} stopped starting this task. It waits until you answer.`,
		whyMe: "You choose what happens next.",
		body: `${agent} starts the task again on its next check.`,
		recommendation: "Try again if the cause was temporary.",
		effectStatus: "known",
	};
}

/**
 * The summary of a runner's hold card, written here and never by a model: a
 * model reads the request as filed and cannot know the answers
 * `laneHoldDecision` gives it, so its recommendation could contradict the
 * buttons. Names no single answer to pick. Null for every other request.
 */
export function laneHoldFace(request: {
	subject: string;
	prompt?: string;
	workItemId?: string | null;
	metadata: Record<string, unknown>;
}): HoldFace | null {
	const parsed = holdRequest.safeParse(request.metadata);
	if (!parsed.success || !request.workItemId) return null;
	const { kind, executor } = parsed.data.laneBlocker;
	// A request read back already carries the answers derived above.
	const carried = request.metadata.decisionDeck;
	if (
		carried !== undefined &&
		DecisionEnvelopeSchema.safeParse(carried).data?.classId !==
			`lane-hold.${kind}`
	)
		return null;
	const name = /"(.+)"/.exec(request.subject)?.[1]?.trim();
	const shortName =
		name && (name.length > 50 ? `${name.slice(0, 49).trim()}…` : name);
	const reason = request.prompt
		?.match(/stopped working on ".+?"\.\s*([^\n]+)/)?.[1]
		?.replace(/\bruns\b/gi, "tries")
		.replace(/\brun\b/gi, "try")
		.replace(/\bexpired\b/gi, "timed out")
		.trim();
	const named = shortName
		? holdFace(kind, AGENTS[executor], `"${shortName}"`)
		: holdFace(kind, AGENTS[executor], "this task");
	const explained = reason
		? holdFace(kind, AGENTS[executor], `"${shortName ?? "this task"}"`, reason)
		: null;
	if (explained && !checkDecisionCardCopy(explained).length) return explained;
	// Unsafe source text stays in Details; the card still needs valid copy.
	return !checkDecisionCardCopy(named).length
		? named
		: holdFace(kind, AGENTS[executor], "this task");
}

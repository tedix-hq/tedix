import { expect, it } from "vite-plus/test";
import { DecisionCardPresentationSchema } from "../schemas/decision-card-presentation";
import { checkDecisionCardCopy } from "./decision-card-copy";
import { laneHoldDecision, laneHoldFace } from "./lane-hold-decision";

const workItemId = "00000000-0000-4000-8000-000000000002";
const request = (kind: string, prompt: string, subject: string) => ({
	workItemId,
	subject,
	prompt,
	metadata: {
		source: "lane-dispatch-blocker",
		laneBlocker: { kind, executor: "claude-code", workVersion: 7 },
	},
});
const words = (text: string) => text.trim().split(/\s+/).length;

it("turns a runner hold into what happened, why, and three answers that act", () => {
	const decision = laneHoldDecision(
		request(
			"execution_hold",
			'Claude Code stopped working on "Port the landing page". Three runs failed or expired on this version of the task.\n\nLast note from the runner: the browser check timed out.\n\nThe task stays accepted and no agent starts it. To run it again, edit the task, for example to repair its description. Otherwise complete or cancel it. This request closes when the task changes.',
			'What should happen with "Port the landing page"?',
		),
	)!;
	expect(decision.proposal).toBe(
		'What should happen with "Port the landing page"?',
	);
	expect(decision.whyNow).toBe(
		'Claude Code stopped working on "Port the landing page". Three runs failed or expired on this version of the task.',
	);
	// The face is the question and what happened: one short story.
	expect(words(`${decision.proposal} ${decision.whyNow}`)).toBeLessThan(60);
	// The runner's note follows; its closing instructions give way to the answers.
	expect(decision.preview?.body).toBe(
		`${decision.whyNow}\n\nLast note from the runner: the browser check timed out.`,
	);
	expect(
		decision.options.map(({ id, label, intent, effect }) => ({
			id,
			label,
			intent,
			effect,
		})),
	).toEqual([
		{
			id: "retry",
			label: "Try again",
			intent: "approve",
			effect: {
				kind: "restart_work",
				workItemId,
				executor: "claude-code",
				workVersion: 7,
			},
		},
		{
			id: "hand-over",
			label: "Give it to Codex",
			intent: "approve",
			effect: {
				kind: "restart_work",
				workItemId,
				executor: "codex",
				workVersion: 7,
			},
		},
		{
			id: "close",
			label: "Close the task",
			intent: "reject",
			effect: { kind: "cancel_work", workItemId, workVersion: 7 },
		},
		{ id: "later", label: "Later", intent: "later", effect: undefined },
	]);
});

it("offers to complete or rerun a landed change the agent could not confirm", () => {
	const decision = laneHoldDecision(
		request(
			"result_unverified",
			'Claude Code put a change for "Port the landing page" on main (0123456789ab) but could not confirm the result.\n\nNot confirmed: the deploy could not be read.\n\nThe task stays accepted and no agent starts it again.',
			'Check the result of "Port the landing page"',
		),
	)!;
	expect(decision.reversibility).toBe("one_way");
	expect(decision.preview?.body).toContain("the deploy could not be read");
	expect(
		decision.options.map((option) => [option.id, option.effect?.kind]),
	).toEqual([
		["complete", "complete_work"],
		["retry", "restart_work"],
		["leave", undefined],
		["later", undefined],
	]);
});

it("offers the person asked to become the owner of a task that has none", () => {
	const decision = laneHoldDecision(
		request(
			"accountable_owner",
			'Claude Code paused "Port the landing page" because it asks the agent to publish something publicly, and the task has no person who can allow that.',
			'Choose an accountable owner for "Port the landing page"',
		),
	)!;
	expect(decision.options.map((option) => [option.id, option.effect])).toEqual([
		["own", { kind: "own_work", workItemId, workVersion: 7 }],
		["not-me", undefined],
		["later", undefined],
	]);
});

it.each([
	{ source: "lane-dispatch-blocker" },
	{
		source: "elsewhere",
		laneBlocker: {
			kind: "execution_hold",
			executor: "codex",
			workVersion: 1,
		},
	},
	// A permission card carries its own answers.
	{
		source: "lane-dispatch-blocker",
		decisionDeck: {},
		laneBlocker: {
			kind: "execution_hold",
			executor: "codex",
			workVersion: 1,
		},
	},
	{
		source: "lane-dispatch-blocker",
		laneBlocker: {
			kind: "owner_delegation",
			executor: "codex",
			workVersion: 1,
		},
	},
])("leaves every other request alone: %j", (metadata) => {
	expect(
		laneHoldDecision({ workItemId, subject: "Ask", prompt: "Ask", metadata }),
	).toBeNull();
});

it("needs the task the runner stopped on", () => {
	expect(
		laneHoldDecision({
			...request("execution_hold", "Stopped.", "What should happen?"),
			workItemId: null,
		}),
	).toBeNull();
});

const HOLD_SUBJECTS = {
	execution_hold: 'What should happen with "Port the landing page"?',
	result_unverified: 'Check the result of "Port the landing page"',
	accountable_owner: 'Choose an accountable owner for "Port the landing page"',
};

it.each(
	(
		["execution_hold", "result_unverified", "accountable_owner"] as const
	).flatMap((kind) =>
		(["codex", "claude-code", "opencode", "devin"] as const).map(
			(executor) => [kind, executor] as const,
		),
	),
)(
	"writes a fixed summary for a %s card from %s that passes the card copy rules",
	(kind, executor) => {
		const filed = request(kind, "Stopped.", HOLD_SUBJECTS[kind]);
		const face = laneHoldFace({
			...filed,
			metadata: {
				...filed.metadata,
				laneBlocker: { kind, executor, workVersion: 7 },
			},
		})!;
		expect(DecisionCardPresentationSchema.safeParse(face).success).toBe(true);
		expect(checkDecisionCardCopy(face)).toEqual([]);
		expect(face.title).toContain("Port the landing page");
		expect(face.context && face.story && face.whyMe).toBeTruthy();
		// One short story: at most 60 words on the card, in two or three sentences.
		expect(
			words(`${face.title} ${face.story} ${face.whyMe} ${face.recommendation}`),
		).toBeLessThanOrEqual(60);
		// The summary names no single answer to pick: the buttons state their own.
		expect(face.recommendedIntent).toBeUndefined();
		expect(face.actionLabels).toBeUndefined();
		expect(face.model).toBeUndefined();
	},
);

it("recommends in the summary what the card's own answers recommend", () => {
	const filed = request(
		"execution_hold",
		"Stopped.",
		HOLD_SUBJECTS.execution_hold,
	);
	const decision = laneHoldDecision(filed)!;
	const face = laneHoldFace(filed)!;
	// Both open with the first button's own words.
	expect(face.recommendation.startsWith(decision.options[0]!.label)).toBe(true);
	expect(decision.recommendation.startsWith(decision.options[0]!.label)).toBe(
		true,
	);
	expect(
		laneHoldFace(
			request("result_unverified", "Landed.", HOLD_SUBJECTS.result_unverified),
		)!.recommendation,
	).toMatch(/^Check the change, then complete the task/);
	expect(
		laneHoldFace(
			request("accountable_owner", "Paused.", HOLD_SUBJECTS.accountable_owner),
		)!.recommendation,
	).toMatch(/^Make yourself the owner/);
});

it("keeps the summary valid when the task's name breaks the card copy rules", () => {
	for (const title of [
		// Words a card never shows, a raw identifier, and a name too long for one line.
		"Fix the workflow session kernel",
		"Deploy 0123456789abcdef now",
		"A very long task name that goes on and on and on well past what one short card line can hold",
	]) {
		const face = laneHoldFace(
			request(
				"execution_hold",
				"Stopped.",
				`What should happen with "${title}"?`,
			),
		)!;
		expect(checkDecisionCardCopy(face)).toEqual([]);
		expect(face.title).toBe("What should happen with this task?");
	}
});

it("also recognises a hold request that already carries its derived answers", () => {
	const filed = request(
		"execution_hold",
		"Stopped.",
		HOLD_SUBJECTS.execution_hold,
	);
	const read = {
		...filed,
		metadata: { ...filed.metadata, decisionDeck: laneHoldDecision(filed) },
	};
	expect(laneHoldFace(read)).toEqual(laneHoldFace(filed));
});

it("writes no fixed summary for any other request", () => {
	expect(
		laneHoldFace({
			workItemId,
			subject: "Ask",
			metadata: { source: "elsewhere" },
		}),
	).toBeNull();
	// A permission card carries its own answers and keeps its own summary.
	expect(
		laneHoldFace({
			workItemId,
			subject: "Ask?",
			metadata: {
				source: "lane-dispatch-blocker",
				decisionDeck: { classId: "lane.delegation" },
				laneBlocker: {
					kind: "execution_hold",
					executor: "codex",
					workVersion: 1,
				},
			},
		}),
	).toBeNull();
	expect(
		laneHoldFace({
			...request("execution_hold", "Stopped.", "Ask?"),
			workItemId: null,
		}),
	).toBeNull();
});

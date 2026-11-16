import { expect, it } from "vite-plus/test";
import { laneHoldDecision } from "./lane-hold-decision";

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

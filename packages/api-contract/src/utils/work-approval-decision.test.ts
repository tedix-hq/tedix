import { expect, it } from "vite-plus/test";
import { workApprovalDecision } from "./work-approval-decision";

const base = {
	action: "admission",
	proposal: {},
	taskTitle: "Review supplier shortlist",
	proposalTaskVersion: 3,
	taskVersion: 3,
	taskDisposition: "accepted",
};
const sentences = (text: string) => text.match(/[^.!?]+[.!?]+/g)?.length ?? 0;

it("names the action and the task, and says what each answer does in one sentence", () => {
	const copy = workApprovalDecision(base);
	expect(copy.title).toBe('Let work start on "Review supplier shortlist"?');
	expect(copy.what).toContain("Review supplier shortlist");
	expect(sentences(copy.ifApproved)).toBe(1);
	expect(sentences(copy.ifRejected)).toBe(1);
	expect(copy.ifApproved).toMatch(/start/);
	expect(copy.ifRejected).toMatch(/does not start/);
	// Nothing in the data argues for either answer.
	expect(copy.recommendation).toBeNull();
});

it("describes each kind of request in plain words", () => {
	expect(
		workApprovalDecision({
			...base,
			action: "acceptance",
			taskDisposition: "proposed",
			proposal: {
				acceptanceContract: { doneLooksLike: "Three suppliers compared." },
			},
		}),
	).toMatchObject({
		title: 'Accept the task "Review supplier shortlist"?',
		what: 'Accept "Review supplier shortlist" as agreed work. Done means: Three suppliers compared.',
	});
	expect(
		workApprovalDecision({
			...base,
			action: "agent.create",
			proposal: { kind: "tedi", name: "Supplier scout", slug: "scout" },
		}).title,
	).toBe('Create the tedi "Supplier scout" for "Review supplier shortlist"?');
	expect(
		workApprovalDecision({
			...base,
			action: "agent.create",
			proposal: { kind: "external_agent", displayName: "Build bot" },
		}).title,
	).toBe('Register the agent "Build bot" for "Review supplier shortlist"?');
	expect(
		workApprovalDecision({
			...base,
			action: "agent.connect",
			proposal: { kind: "connection", label: "Sales mailbox" },
		}).title,
	).toBe(
		'Set up the connection "Sales mailbox" for "Review supplier shortlist"?',
	);
	expect(
		workApprovalDecision({
			...base,
			action: "resource.grant",
			proposal: { kind: "connection_grant", providerId: "gmail" },
		}).what,
	).toContain("gmail");
	// An action Tedix does not know keeps its name and promises nothing more.
	const unknown = workApprovalDecision({ ...base, action: "budget.raise" });
	expect(unknown.title).toBe(
		'Approve "budget raise" for "Review supplier shortlist"?',
	);
	expect(unknown.ifRejected).toBe(
		"Nothing changes and the requester sees your reason.",
	);
});

it("says each answer in one sentence for every kind of request", () => {
	for (const [action, proposal] of [
		["admission", {}],
		["acceptance", {}],
		["agent.create", { kind: "tedi", name: "Scout" }],
		["agent.create", { kind: "external_agent", displayName: "Bot" }],
		["agent.connect", { kind: "connection", label: "Mail" }],
		["resource.grant", { kind: "connection_grant", providerId: "gmail" }],
		["something.else", {}],
	] as const) {
		const copy = workApprovalDecision({ ...base, action, proposal });
		expect(copy.title.endsWith("?")).toBe(true);
		expect(copy.title).toContain("Review supplier shortlist");
		expect(sentences(copy.ifApproved)).toBe(1);
		expect(sentences(copy.ifRejected)).toBe(1);
	}
});

it("recommends rejecting only when the task changed or closed since the request", () => {
	expect(
		workApprovalDecision({ ...base, taskVersion: 4 }).recommendation,
	).toEqual({
		decision: "rejected",
		reason:
			"The task changed after this was requested, so the request no longer matches it.",
	});
	expect(
		workApprovalDecision({ ...base, taskDisposition: "cancelled" })
			.recommendation,
	).toEqual({ decision: "rejected", reason: "The task is already closed." });
	// Missing facts never produce a recommendation.
	expect(
		workApprovalDecision({ action: "admission", proposal: {}, taskTitle: "T" })
			.recommendation,
	).toBeNull();
});

it("keeps a long task title readable in the question", () => {
	const copy = workApprovalDecision({ ...base, taskTitle: "A".repeat(200) });
	expect(copy.title.length).toBeLessThanOrEqual(120);
	expect(copy.title.endsWith('…"?')).toBe(true);
});

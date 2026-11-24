import { z } from "zod";

const laneRequest = z.object({
	source: z.literal("lane-dispatch-blocker"),
	laneBlocker: z.object({
		executor: z.enum(["codex", "claude-code", "opencode", "devin", "tedi"]),
	}),
});

const names = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
	tedi: "Tedi",
};

/** Runner provenance is separate from the authenticated carrier and grants no authority. */
export function laneRequestHarness(metadata: unknown) {
	const parsed = laneRequest.safeParse(metadata);
	return parsed.success ? parsed.data.laneBlocker.executor : undefined;
}

export function laneRunnerAsker(metadata: unknown): string | undefined {
	const harness = laneRequestHarness(metadata);
	return harness && names[harness];
}

/** What the person is asked to allow, in plain words. */
const RESERVED_STEPS: Record<string, string> = {
	credentials: "handle keys or account access",
	money: "spend money",
	external_message: "message people outside the team",
	public_publish: "publish something publicly",
	delete_data: "delete live data",
	legal: "make a legal commitment",
	customer_config: "change a customer's live setup",
};

export const laneActionLabel = (action: string) =>
	RESERVED_STEPS[action] ?? action.replace(/_/g, " ");

const approvalActions = z.object({
	source: z.literal("lane-dispatch-blocker"),
	laneBlocker: z.object({
		matchedActions: z.array(z.object({ action: z.string().min(1) })).min(1),
	}),
});

export function laneApprovalTitle(metadata: unknown, task?: string) {
	const parsed = approvalActions.safeParse(metadata);
	if (!parsed.success) return;
	const actions = [
		...new Set(
			parsed.data.laneBlocker.matchedActions.map(({ action }) =>
				laneActionLabel(action),
			),
		),
	].join(" and ");
	return (
		actions.charAt(0).toUpperCase() +
		actions.slice(1) +
		(task ? ` for “${task}”?` : "?")
	);
}

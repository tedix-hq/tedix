import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";

/**
 * What the API tells the conversation an agent run was started from: that
 * the run ended, or that it asks the person a question. Keyed by the
 * conversation and the turn recorded when the run was started.
 */
export type AgentRunReport =
	| {
			kind: "ended";
			conversationId: string;
			/** The turn that started the run; its person and tedi report it. */
			sourceTurnId: string | null;
			workItemId: string;
			attemptId: string;
			title: string;
			outcome: "succeeded" | "failed" | "cancelled";
			/** The runner's result, or why the run failed. */
			result: string;
			/** Commits the run landed, newest last. */
			commits: string[];
			/** What the agent said it could not confirm. */
			unverified: string | null;
	  }
	| {
			kind: "question";
			conversationId: string;
			workItemId: string;
			attemptId: string;
			seq: number;
			title: string;
			executor: string;
	  };

type EndedReport = Extract<AgentRunReport, { kind: "ended" }>;

/** The one line shown where the person's message would be. */
export const RUN_OUTCOME_LINE: Record<EndedReport["outcome"], string> = {
	succeeded: "Run finished",
	failed: "Run failed",
	cancelled: "Run stopped",
};

/** The plain notice when no turn can report the run. */
export function runEndedNotice(report: EndedReport): string {
	const note = report.result
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500)
		.replace(/[.\s]+$/, "");
	return `The run for "${report.title}" ended: ${report.outcome}.${note ? ` ${note}.` : ""} Task: /work/items/${report.workItemId}`;
}

/**
 * The message the report turn answers. The run's own words are data; the
 * turn only writes the reply.
 */
export function runReportPrompt(report: EndedReport): string {
	const link = `/work/items/${report.workItemId}`;
	return [
		`The agent run "${report.title}" that was started from this conversation has ended: ${report.outcome}. Tell the person in a short reply, without being asked: the outcome; what changed (each commit SHA with its title when the result names it, else the result itself); what is still unverified; and the link ${link}.${report.outcome === "failed" ? " Give the real reason it failed, from the result." : ""} This reply only reports: do not run code, call tools, ask for approval or start new work. If the person wants more, they will ask.`,
		`Commits landed: ${report.commits.length ? report.commits.join(", ") : "none recorded"}`,
		`Unverified: ${report.unverified ? wrapUntrustedInput(report.unverified, "agent_run") : "nothing reported"}`,
		`Result: ${report.result.trim() ? wrapUntrustedInput(report.result, "agent_run") : "none reported"}`,
	].join("\n\n");
}

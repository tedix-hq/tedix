import type { Observation } from "@tedix/context-core/types";
import { projectEmbeddedTranscript } from "./embedded-transcript";
import type { TraceToolStep } from "./trace-bundle-writer";

const MAX_OBSERVER_TOOL_EVIDENCE = 32;

export interface ObserverTurnInput {
	content: string;
	ts: number;
	sessionKey?: string;
}

/** The host/auth envelope is runtime context, not a user-authored memory. */
export function observerUserTurn<T extends ObserverTurnInput>(user: T): T {
	if (!user.sessionKey?.startsWith("embed:")) return user;
	const transcript = projectEmbeddedTranscript({
		messages: [{ role: "user", content: user.content }],
	});
	return { ...user, content: transcript.messages[0]?.content ?? "" };
}

export interface ObserverToolExecutionEvidence {
	ref: string;
	tool: string;
	outcome: "succeeded" | "failed" | "unavailable" | "unknown";
	resultDigest?: string;
}

/**
 * Guarantee one conservative terminal episode for every durable completed turn.
 * The Observer remains the semantic source when it emits an episode. When it
 * omits one or its LLM call fails, this mechanical fallback records only facts
 * the runtime owns: the visible request/response and bounded execution receipt
 * counts. It is always `partial`; runtime settlement alone is not business
 * success.
 */
export function ensureTerminalEpisodeObservation(
	observations: readonly Observation[],
	user: ObserverTurnInput,
	assistant: ObserverTurnInput,
	executionEvidence: readonly ObserverToolExecutionEvidence[] = [],
): Observation[] {
	if (observations.some((observation) => observation.type === "episode")) {
		return [...observations];
	}
	const now = new Date(assistant.ts || Date.now());
	const succeeded = executionEvidence.filter(
		(evidence) => evidence.outcome === "succeeded",
	).length;
	const failed = executionEvidence.filter(
		(evidence) =>
			evidence.outcome === "failed" || evidence.outcome === "unavailable",
	).length;
	const response = assistant.content.trim().slice(0, 320);
	const request = observerUserTurn(user).content.trim().slice(0, 240);
	return [
		...observations,
		{
			date: now.toISOString().slice(0, 10),
			time: now.toISOString().slice(11, 16),
			priority: "medium",
			type: "episode",
			content:
				response || "The turn completed without a visible assistant response.",
			details: [
				...(request ? [`User request: ${request}`] : []),
				`Canonical tool receipts: ${executionEvidence.length} total, ${succeeded} succeeded, ${failed} failed or unavailable.`,
				"Mechanical runtime fallback: task success was not independently established.",
			],
			outcomeStatus: "partial",
		},
	];
}

function observerToolOutcome(
	step: TraceToolStep,
): ObserverToolExecutionEvidence["outcome"] {
	if (step.finishReason === "facet-tool-error") return "failed";
	if (step.finishReason === "facet-tool-unavailable") return "unavailable";
	return step.toolResultCount > 0 ? "succeeded" : "unknown";
}

/**
 * Build a bounded, content-free execution envelope from the same step buffer
 * that owns trace-bundle and rationale refs. Raw arguments/results stay out of
 * memory; the Observer receives only span identity, outcome, and a digest.
 */
export function observerToolEvidenceFromSteps(
	runId: string,
	steps: readonly TraceToolStep[],
): ObserverToolExecutionEvidence[] {
	const evidence: ObserverToolExecutionEvidence[] = [];
	for (const step of steps) {
		for (const [index, tool] of step.toolNames.entries()) {
			if (evidence.length >= MAX_OBSERVER_TOOL_EVIDENCE) return evidence;
			evidence.push({
				ref: `${runId}:step:${step.stepNumber}:${index}:${tool}`,
				tool,
				outcome: observerToolOutcome(step),
				...(step.resultDigest ? { resultDigest: step.resultDigest } : {}),
			});
		}
	}
	return evidence;
}

/** Hash a tool result for correlation without placing its content in memory. */
export async function digestObserverToolResult(
	result: unknown,
): Promise<string | undefined> {
	try {
		const serialized =
			result === undefined ? "undefined" : JSON.stringify(result);
		if (serialized === undefined) return undefined;
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(serialized),
		);
		return `sha256:${Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")}`;
	} catch {
		return undefined;
	}
}

export function buildObserverInput(
	user: ObserverTurnInput,
	assistant: ObserverTurnInput,
	executionEvidence: readonly ObserverToolExecutionEvidence[] = [],
): string {
	const now = new Date(assistant.ts || Date.now());
	const date = now.toISOString().slice(0, 10);
	const time = now.toISOString().slice(11, 16);
	const sections = [
		`Today: ${date} ${time} UTC`,
		"",
		"## User",
		observerUserTurn(user).content,
		"",
		"## Assistant",
		assistant.content,
	];
	if (executionEvidence.length > 0) {
		sections.push(
			"",
			"## Canonical execution evidence",
			"These bounded records are authoritative for whether tools ran. Raw arguments and results are deliberately omitted.",
			JSON.stringify(executionEvidence),
		);
	}
	return sections.join("\n");
}

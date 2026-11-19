import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

/** A run a tedi started for an agent, as the `start_agent_run` tool reports it. */
export type AgentRunRef = {
	workItemId: string;
	title: string;
	/** The executor id the tedi chose, such as `codex`. Empty when not given. */
	executor: string;
};

const MAX_UNWRAP_DEPTH = 5;
/** Where a tool result sits once a transport or the event log has wrapped it. */
const WRAPPER_KEYS = [
	"result",
	"resultPreview",
	"resultProjection",
	"structuredContent",
	"data",
	"output",
	"value",
	"preview",
	"content",
	"text",
] as const;
const TITLE_MAX_CHARS = 200;

function parsed(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (!text.startsWith("{") && !text.startsWith("[")) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/**
 * Reads a tool result as the start of an agent run. The result may arrive as
 * an object or as JSON text, on its own or inside a wrapper (`{ result }`, a
 * content array of text parts, the event log's preview). Anything that is not
 * `kind: "agent_run"` with a task id is not a run.
 */
export function agentRunFromToolResult(
	value: unknown,
	depth = 0,
): AgentRunRef | null {
	if (depth > MAX_UNWRAP_DEPTH) return null;
	const candidate = parsed(value);
	if (Array.isArray(candidate)) {
		for (const item of candidate) {
			const found = agentRunFromToolResult(item, depth + 1);
			if (found) return found;
		}
		return null;
	}
	if (!isRecord(candidate)) return null;
	if (candidate.kind === "agent_run") {
		const workItemId =
			typeof candidate.workItemId === "string"
				? candidate.workItemId.trim()
				: "";
		if (!workItemId) return null;
		const text = (field: unknown) =>
			typeof field === "string"
				? sanitizeUntrustedText(field).replace(/\s+/g, " ").trim()
				: "";
		return {
			workItemId,
			title: text(candidate.title).slice(0, TITLE_MAX_CHARS),
			executor: text(candidate.executor),
		};
	}
	for (const key of WRAPPER_KEYS) {
		if (!(key in candidate)) continue;
		const found = agentRunFromToolResult(candidate[key], depth + 1);
		if (found) return found;
	}
	return null;
}

/**
 * The agent runs started in a list of runtime events, oldest first, one per
 * task. Only a completed tool call counts.
 */
export function agentRunsFromEvents(
	events: readonly { kind: string; payload?: unknown }[],
): AgentRunRef[] {
	const runs = new Map<string, AgentRunRef>();
	for (const event of events) {
		if (event.kind !== "tool.completed" || !isRecord(event.payload)) continue;
		const run = agentRunFromToolResult(event.payload, 1);
		if (run && !runs.has(run.workItemId)) runs.set(run.workItemId, run);
	}
	return [...runs.values()];
}

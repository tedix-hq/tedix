import { SkillWorkflowTimelineEventSchema } from "@tedix/api-contract/schemas/cognitive";

type Receipt = Record<string, unknown>;

const kinds: Record<string, string> = {
	workflow_step_attempt: "step",
	workflow_step_rollback: "rollback",
	workflow_step_sleep: "sleep",
	workflow_step_sleep_until: "sleep",
	workflow_step_wait_for_event: "wait",
	workflow_mcp_call: "mcp",
	workflow_network_call: "network",
};

/** Project only operational metadata; request/response bodies never enter the index. */
export function compactTimelineReceipt(input: {
	path: string;
	value?: unknown;
	outcome?: "pending" | "success" | "failure";
}) {
	if (!input.value || typeof input.value !== "object") return null;
	const value = input.value as Receipt;
	const kind = kinds[String(value.kind)];
	if (!kind || typeof value.executionEpoch !== "number") return null;
	const step = value.step as Receipt | undefined;
	if (!step || typeof step.name !== "string") return null;
	const startedAt = (value.startedAt ?? value.waitingAt ?? null) as
		| string
		| null;
	const endedAt = (value.completedAt ?? value.resolvedAt ?? null) as
		| string
		| null;
	const durationMs =
		typeof value.durationMs === "number"
			? value.durationMs
			: startedAt && endedAt
				? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
				: null;
	const namespace =
		typeof value.namespace === "string" ? value.namespace : undefined;
	const host = typeof value.host === "string" ? value.host : undefined;
	return SkillWorkflowTimelineEventSchema.parse({
		schemaVersion: 1,
		id: input.path,
		path: input.path,
		executionEpoch: value.executionEpoch,
		kind,
		name: step.name,
		count: step.count,
		attempt: value.attempt,
		phase: value.phase,
		lane: namespace ?? host ?? kind,
		startedAt,
		endedAt,
		durationMs,
		status: value.status,
		outcome: input.outcome ?? "pending",
		namespace,
		method: value.method,
		host,
		httpStatus: value.httpStatus,
	});
}

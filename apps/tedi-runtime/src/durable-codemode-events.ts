import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { exceptionTopology } from "./exception-topology";
import type { RuntimeEventOutbox } from "./runtime-event-outbox";

export interface DurableCodemodeEventInput {
	action: "run" | "approve" | "reject" | "rollback";
	executionId: string;
	result: unknown;
	status?: string;
}

export function buildDurableCodemodeEvents(
	input: DurableCodemodeEventInput,
	context: {
		tediId: string;
		runId: string;
		conversationId: string;
		homeRunId?: string;
		createdAt: string;
	},
): TediRuntimeEvent[] {
	const { tediId, runId, conversationId, homeRunId, createdAt } = context;
	const events: TediRuntimeEvent[] = [];
	const kind =
		input.status === "paused"
			? "approval.requested"
			: input.status === "error"
				? "tool.failed"
				: "tool.completed";
	events.push({
		id: `${runId}:durable-code:${input.action}:${input.executionId}`,
		tediId,
		kind,
		conversationId,
		runId,
		sequence: 0,
		payload: {
			surface: "durable_codemode",
			action: input.action,
			executionId: input.executionId,
			status: input.status ?? null,
			result: input.result,
		},
		runtime: { backend: "cloudflare-agents" },
		createdAt: createdAt,
	});
	const projectedCalls =
		input.result &&
		typeof input.result === "object" &&
		Array.isArray((input.result as { calls?: unknown }).calls)
			? ((input.result as { calls: Array<Record<string, unknown>> }).calls ??
				[])
			: [];
	for (const call of projectedCalls) {
		const seq = typeof call.seq === "number" ? call.seq : 0;
		const state = typeof call.state === "string" ? call.state : "unknown";
		events.push({
			id: `${runId}:durable-code:${input.executionId}:call:${seq}:${state}`,
			tediId,
			kind:
				state === "error"
					? "tool.failed"
					: state === "pending" || state === "executing"
						? "tool.started"
						: "tool.completed",
			conversationId,
			runId,
			sequence: Math.max(1, seq + 1),
			payload: {
				surface: "durable_codemode_call",
				parentExecutionId: input.executionId,
				callSeq: seq,
				connector: call.connector ?? null,
				method: call.method ?? null,
				state,
				requiresApproval: call.requiresApproval === true,
				ephemeral: call.ephemeral === true,
				args: call.args ?? null,
				...(call.result === undefined ? {} : { result: call.result }),
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: createdAt,
		});
	}
	if (input.action === "approve" && input.status === "completed") {
		events.push({
			id: `${runId}:durable-code:approval-resolved:${input.executionId}`,
			tediId,
			kind: "approval.resolved",
			conversationId,
			runId,
			sequence: 4,
			payload: {
				surface: "durable_codemode",
				executionId: input.executionId,
				status: "approved",
				...(homeRunId ? { homeRunId: homeRunId } : {}),
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: createdAt,
		});
		events.push({
			id: `${runId}:durable-code:run-completed:${input.executionId}`,
			tediId,
			kind: "run.completed",
			conversationId,
			runId,
			sequence: 5,
			payload: {
				surface: "durable_codemode",
				executionId: input.executionId,
				result: input.result,
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: createdAt,
		});
	}
	if (input.action === "reject" && input.status === "rejected") {
		events.push({
			id: `${runId}:durable-code:approval-rejected:${input.executionId}`,
			tediId,
			kind: "approval.resolved",
			conversationId,
			runId,
			sequence: 4,
			payload: {
				surface: "durable_codemode",
				executionId: input.executionId,
				status: "rejected",
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: createdAt,
		});
		events.push({
			id: `${runId}:durable-code:run-canceled:${input.executionId}`,
			tediId,
			kind: "run.canceled",
			conversationId,
			runId,
			sequence: 5,
			payload: {
				reason: "durable_code_rejected",
				executionId: input.executionId,
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: createdAt,
		});
	}
	return events;
}

/** Execution is already committed. Publication must not invite a side-effecting retry. */
export async function publishDurableCodemodeEvents(
	outbox: RuntimeEventOutbox,
	events: TediRuntimeEvent[],
): Promise<void> {
	for (const event of events) {
		try {
			if (["run.completed", "run.failed", "run.canceled"].includes(event.kind))
				await outbox.publishTerminal(event);
			else await outbox.publish(event);
		} catch (error) {
			console.error({
				component: "tedi-runtime-codemode",
				event: "tedi.durable_codemode_event_publish_failed",
				exception: exceptionTopology(error),
			});
		}
	}
}

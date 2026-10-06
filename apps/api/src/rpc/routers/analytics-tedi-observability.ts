import type { TediObservabilitySnapshot } from "@tedix/api-contract/schemas/analytics";
import { isPlatformPrincipal } from "@tedix/auth/types";
import type { TediObservabilityRuntimeRow } from "@tedix/db/queries/cognitive-runtime";
import { getTediById } from "@tedix/db/queries/tedis";
import { type BaseContext, createError, ErrorCodes } from "../orpc";

export const OBSERVABILITY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function requireObservabilityTediAccess(
	context: BaseContext,
	tediId: string,
) {
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	if (isPlatformPrincipal(context)) return tedi;
	if (context.tediId && context.tediId !== tediId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (
		context.organizationId &&
		context.organizationId !== tedi.organizationId
	) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (!context.organizationId && !context.tediId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	return tedi;
}

const DIAGNOSTIC_KINDS = new Set([
	"run.failed",
	"run.canceled",
	"tool.failed",
	"step.retry",
	"runtime.health_changed",
	"runtime.mirror_skipped",
	"skill.failed",
	"workstation.exec.failed",
	"workstation.egress.deny",
	"browser.egress.deny",
	"approval.requested",
]);

function outcome(kind: string): "success" | "failure" | "warning" | "unknown" {
	if (kind.endsWith(".failed") || kind.endsWith(".deny")) return "failure";
	if (kind.endsWith(".completed")) return "success";
	if (
		kind.endsWith(".retry") ||
		kind === "run.canceled" ||
		kind === "runtime.health_changed" ||
		kind === "runtime.mirror_skipped" ||
		kind === "approval.requested"
	) {
		return "warning";
	}
	return "unknown";
}

function timestamp(value: string): string {
	return new Date(value).toISOString();
}

function toolName(payload: Record<string, unknown> | null): string {
	for (const key of ["toolName", "name"]) {
		const value = payload?.[key];
		if (typeof value === "string" && value.length > 0)
			return value.slice(0, 200);
	}
	return "unknown_tool";
}

function duration(payload: Record<string, unknown> | null): number | null {
	for (const key of ["durationMs", "latencyMs"]) {
		const value = payload?.[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return value;
		}
	}
	return null;
}

export function projectTediObservability(input: {
	tediId: string;
	from: string;
	to: string;
	runtimeEvents: TediObservabilityRuntimeRow[];
	auditEvents: Array<{
		id: string;
		action: string;
		resourceType: string;
		resourceId: string | null;
		timestamp: Date;
	}>;
	truncated: boolean;
	auditReceiptId: string;
}): TediObservabilitySnapshot {
	const invocations = input.runtimeEvents
		.filter(
			(row) => row.kind === "tool.completed" || row.kind === "tool.failed",
		)
		.map((row) => ({
			id: row.id,
			toolName: toolName(row.payload),
			outcome: outcome(row.kind),
			durationMs: duration(row.payload),
			runId: row.runId,
			traceId: row.traceId,
			occurredAt: timestamp(row.createdAt),
		}));
	const traces = new Map<
		string,
		{
			traceId: string;
			firstAt: string;
			lastAt: string;
			eventCount: number;
			invocationCount: number;
			failureCount: number;
		}
	>();
	for (const row of input.runtimeEvents) {
		if (!row.traceId) continue;
		const occurredAt = timestamp(row.createdAt);
		const trace = traces.get(row.traceId) ?? {
			traceId: row.traceId,
			firstAt: occurredAt,
			lastAt: occurredAt,
			eventCount: 0,
			invocationCount: 0,
			failureCount: 0,
		};
		trace.firstAt = occurredAt < trace.firstAt ? occurredAt : trace.firstAt;
		trace.lastAt = occurredAt > trace.lastAt ? occurredAt : trace.lastAt;
		trace.eventCount += 1;
		if (row.kind === "tool.completed" || row.kind === "tool.failed") {
			trace.invocationCount += 1;
		}
		if (outcome(row.kind) === "failure") trace.failureCount += 1;
		traces.set(row.traceId, trace);
	}
	const durations = invocations
		.map((item) => item.durationMs)
		.filter((value): value is number => value !== null);
	return {
		tediId: input.tediId,
		from: input.from,
		to: input.to,
		source: "tenant_d1",
		truncated: input.truncated,
		metrics: {
			runtimeEvents: input.runtimeEvents.length,
			auditEvents: input.auditEvents.length,
			invocations: invocations.length,
			failedInvocations: invocations.filter(
				(item) => item.outcome === "failure",
			).length,
			traceCount: traces.size,
			averageInvocationDurationMs:
				durations.length === 0
					? null
					: durations.reduce((total, value) => total + value, 0) /
						durations.length,
		},
		logs: input.runtimeEvents
			.filter((row) => DIAGNOSTIC_KINDS.has(row.kind))
			.map((row) => ({
				id: row.id,
				kind: row.kind,
				outcome: outcome(row.kind),
				runId: row.runId,
				traceId: row.traceId,
				occurredAt: timestamp(row.createdAt),
			})),
		invocations,
		traces: [...traces.values()].sort((a, b) =>
			b.lastAt.localeCompare(a.lastAt),
		),
		auditEvents: input.auditEvents.map((row) => ({
			id: row.id,
			action: row.action,
			resourceType: row.resourceType,
			resourceId: row.resourceId,
			occurredAt: row.timestamp.toISOString(),
		})),
		auditReceiptId: input.auditReceiptId,
	};
}

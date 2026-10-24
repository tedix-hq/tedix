import { tracing } from "cloudflare:workers";
import type { Context } from "@earendil-works/chord/context";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import {
	createTelemetryWriter,
	runWithTelemetrySpan,
} from "@tedix/worker-kit/telemetry";

type PiSpan = Context["telemetry"];
type Attributes = Parameters<PiSpan["setAttributes"]>[0];
type TraceSpan = {
	setAttribute(key: string, value: string | number | boolean): unknown;
};
export type PiTraceSink = <T>(
	name: string,
	run: (span: TraceSpan) => Promise<T>,
) => T | Promise<T>;

const SPANS = new Set([
	"pi.durable.submit",
	"pi.durable.phase",
	"pi.ai.request",
	"pi.ai.poll",
]);
const EVENTS = new Set([
	"pi.durable.entry",
	"pi.durable.submission",
	"pi.durable.report",
	"pi.durable.checkpoint",
	"pi.durable.replay",
	"pi.ai.first_chunk",
	"pi.ai.block",
]);
const NUMBERS = new Set([
	"task.id",
	"conversation.id",
	"submission.id",
	"entry.id",
	"answer.entry_id",
	"attempt",
	"index",
	"chars",
	"usage.input",
	"usage.output",
	"usage.cache_read",
	"usage.cache_write",
	"cost.total",
]);
const PHASES = [
	"prepare",
	"request",
	"retry",
	"poll",
	"tools",
	"call",
	"execute",
	"select",
	"summarize",
	"wait",
];
const STRINGS: Record<string, readonly string[]> = {
	"submission.type": ["input", "write"],
	result: ["queued", "placed", "done"],
	status: ["done", "unanswered"],
	kind: ["run", "abort"],
	"task.name": [
		"pi.generation",
		"pi.compaction",
		"pi.tool",
		"tedix.tool-approval",
	],
	phase: PHASES,
	outcome: [
		"waiting",
		"sleeping",
		"done",
		"faulted",
		"aborted",
		...PHASES.map((phase) => `next=${phase}`),
	],
	stop: [
		"pending",
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted",
		"deferred",
	],
	type: [
		"session_failed",
		"task_faulted",
		"task_parked",
		"migration_failed",
		"task_outdated",
		"task_error",
		"extension_error",
		"host_error",
		"listener_error",
		"text",
		"thinking",
		"tool_call",
	],
	reason: ["threw", "restart_limit", "missing_task", "incompatible_task"],
};
const write = createTelemetryWriter("tedi.pi.tracing");

function annotate(span: TraceSpan, attributes: Attributes = {}): void {
	write(() => {
		for (const [key, value] of Object.entries(attributes)) {
			if (
				(NUMBERS.has(key) &&
					typeof value === "number" &&
					Number.isFinite(value) &&
					value >= 0) ||
				(key === "resumed" && typeof value === "boolean") ||
				(typeof value === "string" &&
					Object.hasOwn(STRINGS, key) &&
					STRINGS[key]!.includes(value))
			) {
				write(() => span.setAttribute(key, value as string | number | boolean));
			}
		}
	});
}

/** Native phases nest in the current Cloudflare trace; no cross-restart parent restoration. */
export function createPiTelemetry(
	enter: PiTraceSink = (name, run) => tracing.enterSpan(name, run),
): NonNullable<HarnessOptions["telemetry"]> {
	const startSpan = async <T>(
		options: Parameters<PiSpan["startSpan"]>[0],
		callback: (span: PiSpan) => T | Promise<T>,
	): Promise<T> => {
		const result = await runWithTelemetrySpan<
			{ ok: true; value: T } | { ok: false; error: unknown }
		>(
			(run) => {
				const name = options.name;
				return enter(SPANS.has(name) ? name : "pi.operation", run);
			},
			async (sink) => {
				write(() => annotate(sink, options.attributes));
				const span: PiSpan = {
					startSpan,
					// Cloudflare's public API has no explicit parent/link propagation.
					addLink() {},
					addEvent(name, attributes) {
						if (!EVENTS.has(name)) return;
						write(() =>
							enter(name, async (event) => annotate(event, attributes)),
						);
					},
					setAttributes: (attributes) => annotate(sink, attributes),
					setStatus: (status) =>
						write(() =>
							sink.setAttribute(
								"pi.status",
								status.status === "error" ? "error" : "ok",
							),
						),
				};
				try {
					return { ok: true as const, value: await callback(span) };
				} catch (error) {
					span.setStatus({ status: "error" });
					// Do not let enterSpan auto-record the private thrown value.
					return { ok: false as const, error };
				}
			},
		);
		if (!result.ok) throw result.error;
		return result.value;
	};
	return { startSpan };
}

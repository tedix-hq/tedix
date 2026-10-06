import type {
	ExecutionState,
	ProxyToolOutput,
	ToolLogEntry,
} from "@cloudflare/codemode";
import {
	redactValue,
	scrubText,
	TEDIX_REDACTED,
} from "@tedix/context-core/trace-safety";

const MAX_CALL_ENTRIES = 20;
const MAX_ARGUMENT_CHARS = 768;
const MAX_RESULT_CHARS = 1_024;
const MAX_OUTPUT_RESULT_CHARS = 16_000;
const MAX_CODE_CHARS = 4_000;
const MAX_LOG_CHARS = 1_000;
const MAX_LOG_ENTRIES = 20;

export type ProjectedProxyToolOutput = ProxyToolOutput & {
	callsOmitted?: number;
	pendingOmitted?: number;
};

export type ProjectedExecutionState = ExecutionState & {
	codeTruncated?: boolean;
	logOmitted?: number;
	logsOmitted?: number;
};

function boundedRedactedValue(
	value: unknown,
	maxChars: number,
	preserveTruncationEnvelope = false,
): unknown {
	try {
		const redacted = redactValue(value);
		const serialized = JSON.stringify(redacted);
		if (serialized === undefined) {
			return { unsupported: true };
		}
		if (serialized.length <= maxChars) return JSON.parse(serialized) as unknown;
		// Completed results may already carry the gateway's canonical envelope.
		// Keep its original-size metadata and discriminant when clipping again.
		if (
			preserveTruncationEnvelope &&
			typeof redacted === "object" &&
			redacted !== null &&
			!Array.isArray(redacted) &&
			"__tedix_truncated" in redacted &&
			redacted.__tedix_truncated === true &&
			"preview" in redacted &&
			typeof redacted.preview === "string"
		) {
			return { ...redacted, preview: redacted.preview.slice(0, maxChars) };
		}
		return {
			truncated: true,
			originalChars: serialized.length,
			preview: scrubText(serialized.slice(0, maxChars)),
		};
	} catch {
		return {
			redactionFailed: true,
			value: TEDIX_REDACTED,
		};
	}
}

function boundedRedactedText(value: string, maxChars: number): string {
	const redacted = scrubText(value);
	return redacted.length <= maxChars
		? redacted
		: `${redacted.slice(0, maxChars)}\n…(truncated)`;
}

function selectCallEntries(calls: readonly ToolLogEntry[]): {
	selected: ToolLogEntry[];
	omitted: number;
} {
	if (calls.length <= MAX_CALL_ENTRIES) {
		return { selected: [...calls], omitted: 0 };
	}
	const headCount = Math.floor(MAX_CALL_ENTRIES / 2);
	const tailCount = MAX_CALL_ENTRIES - headCount;
	return {
		selected: [...calls.slice(0, headCount), ...calls.slice(-tailCount)],
		omitted: calls.length - MAX_CALL_ENTRIES,
	};
}

export function projectDurableCodemodeCalls(calls: readonly ToolLogEntry[]): {
	calls: ToolLogEntry[];
	omitted: number;
} {
	const { selected, omitted } = selectCallEntries(calls);
	return {
		calls: selected.map((call) => ({
			seq: call.seq,
			connector: call.connector,
			method: call.method,
			args: boundedRedactedValue(call.args, MAX_ARGUMENT_CHARS),
			...(call.result === undefined
				? {}
				: {
						result: boundedRedactedValue(call.result, MAX_RESULT_CHARS),
					}),
			requiresApproval: call.requiresApproval,
			...(call.ephemeral === undefined ? {} : { ephemeral: call.ephemeral }),
			state: call.state,
		})),
		omitted,
	};
}

export function projectDurableCodemodeOutput(
	output: ProxyToolOutput,
): ProjectedProxyToolOutput {
	const projectedCalls = output.calls
		? projectDurableCodemodeCalls(output.calls)
		: null;

	if (output.status === "paused") {
		const pending = output.pending.slice(0, MAX_CALL_ENTRIES);
		return {
			...output,
			pending: pending.map((pending) => ({
				...pending,
				args: boundedRedactedValue(pending.args, MAX_ARGUMENT_CHARS),
			})),
			...(output.pending.length > pending.length
				? { pendingOmitted: output.pending.length - pending.length }
				: {}),
			...(projectedCalls ? { calls: projectedCalls.calls } : {}),
			...(projectedCalls?.omitted
				? { callsOmitted: projectedCalls.omitted }
				: {}),
		};
	}
	const logs = output.logs
		?.slice(0, MAX_LOG_ENTRIES)
		.map((entry: string) => boundedRedactedText(entry, MAX_LOG_CHARS));

	return {
		...output,
		...(output.status === "completed"
			? {
					result: boundedRedactedValue(
						output.result,
						MAX_OUTPUT_RESULT_CHARS,
						true,
					),
				}
			: {}),
		...(output.status === "error"
			? { error: boundedRedactedText(output.error, MAX_LOG_CHARS) }
			: {}),
		...(logs ? { logs } : {}),
		...(projectedCalls ? { calls: projectedCalls.calls } : {}),
		...(projectedCalls?.omitted
			? { callsOmitted: projectedCalls.omitted }
			: {}),
	};
}

export function projectDurableCodemodeExecution(
	execution: ExecutionState,
): ProjectedExecutionState {
	const projectedLog = projectDurableCodemodeCalls(execution.log);
	const redactedCode = boundedRedactedText(execution.code, MAX_CODE_CHARS);
	return {
		...execution,
		code: redactedCode,
		...(redactedCode !== execution.code ? { codeTruncated: true } : {}),
		log: projectedLog.calls,
		...(projectedLog.omitted ? { logOmitted: projectedLog.omitted } : {}),
		...(execution.result === undefined
			? {}
			: { result: boundedRedactedValue(execution.result, MAX_RESULT_CHARS) }),
		...(execution.error
			? { error: boundedRedactedText(execution.error, MAX_LOG_CHARS) }
			: {}),
		...(execution.logs
			? {
					logs: execution.logs
						.slice(0, MAX_LOG_ENTRIES)
						.map((entry) => boundedRedactedText(entry, MAX_LOG_CHARS)),
					...(execution.logs.length > MAX_LOG_ENTRIES
						? { logsOmitted: execution.logs.length - MAX_LOG_ENTRIES }
						: {}),
				}
			: {}),
	};
}

/**
 * Ledger bracket for NATIVE tool calls — Computer/workstation (`exec`,
 * `read_execution`, `open_computer`, file tools), artifact, browser, object
 * store, cron, work and skill tools. These tools are plain AI SDK `execute`
 * closures, so nothing recorded them: only `tedix_mcp_*` calls reach
 * `TedixMcpRuntime.executeTool` (packages/mcp-client-core), which is the one
 * place that used to emit `tool.started` / `tool.completed` / `tool.failed`.
 * A supervisor reading a run therefore saw twenty `exec` calls only as
 * `artifact.created` rows and `step.completed` tool-name lists, never the
 * command that ran.
 *
 * Same event kinds, same ledger, same durable-first outbox. Payloads are
 * bounded and pass through the shared redaction (`redactValue`/`scrubText`),
 * and the completed row carries `resultPreview`, deliberately NOT `result`:
 * the kernel reconstructs a delegated child's answer from `tool.completed`
 * `data ?? result` (apps/api/src/rpc/routers/kernel/child-run-reads.ts), and a
 * shell transcript must never stand in for the child's answer.
 *
 * A row is keyed by the model's own tool-call id, never by a per-instance call
 * counter: the ledger drops a re-issued event id on conflict, so a counter that
 * restarts with its Durable Object silently loses every remaining call in the
 * run. `ledger-sequence.ts` records the turn that cost us.
 */

import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	redactValue,
	scrubText,
	TEDIX_REDACTED,
} from "@tedix/context-core/trace-safety";
import { LedgerSequence } from "./ledger-sequence";

export const NATIVE_TOOL_SURFACE = "native_tool";
const MAX_ARGUMENT_CHARS = 768;
const MAX_RESULT_PREVIEW_CHARS = 1_024;
/** Bound the id segment a provider-supplied call id contributes. */
const MAX_CALL_KEY_CHARS = 96;

export interface NativeToolLedgerContext {
	tediId: string;
	runId: string;
	conversationId: string;
}

/** One bracketed native tool call. The model's call id is its ledger identity. */
export interface NativeToolCall {
	name: string;
	/** Provider-generated tool-call id, unique for the lifetime of the run. */
	callId: string;
	args: unknown;
}

export type NativeToolIdentity = Pick<NativeToolCall, "name" | "callId">;

export class NativeToolHookCalls {
	private readonly pending = new Map<
		string,
		{ context: NativeToolLedgerContext; call: NativeToolIdentity }
	>();

	private key(runId: string, callId: string): string {
		return `${runId}\u0000${callId}`;
	}

	begin(context: NativeToolLedgerContext, call: NativeToolCall): void {
		this.pending.set(this.key(context.runId, call.callId), {
			context,
			call: { name: call.name, callId: call.callId },
		});
	}

	take(
		runId: string,
		callId: string,
	): { context: NativeToolLedgerContext; call: NativeToolIdentity } | null {
		const key = this.key(runId, callId);
		const call = this.pending.get(key) ?? null;
		this.pending.delete(key);
		return call;
	}

	clearRun(runId: string): void {
		for (const [key, call] of this.pending)
			if (call.context.runId === runId) this.pending.delete(key);
	}
}

/**
 * The id segment one call contributes. Bounded, and restricted to characters
 * that keep a composed event id readable. A caller with no call id at all falls
 * back to a fresh random key rather than to a counter a restart would reuse.
 */
export function nativeToolCallKey(callId: string): string {
	const cleaned = callId
		.replace(/[^A-Za-z0-9._:-]/g, "-")
		.slice(0, MAX_CALL_KEY_CHARS);
	return cleaned || `anon-${crypto.randomUUID()}`;
}

/** Tools whose ledger rows the MCP client core already writes in `executeTool`. */
export function isMcpRuntimeLedgeredTool(name: string): boolean {
	return name.startsWith("tedix_mcp_");
}

/** Bounded, redacted JSON projection. Always JSON-safe, never throws. */
export function boundedRedactedValue(
	value: unknown,
	maxChars: number,
): unknown {
	try {
		const redacted = redactValue(value);
		const serialized = JSON.stringify(redacted);
		if (serialized === undefined) return { unsupported: true };
		if (serialized.length <= maxChars) return JSON.parse(serialized) as unknown;
		return {
			truncated: true,
			originalChars: serialized.length,
			preview: scrubText(serialized.slice(0, maxChars)),
		};
	} catch {
		return { redactionFailed: true, value: TEDIX_REDACTED };
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const EXECUTION_FACTS_CHARS = 600;
const EXECUTION_FIELDS = [
	"ok",
	"executionId",
	"status",
	"outcome",
	"observation",
	"running",
	"terminal",
	"canceled",
	"timedOut",
	"requestTimedOut",
	"exitCode",
	"found",
	"error",
	"artifactWriteStatus",
	"artifactRowPersistence",
	"workstationEvidencePersistence",
	"artifactRefs",
	"artifactRef",
] as const;
const PERSISTENCE_FIELDS = new Set<string>([
	"artifactWriteStatus",
	"artifactRowPersistence",
	"workstationEvidencePersistence",
]);

/** Property access belongs inside the observer's failure boundary too. */
function executionValue(row: Record<string, unknown>, key: string): unknown {
	try {
		const json = JSON.stringify(redactValue(row[key]));
		return json === undefined ? { unsupported: true } : JSON.parse(json);
	} catch {
		return { redactionFailed: true };
	}
}

/** Equal serialized budgets prevent either stream from displacing the other. */
function executionStream(text: unknown, budget: number): unknown {
	if (typeof text !== "string")
		return record(text)?.redactionFailed === true
			? { redactionFailed: true }
			: { unsupported: true };
	if (text.length <= budget) {
		const full = { text, omittedChars: 0 };
		if (JSON.stringify(full).length <= budget) return full;
	}
	const excerpt = (kept: number) => ({
		head: text.slice(0, Math.ceil(kept / 2)),
		tail: kept > 1 ? text.slice(-Math.floor(kept / 2)) : "",
		omittedChars: text.length - kept,
	});
	let low = 0;
	let high = Math.min(text.length, budget);
	let result = excerpt(0);
	while (low <= high) {
		const kept = Math.floor((low + high) / 2);
		const candidate = excerpt(kept);
		if (JSON.stringify(candidate).length <= budget) {
			result = candidate;
			low = kept + 1;
		} else high = kept - 1;
	}
	return result;
}

/** Complete-value redaction, then bounded facts and independent stream space. */
export function nativeExecutionResultPreview(result: unknown): unknown {
	try {
		const row = record(result);
		if (!row) return { unsupported: true };
		const selected: Record<string, unknown> = {};
		for (const key of [...EXECUTION_FIELDS, "stdout", "stderr"])
			if (Object.prototype.hasOwnProperty.call(row, key))
				selected[key] = executionValue(row, key);

		const facts: Record<string, unknown> = {};
		const omitted = new Set<string>();
		// Reserve observed booleans/nulls and each actual persistence status
		// before spending remaining fact space on errors, identifiers or refs.
		for (const key of EXECUTION_FIELDS) {
			if (!(key in selected)) continue;
			const value = selected[key];
			if (
				value === null ||
				typeof value === "boolean" ||
				(key === "exitCode" && typeof value === "number")
			)
				facts[key] = value;
			else if (
				PERSISTENCE_FIELDS.has(key) &&
				record(value) &&
				Object.prototype.hasOwnProperty.call(value, "status") &&
				JSON.stringify(record(value)!.status).length <= 24
			)
				facts[key] = { status: record(value)!.status, incomplete: true };
			else omitted.add(key);
		}
		const withOmissions = () =>
			omitted.size
				? { ...facts, omittedFields: [...omitted], incomplete: true }
				: { ...facts };
		for (const key of EXECUTION_FIELDS) {
			if (!(key in selected)) continue;
			const previous = facts[key];
			const wasOmitted = omitted.delete(key);
			facts[key] = selected[key];
			if (JSON.stringify(withOmissions()).length > EXECUTION_FACTS_CHARS) {
				if (wasOmitted) {
					delete facts[key];
					omitted.add(key);
				} else facts[key] = previous;
			}
		}
		const preview: Record<string, unknown> = withOmissions();
		const streams = ["stdout", "stderr"].filter((key) => key in selected);
		for (const key of streams) preview[key] = null;
		if (streams.length) {
			// Subtract the actual key/comma/braces overhead; replace null's 4 chars.
			const budget = Math.floor(
				(MAX_RESULT_PREVIEW_CHARS -
					JSON.stringify(preview).length +
					streams.length * 4) /
					streams.length,
			);
			for (const key of streams)
				preview[key] = executionStream(selected[key], budget);
		}
		return preview;
	} catch {
		return { redactionFailed: true };
	}
}

function executionOutcome(
	result: unknown,
): Partial<ReturnType<typeof nativeToolOutcome>> {
	try {
		return nativeToolOutcome(result);
	} catch {
		return {};
	}
}

function producedArtifactIds(name: string, result: unknown): string[] {
	if (
		name !== "record_artifact" &&
		!["exec", "read_execution", "cancel_execution"].includes(name)
	)
		return [];
	const row = record(result);
	if (!row) return [];
	const ids = new Set<string>();
	if (
		name === "record_artifact" &&
		row.ok === true &&
		typeof row.artifactId === "string"
	)
		ids.add(row.artifactId);
	const job = record(row.job);
	const persistence = record(job?.artifactRowPersistence);
	if (
		persistence?.status === "persisted" &&
		Array.isArray(persistence.artifactIds)
	)
		for (const id of persistence.artifactIds)
			if (typeof id === "string" && id.length <= 500) ids.add(id);
	return [...ids].slice(0, 20);
}

/**
 * Structured outcome fields lifted beside the preview so a supervisor can
 * filter on them without parsing the preview: Computer executions return
 * `{ executionId, exitCode, running, canceled, timedOut }` (see
 * `ComputerEnvironmentController.result`).
 */
export function nativeToolOutcome(result: unknown): {
	ok: boolean;
	exitCode?: number;
	executionId?: string;
	running?: boolean;
	error?: string;
} {
	const row = record(result);
	if (!row) return { ok: true };
	const ok = !(row.ok === false || row.isError === true);
	return {
		ok,
		...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}),
		...(typeof row.executionId === "string"
			? { executionId: row.executionId }
			: {}),
		...(row.running === true ? { running: true } : {}),
		...(!ok && typeof row.error === "string"
			? { error: scrubText(row.error).slice(0, MAX_RESULT_PREVIEW_CHARS) }
			: {}),
	};
}

export class NativeToolLedger {
	private readonly sequence = new LedgerSequence();

	constructor(
		private readonly publish: (event: TediRuntimeEvent) => Promise<void>,
	) {}

	private async emit(
		context: NativeToolLedgerContext,
		kind: "tool.started" | "tool.completed" | "tool.failed",
		callKey: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const suffix = kind.slice("tool.".length);
		try {
			await this.publish({
				id: `${context.runId}:native-tool.${callKey}.${suffix}`,
				tediId: context.tediId,
				kind,
				conversationId: context.conversationId,
				runId: context.runId,
				sequence: this.sequence.next(),
				payload: { surface: NATIVE_TOOL_SURFACE, ...payload },
				// Same envelope as the MCP emitter: the trace joins through the
				// platform client's bound episode trace, not a per-event field.
				runtime: { backend: "cloudflare-agents" },
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			console.warn(
				`[native-tool-ledger] ${kind} publish failed (run=${context.runId} tool=${String(payload.name)}):`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	async started(
		context: NativeToolLedgerContext | null,
		call: NativeToolCall,
	): Promise<boolean> {
		if (!context || isMcpRuntimeLedgeredTool(call.name)) return false;
		await this.emit(context, "tool.started", nativeToolCallKey(call.callId), {
			name: call.name,
			arguments: boundedRedactedValue(call.args, MAX_ARGUMENT_CHARS),
		});
		return true;
	}

	async completed(
		context: NativeToolLedgerContext,
		call: NativeToolIdentity,
		result: unknown,
		latencyMs: number,
	): Promise<void> {
		const artifactIds = producedArtifactIds(call.name, result);
		const execution = ["exec", "read_execution", "cancel_execution"].includes(
			call.name,
		);
		await this.emit(context, "tool.completed", nativeToolCallKey(call.callId), {
			name: call.name,
			...(execution ? executionOutcome(result) : nativeToolOutcome(result)),
			latencyMs,
			...(artifactIds.length ? { producedArtifactIds: artifactIds } : {}),
			resultPreview: execution
				? nativeExecutionResultPreview(result)
				: boundedRedactedValue(result, MAX_RESULT_PREVIEW_CHARS),
		});
	}

	async failed(
		context: NativeToolLedgerContext,
		call: NativeToolIdentity,
		error: unknown,
		latencyMs: number,
	): Promise<void> {
		await this.emit(context, "tool.failed", nativeToolCallKey(call.callId), {
			name: call.name,
			error: scrubText(
				error instanceof Error ? error.message : String(error),
			).slice(0, MAX_RESULT_PREVIEW_CHARS),
			latencyMs,
		});
	}

	/**
	 * Bracket one native tool call. `tool.started` carries the tool name and
	 * bounded redacted arguments; `tool.completed` the outcome (`ok`, exit
	 * code, execution id), latency and a bounded result preview; a thrown
	 * error becomes `tool.failed` and is rethrown unchanged. A missing context
	 * (no turn identity) runs the tool without recording.
	 *
	 * `call.callId` is the model's own tool-call id: unique wherever the run
	 * executes, which is the point — it keys the row across a Durable Object
	 * restart that no in-memory counter survives.
	 */
	async observe<T>(
		context: NativeToolLedgerContext | null,
		call: NativeToolCall,
		run: () => Promise<T>,
	): Promise<T> {
		if (!context || isMcpRuntimeLedgeredTool(call.name)) return run();
		await this.started(context, call);
		const startedAt = Date.now();
		try {
			const result = await run();
			await this.completed(context, call, result, Date.now() - startedAt);
			return result;
		} catch (error) {
			await this.failed(context, call, error, Date.now() - startedAt);
			throw error;
		}
	}
}

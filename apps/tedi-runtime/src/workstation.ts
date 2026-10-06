import {
	type WorkstationBootstrapReadiness,
	type WorkstationCapability,
	WorkstationLeaseSchema,
	type WorkstationOperationLock,
	type WorkstationProfileId,
	WorkstationSchema,
	type WorkstationSeatRole,
	type WorkstationSessionKind,
} from "@tedix/api-contract/schemas/workstation";
import { compactWorkstationStatusReceipt } from "./workstation-status-receipt";

const WORKSTATION_HEADER = "X-Tedix-Workstation";
const WORKSTATION_CONVERSATION_HEADER = "X-Tedix-Workstation-Conversation-Id";
const WORKSTATION_RUN_HEADER = "X-Tedix-Workstation-Run-Id";
const DEFAULT_WAKE_TIMEOUT_MS = 240_000;
// open_computer persists a provisioning receipt before the Agent runtime
// starts the cold wake in a durable fiber. This timeout only bounds that quick
// receipt; the Computer controller checks readiness before dispatch.
const DEFAULT_REQUEST_WORKSTATION_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_REQUEST_TIMEOUT_MS = 120_000;
// Per-field tail budgets for sync exec output shown to the model. The only
// other limiter on this path is the generic 24,000-char HEAD truncation of the
// whole serialized tool result (`do.ts`/`llm.ts` `stringifyToolResult`), which
// drops the *tail* — exactly where compiler errors and test failures live —
// and can cut mid-JSON. Budgeting 10k stdout + 6k stderr keeps the combined
// exec payload (~16k of text plus a ~1-2k structural envelope and truncation
// markers) comfortably under that 24k backstop with ~25% headroom for the
// JSON-string escaping of typical shell output, so the backstop never fires on
// exec results and the tail always survives. The backstop remains the final
// guard for pathological escape-heavy output.
const EXEC_STDOUT_TAIL_BUDGET = 10_000;
const EXEC_STDERR_TAIL_BUDGET = 6_000;

export type WorkstationToolInput = {
	attemptId?: string;
	preparation?: "shell" | "repository";
	executionId?: string;
	kernelRunId?: string;
	reason?: string;
	setupPlan?: unknown[];
	workItemId?: string;
};

export type WorkstationSessionInput = {
	participantId?: string;
	sessionId?: string;
	sessionKind?: WorkstationSessionKind;
};

export type WorkstationLeaseSelectionInput = {
	leaseId?: string;
	workstationId?: string;
};

export type WorkstationExecInput = {
	command: string;
	cwd?: string;
	kernelRunId?: string;
	operationLock?: WorkstationOperationLock;
	profileId?: WorkstationProfileId;
	timeoutMs?: number;
	traceBundleId?: string;
	traceId?: string;
	workItemId?: string;
} & WorkstationLeaseSelectionInput &
	WorkstationSessionInput;

export type WorkstationProcessStartInput = {
	command: string;
	cwd?: string;
	kind?:
		| "dependency_install"
		| "typecheck"
		| "tests"
		| "lint"
		| "build"
		| "deploy"
		| "notebook"
		| "data"
		| "command";
	kernelRunId?: string;
	operationLock?: WorkstationOperationLock;
	processId?: string;
	profileId?: WorkstationProfileId;
	timeoutMs?: number;
	traceBundleId?: string;
	traceId?: string;
	workItemId?: string;
} & WorkstationLeaseSelectionInput &
	WorkstationSessionInput;

export type WorkstationProcessStatusInput = {
	kernelRunId?: string;
	leaseId?: string;
	participantId?: string;
	profileId?: WorkstationProfileId;
	processId: string;
	sessionId?: string;
	sessionKind?: WorkstationSessionKind;
	tailBytes?: number;
	traceBundleId?: string;
	traceId?: string;
	workItemId?: string;
	workstationId?: string;
};

export type WorkstationProcessWaitInput = WorkstationProcessStatusInput & {
	timeoutMs: number;
};

export type WorkstationProcessCancelInput = {
	kernelRunId?: string;
	leaseId?: string;
	participantId?: string;
	profileId?: WorkstationProfileId;
	processId: string;
	sessionId?: string;
	sessionKind?: WorkstationSessionKind;
	traceBundleId?: string;
	traceId?: string;
	workItemId?: string;
	workstationId?: string;
};

export type WorkstationIdentity = {
	orgId?: string | null;
	slug: string;
	tediId: string;
};

export type WorkstationRequestSeatInput = {
	permissionScopes?: string[];
	role?: WorkstationSeatRole;
	slug?: string;
	tediId: string;
};

export type WorkstationRequestInput = {
	attemptId?: string;
	preparation?: "shell" | "repository";
	environmentPolicy?: Record<string, unknown>;
	executionId?: string;
	kernelRunId?: string;
	objective?: string;
	persistencePolicy?: Record<string, unknown>;
	profileId?: WorkstationProfileId;
	reason?: string;
	requiredCapabilities?: WorkstationCapability[];
	seats?: WorkstationRequestSeatInput[];
	setupPlan?: unknown[];
	timeoutMs?: number;
	traceBundleId?: string;
	workItemId?: string;
};

export type WorkstationReleaseInput = {
	cwd?: string;
	preserveChanges?: boolean;
	leaseId: string;
	reason?: string;
	traceId?: string;
	workstationId?: string;
};

export type WorkstationStatusInput = {
	/** Internal durable-provisioning phase; not exposed by the MCP tool schema. */
	cacheBackupMode?: "synchronous";
	kernelRunId?: string;
	leaseId: string;
	traceBundleId?: string;
	traceId?: string;
	workItemId?: string;
	workstationId?: string;
};

export type WorkstationEnv = {
	ENVIRONMENT?: string;
	TEDI_SERVICE?: Fetcher;
};

export function platformDomainForTediEnv(environment?: string): string {
	if (environment === "production") return "tedix.dev";
	return "tedix.tech";
}

export function tediHostForSlug(slug: string, environment?: string): string {
	return `${slug}.tedi.${platformDomainForTediEnv(environment)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function wakeTimeoutPayload(error: string): Record<string, unknown> {
	const bootstrap: WorkstationBootstrapReadiness = {
		toolsReady: false,
		secretsReady: false,
		repoReady: false,
		depsReady: false,
		environmentReady: false,
		installStatus: "blocked",
		installProcessId: "bootstrap-install",
		lockfileHash: null,
		packageManager: null,
		cacheKey: null,
		cacheRestoredAt: null,
		cacheBackupRef: null,
		cacheBackupStatus: "skipped",
		cacheBackupError: null,
		lastInstallExitCode: null,
		lastInstallArtifactRef: null,
		lastBootstrapError: error,
		nextAction: "open_computer",
		nextCommand: null,
		dimensions: {
			toolsReady: false,
			secretsReady: false,
			repoReady: false,
			depsReady: false,
		},
	};
	return {
		ok: false,
		ready: false,
		error,
		setupError: error,
		bootstrap,
		readiness: bootstrap.dimensions,
	};
}

function resolveWorkstationProfileId(input: {
	profileId?: WorkstationProfileId;
}): WorkstationProfileId {
	if (input.profileId) return input.profileId;
	return "general";
}

/** Classify the existing edge denial templates without retaining identifiers,
 * response bodies, or arbitrary upstream error text in the Code Mode result. */
function workstationFilesDenial(payload: unknown): string {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return "forbidden_unknown";
	const error = (payload as Record<string, unknown>).error;
	if (
		typeof error !== "string" ||
		error.length > 512 ||
		/[\u0000-\u001f\u007f]/.test(error)
	)
		return "forbidden_unknown";
	const templates: Array<[RegExp, string]> = [
		[
			/^workstation lease \S{1,128} is not in this organization$/,
			"org_mismatch",
		],
		[
			/^workstationId \S{1,128} does not match lease \S{1,128}$/,
			"workstation_mismatch",
		],
		[
			/^workstation lease \S{1,128} has no participant for tedi \S{1,128}$/,
			"participant_missing",
		],
		[
			/^workstation lease \S{1,128} has no selectable participant$/,
			"participant_missing",
		],
		[
			/^workstation participant \S{1,128} is not active$/,
			"participant_inactive",
		],
		[
			/^workstation participant \S{1,128} does not belong to lease \S{1,128}$/,
			"participant_lease_mismatch",
		],
		[
			/^workstation participant \S{1,128} does not belong to tedi \S{1,128}$/,
			"participant_tedi_mismatch",
		],
		[
			/^workstation session \S{1,128} belongs to participant \S{1,128}$/,
			"session_owner_mismatch",
		],
	];
	return (
		templates.find(([pattern]) => pattern.test(error))?.[1] ??
		"forbidden_unknown"
	);
}

async function callWorkstation(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	path:
		| "dev-server"
		| "exec"
		| "files"
		| "join"
		| "process/cancel"
		| "process/start"
		| "process/status"
		| "process/wait"
		| "provision"
		| "release"
		| "status"
		| "wake",
	input: Record<string, unknown> = {},
	options: {
		conversationProvenance?: { conversationId: string; runId: string } | null;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<unknown> {
	if (!env.TEDI_SERVICE) {
		return {
			ok: false,
			error: "TEDI_SERVICE binding is not configured",
		};
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
	// Compose the caller's cancellation signal (e.g. an MCP `extra.signal`)
	// with the internal timeout so an aborted caller stops the outbound fetch
	// immediately instead of leaving the sandbox call running unattended.
	const signal = options.signal
		? AbortSignal.any([timeoutController.signal, options.signal])
		: timeoutController.signal;
	const traceId =
		typeof input.traceId === "string" && input.traceId.trim()
			? input.traceId.trim()
			: null;
	try {
		const response = await env.TEDI_SERVICE.fetch(
			new Request(`https://tedi/api/admin/workstation/${path}`, {
				body: JSON.stringify({
					...input,
				}),
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
					"X-Tedix-Host": tediHostForSlug(identity.slug, env.ENVIRONMENT),
					"X-Tedix-Org-Id": identity.orgId ?? "",
					"X-Tedix-Tedi-Id": identity.tediId,
					...(traceId ? { "X-Trace-Id": traceId } : {}),
					[WORKSTATION_HEADER]: "true",
					...(path === "process/start" && options.conversationProvenance
						? {
								[WORKSTATION_CONVERSATION_HEADER]:
									options.conversationProvenance.conversationId,
								[WORKSTATION_RUN_HEADER]: options.conversationProvenance.runId,
							}
						: {}),
				},
				method: "POST",
				signal,
			}),
		);
		const text = await response.text();
		let payload: unknown = text;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			// Keep the raw body; upstream errors are often plain text.
		}
		if (!response.ok) {
			if (path === "files" && response.status === 403) {
				return {
					ok: false,
					status: response.status,
					error: `workstation_files_denied:${workstationFilesDenial(payload)} (HTTP 403)`,
				};
			}
			return {
				ok: false,
				status: response.status,
				error: response.statusText || "workstation request failed",
				body: payload,
			};
		}
		return payload;
	} catch (err) {
		const aborted = isAbortError(err);
		const cancelled = aborted && options.signal?.aborted === true;
		const error = cancelled
			? `workstation ${path} cancelled by caller`
			: aborted
				? `workstation ${path} timed out after ${timeoutMs}ms`
				: err instanceof Error
					? err.message
					: String(err);
		if ((path === "wake" || path === "provision") && aborted && !cancelled)
			return wakeTimeoutPayload(error);
		// A request timeout stops THIS caller waiting; it never reaches the
		// workstation, so a dispatched process keeps running there. Report it
		// structurally so process callers can hand back a polling receipt
		// instead of a failure the model reads as a killed command.
		return {
			ok: false,
			error,
			...(aborted && !cancelled
				? { requestTimedOut: true, waitedMs: timeoutMs }
				: {}),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function requestWorkstationAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationToolInput = {},
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(
		env,
		identity,
		"provision",
		{
			attemptId: input.attemptId,
			executionId: input.executionId,
			preparation: input.preparation,
			kernelRunId: input.kernelRunId,
			reason: input.reason || "isolate-requested workstation",
			setupPlan: input.setupPlan,
			workItemId: input.workItemId,
		},
		options,
	);
}

export async function readWorkstationStatusAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationStatusInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "status", input, {
		timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_REQUEST_TIMEOUT_MS,
	});
}

export async function reconcileWorkstation(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationStatusInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "wake", input, {
		timeoutMs: options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS,
	});
}

export async function execWorkstationAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationExecInput,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "exec", input, {
		timeoutMs:
			options.timeoutMs ??
			Math.max(input.timeoutMs ?? 0, DEFAULT_EXEC_REQUEST_TIMEOUT_MS),
		signal: options.signal,
	});
}

export async function releaseWorkstationAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationReleaseInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "release", input, {
		timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_REQUEST_TIMEOUT_MS,
	});
}

export async function startWorkstationProcessAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessStartInput,
	options: {
		conversationProvenance?: { conversationId: string; runId: string } | null;
		timeoutMs?: number;
	} = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "process/start", input, {
		conversationProvenance: options.conversationProvenance,
		timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_REQUEST_TIMEOUT_MS,
	});
}

export async function readWorkstationProcessAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessStatusInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "process/status", input, {
		timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_REQUEST_TIMEOUT_MS,
	});
}

export async function waitWorkstationProcessAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessWaitInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "process/wait", input, {
		timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_REQUEST_TIMEOUT_MS,
	});
}

export async function cancelWorkstationProcessAdapter(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessCancelInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	return callWorkstation(env, identity, "process/cancel", input, {
		timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_REQUEST_TIMEOUT_MS,
	});
}

export async function requestWorkstation(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationRequestInput = {},
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	const payload = await requestWorkstationAdapter(
		env,
		identity,
		{
			attemptId: input.attemptId,
			executionId: input.executionId,
			preparation: input.preparation,
			kernelRunId: input.kernelRunId,
			reason:
				input.reason || input.objective || "isolate-requested workstation",
			setupPlan: input.setupPlan,
			workItemId: input.workItemId,
		},
		{
			timeoutMs:
				options.timeoutMs ??
				input.timeoutMs ??
				DEFAULT_REQUEST_WORKSTATION_TIMEOUT_MS,
		},
	);
	const record = asRecord(payload);
	// A failed transport or persistence response is evidence, not an acquisition.
	if (record.ok === false) return payload;
	const workstation = WorkstationSchema.safeParse(record.workstation);
	const lease = WorkstationLeaseSchema.safeParse(record.workstationLease);
	if (
		record.ok !== true ||
		record.accepted !== true ||
		asRecord(record.workstationPersistence).status !== "persisted" ||
		!workstation.success ||
		!lease.success ||
		!workstation.data.id.trim() ||
		!lease.data.id.trim() ||
		lease.data.workstationId !== workstation.data.id ||
		lease.data.profileId !== workstation.data.profileId ||
		lease.data.organizationId !== workstation.data.organizationId ||
		lease.data.organizationId !== (identity.orgId ?? null) ||
		(input.workItemId !== undefined &&
			lease.data.workItemId !== input.workItemId) ||
		(input.kernelRunId !== undefined &&
			lease.data.kernelRunId !== input.kernelRunId) ||
		(input.executionId !== undefined &&
			lease.data.metadata.executionId !== input.executionId) ||
		!workstation.data.seats.some(
			(seat) => seat.role === "lead" && seat.tediId === identity.tediId,
		) ||
		!lease.data.participants.some(
			(participant) =>
				participant.tediId === identity.tediId &&
				participant.role === "lead" &&
				participant.status === "active" &&
				participant.leftAt === null &&
				participant.leaseId === lease.data.id &&
				participant.organizationId === lease.data.organizationId,
		) ||
		(record.leaseId !== undefined && record.leaseId !== lease.data.id) ||
		(record.workstationId !== undefined &&
			record.workstationId !== workstation.data.id)
	)
		return {
			ok: false,
			accepted: false,
			error:
				"Workstation provision response did not confirm a canonical persisted lease; outcome is unknown. Do not reprovision.",
			body: payload,
		};
	// Preserve server-issued participants, sessions, status and diagnostics. Local
	// request fields cannot manufacture a lease or grant additional seats.
	return {
		...record,
		leaseId: lease.data.id,
		profileId: lease.data.profileId,
		workstationId: workstation.data.id,
	};
}

export async function readWorkstationStatus(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationStatusInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	const payload = await readWorkstationStatusAdapter(
		env,
		identity,
		input,
		options,
	);
	const record = asRecord(payload);
	const workstation = asRecord(record.workstation);
	const lease = asRecord(record.workstationLease);
	return {
		...compactWorkstationStatusReceipt(record),
		leaseId: typeof lease.id === "string" ? lease.id : input.leaseId,
		workstationId:
			typeof workstation.id === "string" ? workstation.id : input.workstationId,
	};
}

/**
 * Keep the LAST `budget` chars of an exec stream — the tail is where compiler
 * errors, failing assertions, and stack traces live. Prefers whole lines:
 * the leading partial line of the slice is dropped when a line boundary
 * exists, and kept as-is for single-line blobs (e.g. minified JSON) where
 * trimming at `\n` would discard everything. Truncated fields are prefixed
 * with a marker that reports what was kept and how to get the full logs.
 */
function tailTruncateExecText(text: string, budget: number): string {
	if (text.length <= budget) return text;
	let tail = text.slice(text.length - budget);
	const firstNewline = tail.indexOf("\n");
	if (firstNewline !== -1 && firstNewline + 1 < tail.length)
		tail = tail.slice(firstNewline + 1);
	return `[Truncated: showing last ${tail.length} of ${text.length} chars — use the durable workstation job receipt for full logs]\n${tail}`;
}

/**
 * Make a sync exec payload ergonomic for the model: tail-truncate stdout and
 * stderr within their per-field budgets and append text annotations
 * (`[Exit code: N]` on nonzero exit, `[no output]` when both streams are
 * empty). Only the `stdout`/`stderr` text fields change — structured fields
 * (`ok`, `exitCode`, ids) stay untouched for programmatic consumers, and
 * short output passes through byte-identical. Payloads without both stream
 * fields (transport errors, timeouts — which already report their duration
 * via `callWorkstation`) are returned unchanged.
 */
function annotateExecResultForModel(
	record: Record<string, unknown>,
): Record<string, unknown> {
	if (typeof record.stdout !== "string" || typeof record.stderr !== "string")
		return record;
	const annotations: string[] = [];
	if (record.stdout === "" && record.stderr === "")
		annotations.push("[no output]");
	if (typeof record.exitCode === "number" && record.exitCode !== 0)
		annotations.push(`[Exit code: ${record.exitCode}]`);
	const stdout = [
		tailTruncateExecText(record.stdout, EXEC_STDOUT_TAIL_BUDGET),
		...annotations,
	]
		.filter((part) => part !== "")
		.join("\n");
	const stderr = tailTruncateExecText(record.stderr, EXEC_STDERR_TAIL_BUDGET);
	return { ...record, stderr, stdout };
}

export async function execWorkstation(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationExecInput,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
	const profileId = resolveWorkstationProfileId(input);
	const payload = await execWorkstationAdapter(
		env,
		identity,
		{
			command: input.command,
			cwd: input.cwd,
			kernelRunId: input.kernelRunId,
			leaseId: input.leaseId,
			operationLock: input.operationLock,
			participantId: input.participantId,
			sessionId: input.sessionId,
			sessionKind: input.sessionKind,
			timeoutMs: input.timeoutMs,
			traceBundleId: input.traceBundleId,
			traceId: input.traceId,
			workItemId: input.workItemId,
			workstationId: input.workstationId,
		},
		options,
	);
	const record = asRecord(payload);
	return {
		...annotateExecResultForModel(record),
		profileId,
	};
}

export async function startWorkstationProcess(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessStartInput,
	options: {
		conversationProvenance?: { conversationId: string; runId: string } | null;
		timeoutMs?: number;
	} = {},
): Promise<unknown> {
	const profileId = resolveWorkstationProfileId(input);
	const payload = await startWorkstationProcessAdapter(
		env,
		identity,
		{
			command: input.command,
			cwd: input.cwd,
			kind: input.kind,
			kernelRunId: input.kernelRunId,
			leaseId: input.leaseId,
			operationLock: input.operationLock,
			participantId: input.participantId,
			processId: input.processId,
			sessionId: input.sessionId,
			sessionKind: input.sessionKind,
			timeoutMs: input.timeoutMs,
			traceBundleId: input.traceBundleId,
			traceId: input.traceId,
			workItemId: input.workItemId,
			workstationId: input.workstationId,
		},
		options,
	);
	const record = asRecord(payload);
	return {
		...record,
		profileId,
	};
}

export async function readWorkstationProcess(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessStatusInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	const profileId = resolveWorkstationProfileId(input);
	const payload = await readWorkstationProcessAdapter(
		env,
		identity,
		{
			kernelRunId: input.kernelRunId,
			leaseId: input.leaseId,
			participantId: input.participantId,
			processId: input.processId,
			sessionId: input.sessionId,
			sessionKind: input.sessionKind,
			tailBytes: input.tailBytes,
			traceBundleId: input.traceBundleId,
			traceId: input.traceId,
			workItemId: input.workItemId,
			workstationId: input.workstationId,
		},
		options,
	);
	const record = asRecord(payload);
	return {
		...record,
		profileId,
	};
}

export async function waitWorkstationProcess(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessWaitInput,
): Promise<unknown> {
	const profileId = resolveWorkstationProfileId(input);
	const payload = await waitWorkstationProcessAdapter(env, identity, input, {
		timeoutMs: input.timeoutMs + 5_000,
	});
	return { ...asRecord(payload), profileId };
}

export async function cancelWorkstationProcess(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationProcessCancelInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	const profileId = resolveWorkstationProfileId(input);
	const payload = await cancelWorkstationProcessAdapter(
		env,
		identity,
		{
			kernelRunId: input.kernelRunId,
			leaseId: input.leaseId,
			participantId: input.participantId,
			processId: input.processId,
			sessionId: input.sessionId,
			sessionKind: input.sessionKind,
			traceBundleId: input.traceBundleId,
			traceId: input.traceId,
			workItemId: input.workItemId,
			workstationId: input.workstationId,
		},
		options,
	);
	const record = asRecord(payload);
	return {
		...record,
		profileId,
	};
}

export async function releaseWorkstation(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: WorkstationReleaseInput,
	options: { timeoutMs?: number } = {},
): Promise<unknown> {
	const leaseId = typeof input.leaseId === "string" ? input.leaseId.trim() : "";
	if (!leaseId) return { ok: false, error: "leaseId is required" };
	return releaseWorkstationAdapter(
		env,
		identity,
		{
			leaseId,
			cwd: input.cwd,
			preserveChanges: input.preserveChanges,
			reason: input.reason,
			traceId: input.traceId,
			workstationId: input.workstationId,
		},
		options,
	);
}

export async function operateComputerFiles(
	env: WorkstationEnv,
	identity: WorkstationIdentity,
	input: Record<string, unknown>,
): Promise<unknown> {
	return callWorkstation(env, identity, "files", input);
}

import {
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubText } from "../src/trace-safety";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
	LEDGER_QUALIFICATION_GRADING_VERSION,
	type LedgerEvaluationSurface,
	type LedgerEvaluationPromptVariant,
} from "../src/ledger-model-evaluation";

type ModelRef =
	| "azure-openai/gpt-6-astra"
	| "azure-openai/gpt-6.1-sol"
	| "azure-openai/gpt-6-luna";
interface Job {
	surface: LedgerEvaluationSurface;
	caseId: string;
	promptVariant: LedgerEvaluationPromptVariant;
	modelRef: ModelRef;
	repetition: number;
}
interface Input extends Omit<Job, "repetition"> {
	evaluationId: string;
}
interface ManagedResult {
	systemHash: string;
	inputHash: string;
	status: string;
	output: string | null;
	[key: string]: unknown;
}
export interface CliFailureEvidence {
	kind: "authorization" | "approval" | "indeterminate";
	exitCode: number | null;
	signal: string | null;
	killed: boolean | null;
	configuredTimeoutMs: number;
	elapsedMs: number | null;
	timedOut: boolean | null;
	errorCode: string | null;
	approvalId: string | null;
	traceId: string | null;
	stderr: string;
	stdout: string;
}
function cliFailureEvidence(
	error: unknown,
	payload?: unknown,
): CliFailureEvidence {
	const record = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const source = record(error);
	const text = (value: unknown) =>
		typeof value === "string"
			? scrubText(value.slice(0, 65_536)).slice(0, 2000)
			: "";
	const stderr = text(source.stderr);
	const stdout = text(source.stdout);
	let parsed = payload;
	if (!parsed)
		for (const raw of [source.stderr, source.stdout]) {
			if (typeof raw !== "string" || raw.length > 65_536) continue;
			try {
				parsed = JSON.parse(raw);
				break;
			} catch {
				/* Retain bounded redacted text when CLI output is not JSON. */
			}
		}
	const root = record(parsed);
	const records = [
		record(root.error),
		record(record(root.json).error),
		record(root.json),
		root,
	];
	const scalar = (value: unknown) =>
		typeof value === "string" &&
		/^[A-Za-z0-9_.:-]{1,128}$/.test(value) &&
		scrubText(value) === value
			? value
			: null;
	const field = (name: string) =>
		records.map((row) => scalar(row[name])).find(Boolean) ?? null;
	const parsedCode = field("code");
	const errorCode =
		parsedCode ??
		scalar(source.code) ??
		stderr.match(/^(?:Error:\s*)?(UNAUTHORIZED|FORBIDDEN)\b/m)?.[1] ??
		null;
	const httpStatus =
		records
			.map((row) => row.statusCode ?? row.status)
			.find((value) => value === 401 || value === 403) ??
		stderr.match(/^(?:Error:\s*)?HTTP (401|403)\b/m)?.[1];
	const approvalId = field("approvalId");
	const approval =
		!!approvalId ||
		records.some((row) =>
			["requires_approval", "approval_required", "input_required"].includes(
				String(row.status),
			),
		);
	return {
		kind:
			["UNAUTHORIZED", "FORBIDDEN"].includes(errorCode ?? "") ||
			httpStatus !== undefined
				? "authorization"
				: approval
					? "approval"
					: "indeterminate",
		exitCode: typeof source.code === "number" ? source.code : null,
		signal: scalar(source.signal),
		killed: typeof source.killed === "boolean" ? source.killed : null,
		configuredTimeoutMs: 35_000,
		elapsedMs:
			typeof source.cliElapsedMs === "number" &&
			Number.isFinite(source.cliElapsedMs)
				? source.cliElapsedMs
				: null,
		timedOut: errorCode === "ETIMEDOUT" ? true : null,
		errorCode,
		approvalId,
		traceId: field("traceId") ?? field("trace_id"),
		stderr,
		stdout,
	};
}
class ManagedEvaluationDenied extends Error {
	constructor(
		message: string,
		readonly evidence?: CliFailureEvidence,
	) {
		super(message);
	}
}
class ManagedEvaluationInterrupted extends Error {
	constructor(
		message: string,
		readonly evidence: CliFailureEvidence,
	) {
		super(message);
	}
}
function cliFailure(error: unknown, payload?: unknown): Error {
	const evidence = cliFailureEvidence(error, payload);
	return evidence.kind === "indeterminate"
		? new ManagedEvaluationInterrupted(
				"Tedix CLI evaluation did not complete; inspect retained failure evidence before continuing",
				evidence,
			)
		: new ManagedEvaluationDenied(
				"Tedix evaluation requires authorization or approval before continuing",
				evidence,
			);
}
function validateIdentity(
	response: ManagedResult,
	job: Job,
	evaluationId: string,
) {
	for (const key of ["surface", "caseId", "promptVariant", "modelRef"] as const)
		if (response[key] !== job[key])
			throw new Error("Managed evaluation identity mismatch");
	if (response.evaluationId !== evaluationId)
		throw new Error("Managed evaluation identity mismatch");
}
export function parseManagedEvaluationEnvelope(body: {
	json?: ManagedResult;
	code?: string;
}): ManagedResult {
	if (
		[body.code, body.json?.code].some(
			(code) => code === "UNAUTHORIZED" || code === "FORBIDDEN",
		) ||
		(body.json && /HTTP (401|403)\b/.test(String(body.json.error)))
	)
		throw new ManagedEvaluationDenied(
			"Managed evaluation authorization denied",
			{ ...cliFailureEvidence(null, body), kind: "authorization" },
		);
	if (!body.json || typeof body.json.status !== "string")
		throw new Error(
			"Managed evaluation refused or returned an invalid RPC envelope",
		);
	return body.json;
}
interface RecordResult {
	job: Job;
	evaluationId: string;
	state: "started" | "completed";
	systemHash: string;
	inputHash: string;
	response?: ManagedResult;
	grade?: ReturnType<
		NonNullable<ReturnType<typeof getLedgerEvaluationCase>>["grade"]
	>;
	gradingVersion?: number;
	gradeHistory?: Array<{
		gradingVersion: number | null;
		grade: RecordResult["grade"] | null;
		replacedAt: string;
	}>;
	error?: string;
	denied?: boolean;
	interrupted?: boolean;
	cliFailure?: CliFailureEvidence;
}
export type EvaluationCaller = (input: Input) => Promise<ManagedResult>;
export interface ReviewedLedgerContinuation {
	schemaVersion: 1;
	decision: "continue_unrelated_no_replay";
	failedReceipt: { file: string; sha256: string; evaluationId: string };
	preflight: {
		workspace: "connect";
		organization: string;
		callable: string;
		endpoint: "workAgentSessions/evaluateLedgerModel";
		toolName: string;
		transport: "mcp_tools_call";
		responseSha256: string;
		responseFile: string;
		observedAt: string;
		code: "BAD_REQUEST";
		message: "Unknown evaluation case or prompt variant";
		executionId: string | null;
		traceId: string | null;
	};
}
const LEGACY_INDETERMINATE_CLI_ERROR =
	"Tedix CLI evaluation did not complete; inspect the normal authorization, approval or transport result before continuing";
async function validateContinuation(
	directory: string,
	review: ReviewedLedgerContinuation,
	organization?: string,
	callable?: string,
	toolName?: string,
): Promise<RecordResult> {
	const exact = (value: unknown, keys: string[]) =>
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());
	const uuid = (value: unknown) =>
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		);
	if (
		!exact(review, [
			"schemaVersion",
			"decision",
			"failedReceipt",
			"preflight",
		]) ||
		!exact(review.failedReceipt, ["file", "sha256", "evaluationId"]) ||
		!exact(review.preflight, [
			"workspace",
			"organization",
			"callable",
			"endpoint",
			"toolName",
			"transport",
			"responseSha256",
			"responseFile",
			"observedAt",
			"code",
			"message",
			"executionId",
			"traceId",
		]) ||
		review.schemaVersion !== 1 ||
		review.decision !== "continue_unrelated_no_replay" ||
		!organization ||
		!callable ||
		!toolName ||
		review.preflight.endpoint !== "workAgentSessions/evaluateLedgerModel" ||
		review.preflight.toolName !== toolName ||
		review.preflight.transport !== "mcp_tools_call" ||
		!/^[a-f0-9]{64}$/.test(review.preflight.responseSha256) ||
		typeof review.preflight.responseFile !== "string" ||
		!isAbsolute(review.preflight.responseFile) ||
		review.preflight.organization !== organization ||
		review.preflight.callable !== callable ||
		review.preflight.workspace !== "connect" ||
		review.preflight.code !== "BAD_REQUEST" ||
		review.preflight.message !== "Unknown evaluation case or prompt variant" ||
		!Number.isFinite(Date.parse(review.preflight.observedAt)) ||
		(review.preflight.executionId !== null &&
			!uuid(review.preflight.executionId)) ||
		(review.preflight.traceId !== null && !uuid(review.preflight.traceId)) ||
		!uuid(review.failedReceipt.evaluationId) ||
		!/^[a-f0-9]{64}\.json$/.test(review.failedReceipt.file) ||
		!/^[a-f0-9]{64}$/.test(review.failedReceipt.sha256)
	)
		throw new Error(
			"Invalid reviewed continuation or same-actor preflight binding",
		);
	const preflightBytes = await readFile(review.preflight.responseFile);
	if (
		createHash("sha256").update(preflightBytes).digest("hex") !==
		review.preflight.responseSha256
	)
		throw new Error("Reviewed native preflight response hash mismatch");
	const preflightResult = JSON.parse(preflightBytes.toString("utf8")) as Record<
		string,
		unknown
	>;
	const preflightMeta = preflightResult?._meta as
		| Record<string, unknown>
		| undefined;
	const preflightError = preflightResult?.structuredContent as
		| Record<string, unknown>
		| undefined;
	const transportError = preflightMeta?.["tedix/error"] as
		| Record<string, unknown>
		| undefined;
	if (
		!preflightResult ||
		preflightResult.isError !== true ||
		preflightError?.code !== "BAD_REQUEST" ||
		preflightError.message !== review.preflight.message ||
		transportError?.code !== "BAD_REQUEST" ||
		transportError.status !== 400 ||
		cliFailureEvidence(null, preflightError).kind !== "indeterminate" ||
		(preflightError.executionId ?? null) !== review.preflight.executionId ||
		(preflightMeta?.["com.tedix/traceId"] ?? preflightError.traceId ?? null) !==
			review.preflight.traceId
	)
		throw new Error(
			"Reviewed native preflight does not prove the fixed-case validation error",
		);
	const bytes = await readFile(
		join(directory, review.failedReceipt.file),
		"utf8",
	);
	if (
		createHash("sha256").update(bytes).digest("hex") !==
		review.failedReceipt.sha256
	)
		throw new Error("Reviewed failed receipt hash mismatch");
	const failed = JSON.parse(bytes) as RecordResult;
	if (
		failed.evaluationId !== review.failedReceipt.evaluationId ||
		failed.state !== "completed" ||
		failed.grade?.passed !== false ||
		!(
			(failed.interrupted && failed.cliFailure?.kind === "indeterminate") ||
			(failed.denied &&
				!failed.cliFailure &&
				failed.error === LEGACY_INDETERMINATE_CLI_ERROR)
		)
	)
		throw new Error(
			"Only an indeterminate failed receipt can receive reviewed continuation",
		);
	if (
		failed.cliFailure?.approvalId ||
		["FORBIDDEN", "UNAUTHORIZED"].includes(failed.cliFailure?.errorCode ?? "")
	)
		throw new Error("Authorization and approval failures remain blocked");
	const fixture = getLedgerEvaluationCase(
		failed.job.surface,
		failed.job.caseId,
		failed.job.promptVariant,
	);
	if (!fixture || !MODELS.includes(failed.job.modelRef))
		throw new Error("Invalid reviewed failed job");
	const hashes = await hashLedgerEvaluationCase(fixture);
	const key = createHash("sha256")
		.update(JSON.stringify({ job: failed.job, ...hashes }))
		.digest("hex");
	if (
		`${key}.json` !== review.failedReceipt.file ||
		failed.systemHash !== hashes.systemHash ||
		failed.inputHash !== hashes.inputHash
	)
		throw new Error("Reviewed failed job identity mismatch");
	if (failed.response) {
		validateIdentity(failed.response, failed.job, failed.evaluationId);
		if (
			failed.response.systemHash !== hashes.systemHash ||
			failed.response.inputHash !== hashes.inputHash ||
			cliFailureEvidence(null, failed.response).kind !== "indeterminate" ||
			/HTTP (401|403)\b/.test(String(failed.response.error))
		)
			throw new Error(
				"Reviewed response identity or authorization remains blocked",
			);
	}
	for (const file of await readdir(directory)) {
		if (
			!/^[a-f0-9]{64}\.json$/.test(file) ||
			file === review.failedReceipt.file
		)
			continue;
		const other = JSON.parse(
			await readFile(join(directory, file), "utf8"),
		) as RecordResult;
		await validateStoredReceipt(other, file);
		if (other.denied || other.interrupted || other.state !== "completed")
			throw new Error(
				"Another denied, indeterminate or unsettled receipt remains blocked",
			);
	}
	return failed;
}
const MODELS: ModelRef[] = [
	"azure-openai/gpt-6-astra",
	"azure-openai/gpt-6.1-sol",
	"azure-openai/gpt-6-luna",
];
async function validateStoredReceipt(stored: RecordResult, file: string) {
	const fixture = getLedgerEvaluationCase(
		stored.job.surface,
		stored.job.caseId,
		stored.job.promptVariant,
	);
	if (
		!fixture ||
		!MODELS.includes(stored.job.modelRef) ||
		!Number.isInteger(stored.job.repetition) ||
		stored.job.repetition < 0 ||
		stored.job.repetition > 2
	)
		throw new Error("Persisted evaluation identity mismatch");
	const hashes = await hashLedgerEvaluationCase(fixture);
	const key = createHash("sha256")
		.update(JSON.stringify({ job: stored.job, ...hashes }))
		.digest("hex");
	if (
		file !== `${key}.json` ||
		stored.systemHash !== hashes.systemHash ||
		stored.inputHash !== hashes.inputHash
	)
		throw new Error("Persisted evaluation identity mismatch");
	if (stored.response) {
		validateIdentity(stored.response, stored.job, stored.evaluationId);
		if (
			stored.response.systemHash !== hashes.systemHash ||
			stored.response.inputHash !== hashes.inputHash
		)
			throw new Error("Persisted evaluation response hash mismatch");
		if (
			cliFailureEvidence(null, stored.response).kind !== "indeterminate" ||
			/HTTP (401|403)\b/.test(String(stored.response.error))
		)
			throw new ManagedEvaluationDenied(
				"Stored evaluation response requires authorization review",
			);
	}
}
export async function runLedgerQualification(
	directory: string,
	call: EvaluationCaller,
	models: ModelRef[] = MODELS,
	maxCalls = 12,
	options: {
		continuation?: ReviewedLedgerContinuation;
		organization?: string;
		callable?: string;
		toolName?: string;
	} = {},
) {
	let dispatched = 0;
	let stopped = false;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const groups = models.flatMap((modelRef) =>
		["production", "shorter_status"].flatMap((variant) =>
			["status", "intake", "reply", "lesson"]
				.filter((surface) => variant === "production" || surface === "status")
				.map((surface) => ({
					modelRef,
					surface: surface as LedgerEvaluationSurface,
					promptVariant: variant as LedgerEvaluationPromptVariant,
				})),
		),
	);
	const reviewedFailure = options.continuation
		? await validateContinuation(
				directory,
				options.continuation,
				options.organization,
				options.callable,
				options.toolName,
			)
		: undefined;
	// Inspect the whole journal before either concurrent worker may dispatch.
	// A failed or unsettled receipt outside the first scheduled job still blocks.
	if (!reviewedFailure) {
		for (const file of await readdir(directory)) {
			if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
			const stored = JSON.parse(
				await readFile(join(directory, file), "utf8"),
			) as RecordResult;
			if (stored.denied)
				throw new ManagedEvaluationDenied(
					"Stored qualification was denied; resolve authorization before a new evaluation",
					stored.cliFailure,
				);
			if (stored.interrupted)
				throw new ManagedEvaluationInterrupted(
					"Stored qualification has an indeterminate CLI failure; review evidence before continuing unrelated jobs",
					stored.cliFailure ?? cliFailureEvidence(null),
				);
			if (stored.state !== "completed")
				throw new Error(
					`Unsettled evaluation ${stored.evaluationId}; inspect provider receipt before any new call`,
				);
			await validateStoredReceipt(stored, file);
		}
	}
	const excluded = (job: Pick<Job, "modelRef" | "surface" | "promptVariant">) =>
		!!reviewedFailure &&
		job.modelRef === reviewedFailure.job.modelRef &&
		job.surface === reviewedFailure.job.surface &&
		job.promptVariant === reviewedFailure.job.promptVariant;
	const records: RecordResult[] = [];
	if (reviewedFailure) {
		// Exclusion stops dispatch and re-grading, not historical cost accounting.
		// validateContinuation already checked every other receipt in this journal.
		for (const file of await readdir(directory)) {
			if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
			const stored = JSON.parse(
				await readFile(join(directory, file), "utf8"),
			) as RecordResult;
			if (excluded(stored.job)) records.push(stored);
		}
	}

	async function execute(job: Job): Promise<RecordResult | null> {
		const fixture = getLedgerEvaluationCase(
			job.surface,
			job.caseId,
			job.promptVariant,
		)!;
		const hashes = await hashLedgerEvaluationCase(fixture);
		const key = createHash("sha256")
			.update(JSON.stringify({ job, ...hashes }))
			.digest("hex");
		const path = join(directory, `${key}.json`);
		let existing: RecordResult | undefined;
		try {
			existing = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (existing) {
			if (
				JSON.stringify(existing.job) !== JSON.stringify(job) ||
				existing.systemHash !== hashes.systemHash ||
				existing.inputHash !== hashes.inputHash
			)
				throw new Error("Persisted evaluation identity mismatch");
			// An interrupted request may have been billed. Never repeat it automatically.
			if (existing.denied)
				throw new ManagedEvaluationDenied(
					"Stored qualification was denied; resolve authorization before a new evaluation",
				);
			if (existing.interrupted)
				throw new ManagedEvaluationInterrupted(
					"Stored qualification has an indeterminate CLI failure; review evidence before continuing unrelated jobs",
					existing.cliFailure ?? cliFailureEvidence(null),
				);
			if (existing.state !== "completed")
				throw new Error(
					`Unsettled evaluation ${existing.evaluationId}; inspect provider receipt before any new call`,
				);
			if (existing.response) {
				validateIdentity(existing.response, job, existing.evaluationId);
				if (
					existing.response.systemHash !== hashes.systemHash ||
					existing.response.inputHash !== hashes.inputHash
				)
					throw new Error("Persisted evaluation response hash mismatch");
			}
			let freshGrade = existing.response
				? fixture.grade(
						existing.response.status === "completed"
							? existing.response.output
							: null,
					)
				: existing.grade;
			// Re-grading cannot turn an execution or custody failure into a pass.
			if (existing.error)
				freshGrade = {
					passed: false,
					failures: [
						...new Set([...(freshGrade?.failures ?? []), existing.error]),
					],
					parsed: freshGrade?.parsed ?? null,
				};
			if (
				existing.gradingVersion !== LEDGER_QUALIFICATION_GRADING_VERSION ||
				JSON.stringify(existing.grade) !== JSON.stringify(freshGrade)
			) {
				existing.gradeHistory = [
					...(existing.gradeHistory ?? []),
					{
						gradingVersion: existing.gradingVersion ?? null,
						grade: existing.grade ?? null,
						replacedAt: new Date().toISOString(),
					},
				];
				existing.grade = freshGrade;
				existing.gradingVersion = LEDGER_QUALIFICATION_GRADING_VERSION;
				const temporary = `${path}.tmp`;
				await writeFile(temporary, JSON.stringify(existing, null, 2), {
					mode: 0o600,
				});
				await rename(temporary, path);
			}
			return existing;
		}
		if (stopped || dispatched >= maxCalls) return null;
		dispatched++;
		const record: RecordResult = {
			job,
			evaluationId: randomUUID(),
			state: "started",
			gradingVersion: LEDGER_QUALIFICATION_GRADING_VERSION,
			...hashes,
		};
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(record));
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			const { repetition: _, ...input } = job;
			const response = await call({
				...input,
				evaluationId: record.evaluationId,
			});
			record.response = response;
			validateIdentity(response, job, record.evaluationId);
			if (
				response.systemHash !== hashes.systemHash ||
				response.inputHash !== hashes.inputHash
			)
				throw new Error("Managed evaluation prompt hash mismatch");
			record.grade = fixture.grade(
				response.status === "completed" ? response.output : null,
			);
		} catch (error) {
			if (error instanceof ManagedEvaluationDenied) {
				stopped = true;
				record.denied = true;
				record.cliFailure = error.evidence;
			} else if (error instanceof ManagedEvaluationInterrupted) {
				stopped = true;
				record.interrupted = true;
				record.cliFailure = error.evidence;
			}
			record.error = error instanceof Error ? error.message : String(error);
			record.grade = { passed: false, failures: [record.error], parsed: null };
		}
		record.state = "completed";
		const temporary = `${path}.tmp`;
		await writeFile(temporary, JSON.stringify(record, null, 2), {
			mode: 0o600,
		});
		await rename(temporary, path);
		if (record.denied) throw new ManagedEvaluationDenied(record.error);
		if (record.interrupted)
			throw new ManagedEvaluationInterrupted(record.error!, record.cliFailure!);
		return record;
	}
	// At most two paid requests in flight. Every group is screened once first.
	async function batch(jobs: Job[]) {
		const output: RecordResult[] = [];
		let next = 0;
		const settled = await Promise.allSettled(
			[0, 1].map(async () => {
				while (!stopped && next < jobs.length) {
					const job = jobs[next++]!;
					let result: RecordResult | null;
					try {
						result = await execute(job);
					} catch (error) {
						stopped = true;
						throw error;
					}
					if (result) {
						output.push(result);
						records.push(result);
					}
				}
			}),
		);
		const failure = settled.find((row) => row.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		return output;
	}
	// Interleave models/variants for each case to reduce timing and provider-load bias.
	const screenJobs = listLedgerEvaluationCases().flatMap((row) =>
		groups
			.filter((group) => group.surface === row.surface)
			.map((group) => ({ ...group, caseId: row.caseId, repetition: 0 })),
	);
	const screen = await batch(screenJobs.filter((job) => !excluded(job)));
	const passing = groups.filter((group) => {
		if (excluded(group)) return false;
		const expected = screenJobs.filter(
			(job) =>
				job.surface === group.surface &&
				job.modelRef === group.modelRef &&
				job.promptVariant === group.promptVariant,
		);
		const selected = screen.filter(
			(row) =>
				row.job.surface === group.surface &&
				row.job.modelRef === group.modelRef &&
				row.job.promptVariant === group.promptVariant,
		);
		return (
			selected.length === expected.length &&
			selected.every((row) => row.grade?.passed)
		);
	});
	await batch(
		[1, 2].flatMap((repetition) =>
			listLedgerEvaluationCases().flatMap((row) =>
				passing
					.filter((group) => group.surface === row.surface)
					.map((group) => ({ ...group, caseId: row.caseId, repetition })),
			),
		),
	);
	return {
		dispatched,
		continuation: options.continuation ?? null,
		records,
		groups: groups.map((group) => {
			const selected = records.filter(
				(row) =>
					row.job.modelRef === group.modelRef &&
					row.job.surface === group.surface &&
					row.job.promptVariant === group.promptVariant,
			);
			const required =
				listLedgerEvaluationCases().filter(
					(row) => row.surface === group.surface,
				).length * 3;
			return {
				...group,
				excludedByContinuation: excluded(group),
				calls: selected.length,
				required,
				qualified:
					!excluded(group) &&
					selected.length === required &&
					selected.every((row) => row.grade?.passed),
				failures: selected
					.filter((row) => !row.grade?.passed)
					.map((row) => ({
						caseId: row.job.caseId,
						repetition: row.job.repetition,
						failures: row.grade?.failures,
					})),
			};
		}),
	};
}

export type CliToolExecutor = (args: string[]) => Promise<string>;
const executeCliTool: CliToolExecutor = async (args) => {
	const startedAt = Date.now();
	try {
		const result = await promisify(execFile)("tedix", args, {
			timeout: 35_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		return result.stdout;
	} catch (error) {
		if (error && typeof error === "object")
			Object.assign(error, { cliElapsedMs: Date.now() - startedAt });
		throw error;
	}
};
const EVALUATION_RESULT_KEYS = [
	"evaluationId",
	"modelRef",
	"surface",
	"caseId",
	"promptVariant",
	"systemHash",
	"inputHash",
	"status",
	"output",
	"error",
	"providerRequestId",
	"latencyMs",
	"usage",
];
// Mirror the fixed API result contract without introducing a context-core ->
// api-contract dependency. No arbitrary RPC or recursively unwrapped payloads.
function isManagedResult(value: unknown): value is ManagedResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	const keys = (input: object, expected: string[]) =>
		JSON.stringify(Object.keys(input).sort()) ===
		JSON.stringify([...expected].sort());
	if (
		!keys(row, EVALUATION_RESULT_KEYS) ||
		![
			"evaluationId",
			"modelRef",
			"surface",
			"caseId",
			"promptVariant",
			"systemHash",
			"inputHash",
		].every((key) => typeof row[key] === "string")
	)
		return false;
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			row.evaluationId as string,
		) ||
		!MODELS.includes(row.modelRef as ModelRef) ||
		!["status", "intake", "reply", "lesson"].includes(row.surface as string) ||
		!["production", "shorter_status"].includes(row.promptVariant as string)
	)
		return false;
	if (
		![
			"completed",
			"incomplete",
			"http_error",
			"transport_error",
			"unavailable",
		].includes(row.status as string) ||
		!["output", "error", "providerRequestId"].every(
			(key) => row[key] === null || typeof row[key] === "string",
		) ||
		typeof row.latencyMs !== "number" ||
		!Number.isFinite(row.latencyMs) ||
		row.latencyMs < 0
	)
		return false;
	const usage = row.usage;
	return (
		!!usage &&
		typeof usage === "object" &&
		!Array.isArray(usage) &&
		keys(usage, [
			"inputTokens",
			"outputTokens",
			"totalTokens",
			"cachedInputTokens",
			"reasoningTokens",
		]) &&
		Object.values(usage).every(
			(value) =>
				value === null || (typeof value === "number" && Number.isFinite(value)),
		)
	);
}
export function createCliEvaluationCaller(
	organization: string,
	toolName: string,
	execute: CliToolExecutor = executeCliTool,
): EvaluationCaller {
	if (
		!/^[A-Za-z_$][\w$]*__evaluate_ledger_model$/.test(toolName) ||
		["constructor", "__proto__", "prototype"].includes(toolName.split("__")[0]!)
	)
		throw new Error("Use the exact authorized discovered evaluation tool name");
	return async (input) => {
		let raw: string;
		try {
			raw = await execute([
				"-w",
				"connect",
				"--organization",
				organization,
				"mcp",
				"call",
				"tools/call",
				"--params",
				JSON.stringify({ name: toolName, arguments: input }),
				"--json",
			]);
		} catch (error) {
			throw cliFailure(error);
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(raw);
		} catch {
			throw cliFailure({ stdout: raw });
		}
		if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
			throw cliFailure({ stdout: raw }, envelope);
		const result = envelope as Record<string, unknown>;
		if (
			Object.keys(result).some(
				(key) =>
					!["content", "structuredContent", "isError", "_meta"].includes(key),
			)
		)
			throw cliFailure({ stdout: raw }, result);
		// rawRequest returns the MCP result, not a JSON-RPC transport envelope.
		if (
			result.isError ||
			(result.isError !== undefined && result.isError !== false)
		) {
			const meta = result._meta as Record<string, unknown> | undefined;
			const detail =
				result.structuredContent && typeof result.structuredContent === "object"
					? (result.structuredContent as Record<string, unknown>)
					: result;
			throw cliFailure(
				{ stdout: raw },
				{
					...detail,
					...(meta?.["tedix/error"] as Record<string, unknown> | undefined),
					traceId: meta?.["com.tedix/traceId"] ?? detail.traceId,
				},
			);
		}
		const candidates: ManagedResult[] = [];
		if (result.structuredContent !== undefined) {
			if (!isManagedResult(result.structuredContent))
				throw cliFailure({ stdout: raw }, result.structuredContent);
			candidates.push(result.structuredContent);
		}
		if (result.content !== undefined) {
			if (!Array.isArray(result.content))
				throw cliFailure({ stdout: raw }, result);
			for (const block of result.content) {
				if (!block || block.type !== "text" || typeof block.text !== "string")
					throw cliFailure({ stdout: raw }, result);
				let parsed: unknown;
				try {
					parsed = JSON.parse(block.text);
				} catch {
					continue;
				}
				if (!isManagedResult(parsed)) throw cliFailure({ stdout: raw }, parsed);
				candidates.push(parsed);
			}
		}
		const canonical = (value: ManagedResult) =>
			JSON.stringify(
				EVALUATION_RESULT_KEYS.map((key) =>
					key === "usage"
						? Object.entries(value.usage as object).sort(([a], [b]) =>
								a.localeCompare(b),
							)
						: value[key],
				),
			);
		if (
			!candidates.length ||
			candidates.some((value) => canonical(value) !== canonical(candidates[0]!))
		)
			throw cliFailure({ stdout: raw }, result);
		return parseManagedEvaluationEnvelope({ json: candidates[0]! });
	};
}

async function main(args: string[]) {
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index < 0 ? undefined : args[index + 1];
	};
	if (
		(option("-w") ?? option("--workspace")) !== "connect" ||
		(args.includes("--workspace") && option("--workspace") !== "connect") ||
		(args.includes("-w") && option("-w") !== "connect")
	)
		throw new Error(
			"Pass -w connect explicitly; qualification uses the existing authenticated Connect profile",
		);
	const directory = option("--out");
	const organization = option("--organization");
	if (!directory || !organization)
		throw new Error(
			"Pass --out <local-artifact-directory> and --organization <authorized-organization>",
		);
	const maximum = Number(option("--max-calls") ?? 12);
	if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000)
		throw new Error("--max-calls must be 1..1000 (default12)");
	const model = option("--model") as ModelRef | undefined;
	if (model && !MODELS.includes(model))
		throw new Error("Unknown fixed evaluation model");
	const { readdir } = await import("node:fs/promises");
	try {
		if ((await readdir(directory)).length && !args.includes("--resume"))
			throw new Error(
				"Artifact directory already exists; use --resume to retain previous receipts",
			);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const callable = option("--callable");
	if (!callable || !/^[A-Za-z_$][\w$]*\.evaluate_ledger_model$/.test(callable))
		throw new Error(
			"Pass --callable <namespace.evaluate_ledger_model> from current authorized tool discovery",
		);
	const toolName = option("--tool-name");
	if (!toolName)
		throw new Error(
			"Pass --tool-name <live-discovered-wire-name> from current authorized native tool discovery",
		);
	const call = createCliEvaluationCaller(organization, toolName);
	const continuationPath = option("--continuation-manifest");
	const continuation = continuationPath
		? (JSON.parse(
				await readFile(continuationPath, "utf8"),
			) as ReviewedLedgerContinuation)
		: undefined;
	const summary = await runLedgerQualification(
		directory,
		call,
		model ? [model] : MODELS,
		maximum,
		{ continuation, organization, callable, toolName },
	);
	await writeFile(
		join(directory, "summary.json"),
		JSON.stringify(summary, null, 2),
		{ mode: 0o600 },
	);
	console.log(
		JSON.stringify(
			{ dispatched: summary.dispatched, groups: summary.groups },
			null,
			2,
		),
	);
}
if (import.meta.main) await main(process.argv.slice(2));

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
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
class ManagedEvaluationDenied extends Error {}
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
	error?: string;
	denied?: boolean;
}
export type EvaluationCaller = (input: Input) => Promise<ManagedResult>;
const MODELS: ModelRef[] = [
	"azure-openai/gpt-6-astra",
	"azure-openai/gpt-6.1-sol",
	"azure-openai/gpt-6-luna",
];
export async function runLedgerQualification(
	directory: string,
	call: EvaluationCaller,
	models: ModelRef[] = MODELS,
	maxCalls = 12,
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
	const records: RecordResult[] = [];
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
			if (existing.state !== "completed")
				throw new Error(
					`Unsettled evaluation ${existing.evaluationId}; inspect provider receipt before any new call`,
				);
			if (existing.response && !existing.error) {
				validateIdentity(existing.response, job, existing.evaluationId);
				if (
					existing.response.systemHash !== hashes.systemHash ||
					existing.response.inputHash !== hashes.inputHash
				)
					throw new Error("Persisted evaluation response hash mismatch");
			}
			return {
				...existing,
				grade: existing.error
					? existing.grade
					: existing.response
						? fixture.grade(
								existing.response.status === "completed"
									? existing.response.output
									: null,
							)
						: undefined,
			};
		}
		if (dispatched >= maxCalls) return null;
		dispatched++;
		const record: RecordResult = {
			job,
			evaluationId: randomUUID(),
			state: "started",
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
	const screen = await batch(screenJobs);
	const passing = groups.filter((group) => {
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
				calls: selected.length,
				required,
				qualified:
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

export type CliCodeExecutor = (args: string[]) => Promise<string>;
const executeCliCode: CliCodeExecutor = async (args) => {
	const result = await promisify(execFile)("tedix", args, {
		timeout: 35_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return result.stdout;
};
export function createCliEvaluationCaller(
	organization: string,
	callable: string,
	execute: CliCodeExecutor = executeCliCode,
): EvaluationCaller {
	if (
		!/^[A-Za-z_$][\w$]*\.evaluate_ledger_model$/.test(callable) ||
		["constructor", "__proto__", "prototype"].includes(callable.split(".")[0]!)
	)
		throw new Error("Use the exact authorized discovered evaluation callable");
	return async (input) => {
		const source = `async () => await ${callable}(JSON.parse(${JSON.stringify(JSON.stringify(input))}))`;
		let raw: string;
		try {
			raw = await execute([
				"-w",
				"connect",
				"--organization",
				organization,
				"code",
				source,
				"--json",
			]);
		} catch {
			throw new ManagedEvaluationDenied(
				"Tedix CLI evaluation did not complete; inspect the normal authorization, approval or transport result before continuing",
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			throw new ManagedEvaluationDenied(
				"Tedix CLI returned an invalid evaluation result",
			);
		}
		if (
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			![
				"completed",
				"incomplete",
				"http_error",
				"transport_error",
				"unavailable",
			].includes((body as ManagedResult).status)
		)
			throw new ManagedEvaluationDenied(
				"Tedix evaluation requires authorization, approval or result review before continuing",
			);
		return parseManagedEvaluationEnvelope({ json: body as ManagedResult });
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
	if (!callable)
		throw new Error(
			"Pass --callable <namespace.evaluate_ledger_model> from current authorized tool discovery",
		);
	const call = createCliEvaluationCaller(organization, callable);
	const summary = await runLedgerQualification(
		directory,
		call,
		model ? [model] : MODELS,
		maximum,
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

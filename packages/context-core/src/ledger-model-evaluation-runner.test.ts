import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import {
	runLedgerQualification,
	parseManagedEvaluationEnvelope,
	createCliEvaluationCaller,
	type EvaluationCaller,
} from "../scripts/qualify-ledger-models";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	LEDGER_QUALIFICATION_GRADING_VERSION,
} from "./ledger-model-evaluation";

it("bounds paid calls, records receipts before dispatch, resumes without rebilling, and pairs models", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ledger-qualification-"));
	const ids: string[] = [];
	let active = 0,
		peak = 0;
	const call: EvaluationCaller = async (input) => {
		const files = await readdir(directory);
		const saved = await Promise.all(
			files
				.filter((file) => file.endsWith(".json"))
				.map(async (file) => {
					const text = await readFile(join(directory, file), "utf8");
					// The other worker may still be writing its own reservation.
					return text.includes(input.evaluationId) ? JSON.parse(text) : null;
				}),
		);
		expect(
			saved.some(
				(row) =>
					row?.evaluationId === input.evaluationId && row.state === "started",
			),
		).toBe(true);
		expect(ids).not.toContain(input.evaluationId);
		ids.push(input.evaluationId);
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active--;
		return {
			...input,
			...(await hashLedgerEvaluationCase(
				getLedgerEvaluationCase(
					input.surface,
					input.caseId,
					input.promptVariant,
				)!,
			)),
			status: "completed",
			output: null,
		};
	};
	try {
		const first = await runLedgerQualification(directory, call, undefined, 12);
		expect(first.dispatched).toBe(12);
		expect(ids).toHaveLength(12);
		expect(peak).toBeLessThanOrEqual(2);
		expect(first.records.slice(0, 6).map((row) => row.job.modelRef)).toContain(
			"azure-openai/gpt-6.1-sol",
		);
		expect(first.groups.every((row) => !row.qualified)).toBe(true);
		const second = await runLedgerQualification(directory, call, undefined, 12);
		expect(second.dispatched).toBe(12);
		expect(ids).toHaveLength(24);
		expect(second.records.some((row) => row.job.repetition !== 0)).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("refuses unresolved receipts and never retries provider failures or hash mismatches", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ledger-qualification-"));
	let calls = 0;
	const call: EvaluationCaller = async (input) => {
		calls++;
		return {
			...input,
			systemHash: "wrong",
			inputHash: "wrong",
			status: "completed",
			output: '{"updates":[],"lanes":[],"mentioned":{},"merges":[]}',
		};
	};
	try {
		const first = await runLedgerQualification(directory, call, undefined, 2);
		expect(calls).toBe(2);
		expect(first.records.every((row) => row.grade?.passed === false)).toBe(
			true,
		);
		await expect(
			runLedgerQualification(directory, call, undefined, 0),
		).rejects.toThrow("Persisted evaluation response hash mismatch");
		expect(calls).toBe(2);
		for (const file of await readdir(directory)) {
			const path = join(directory, file);
			const record = JSON.parse(await readFile(path, "utf8"));
			record.state = "started";
			await writeFile(path, JSON.stringify(record));
		}
		await expect(
			runLedgerQualification(directory, call, undefined, 1),
		).rejects.toThrow("Unsettled evaluation");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("stops on nested RPC denial and refuses to rebill the persisted denial", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ledger-qualification-"));
	let calls = 0;
	const call: EvaluationCaller = async () => {
		calls++;
		return parseManagedEvaluationEnvelope({
			json: { code: "FORBIDDEN" } as never,
		});
	};
	try {
		await expect(
			runLedgerQualification(directory, call, undefined, 12),
		).rejects.toThrow("authorization denied");
		expect(calls).toBeLessThanOrEqual(2);
		const before = calls;
		await expect(
			runLedgerQualification(directory, call, undefined, 12),
		).rejects.toThrow("Stored qualification was denied");
		expect(calls).toBe(before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("rejects a different model's response with identical prompt hashes and retains that failure on resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ledger-qualification-"));
	let calls = 0;
	const call: EvaluationCaller = async (input) => {
		calls++;
		return {
			...input,
			...(await hashLedgerEvaluationCase(
				getLedgerEvaluationCase(
					input.surface,
					input.caseId,
					input.promptVariant,
				)!,
			)),
			modelRef: "azure-openai/foreign-model",
			status: "completed",
			output: '{"updates":[],"lanes":[],"mentioned":{},"merges":[]}',
		};
	};
	try {
		const first = await runLedgerQualification(directory, call, undefined, 2);
		expect(
			first.records.every((row) =>
				row.grade?.failures.includes("Managed evaluation identity mismatch"),
			),
		).toBe(true);
		await expect(
			runLedgerQualification(directory, call, undefined, 0),
		).rejects.toThrow("Managed evaluation identity mismatch");
		expect(calls).toBe(2);
		const files = await readdir(directory);
		const saved = await Promise.all(
			files.map(async (file) =>
				JSON.parse(await readFile(join(directory, file), "utf8")),
			),
		);
		expect(saved.every((row) => row.grade.passed === false)).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("atomically audits re-grading without changing authentic responses or making new calls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ledger-regrading-"));
	let calls = 0;
	const call: EvaluationCaller = async (input) => {
		calls++;
		return {
			...input,
			...(await hashLedgerEvaluationCase(
				getLedgerEvaluationCase(
					input.surface,
					input.caseId,
					input.promptVariant,
				)!,
			)),
			status: "completed",
			output: null,
			providerRequestId: "fictional-authentic-receipt",
			usage: { inputTokens: 10, outputTokens: 1 },
		};
	};
	try {
		const first = await runLedgerQualification(directory, call, undefined, 1);
		expect(first.records[0]!.gradingVersion).toBe(
			LEDGER_QUALIFICATION_GRADING_VERSION,
		);
		const path = join(directory, (await readdir(directory))[0]!);
		const original = JSON.parse(await readFile(path, "utf8"));
		const oldGrade = original.grade;
		await writeFile(path, JSON.stringify({ ...original, gradingVersion: 1 }));
		await runLedgerQualification(directory, call, undefined, 0);
		const migrated = JSON.parse(await readFile(path, "utf8"));
		expect(migrated.gradingVersion).toBe(2);
		expect(migrated.gradeHistory).toEqual([
			{ gradingVersion: 1, grade: oldGrade, replacedAt: expect.any(String) },
		]);
		const incorrectGrade = {
			passed: true,
			failures: [],
			parsed: "obsolete-derived-grade",
		};
		await writeFile(
			path,
			JSON.stringify({ ...migrated, grade: incorrectGrade }),
		);
		await runLedgerQualification(directory, call, undefined, 0);
		const corrected = JSON.parse(await readFile(path, "utf8"));
		expect(corrected.grade).toEqual(oldGrade);
		expect(corrected.gradeHistory).toHaveLength(2);
		expect(corrected.gradeHistory[1]).toMatchObject({
			gradingVersion: 2,
			grade: incorrectGrade,
		});
		delete corrected.gradingVersion;
		await writeFile(path, JSON.stringify(corrected));
		await runLedgerQualification(directory, call, undefined, 0);
		const legacy = JSON.parse(await readFile(path, "utf8"));
		expect(legacy.gradeHistory[2]).toMatchObject({
			gradingVersion: null,
			grade: oldGrade,
		});
		await runLedgerQualification(directory, call, undefined, 0);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
		for (const key of [
			"job",
			"evaluationId",
			"state",
			"response",
			"systemHash",
			"inputHash",
		])
			expect(legacy[key]).toEqual(original[key]);
		expect(calls).toBe(1);
		expect(
			(await readdir(directory)).filter((file) => file.endsWith(".tmp")),
		).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("uses the normal scoped CLI code path with argv-only invocation and no direct bearer request", async () => {
	const input = {
		surface: "status",
		caseId: "trim-tabs",
		promptVariant: "production",
		modelRef: "azure-openai/gpt-6-astra",
		evaluationId: "10000000-0000-4000-8000-000000000001",
	} as const;
	const response = {
		...input,
		...(await hashLedgerEvaluationCase(
			getLedgerEvaluationCase(input.surface, input.caseId)!,
		)),
		status: "completed",
		output: '{"updates":[],"mentioned":{},"lanes":[],"merges":[]}',
	};
	const calls: string[][] = [];
	const caller = createCliEvaluationCaller(
		"org_example",
		"example.evaluate_ledger_model",
		async (args) => {
			calls.push(args);
			return JSON.stringify(response);
		},
	);
	expect(await caller(input)).toEqual(response);
	expect(calls).toEqual([
		[
			"-w",
			"connect",
			"--organization",
			"org_example",
			"code",
			`async () => await example.evaluate_ledger_model(JSON.parse(${JSON.stringify(JSON.stringify(input))}))`,
			"--json",
		],
	]);
	expect(() =>
		createCliEvaluationCaller("org_example", "example.other_tool"),
	).toThrow("exact authorized discovered");
	expect(() =>
		createCliEvaluationCaller(
			"org_example",
			"example.evaluate_ledger_model; sideEffect()",
		),
	).toThrow();
});

it("stops on CLI policy approval or transport failures without dispatching a replacement", async () => {
	const input = {
		surface: "status",
		caseId: "trim-tabs",
		promptVariant: "production",
		modelRef: "azure-openai/gpt-6-astra",
		evaluationId: "10000000-0000-4000-8000-000000000001",
	} as const;
	let calls = 0;
	const approval = createCliEvaluationCaller(
		"org_example",
		"example.evaluate_ledger_model",
		async () => {
			calls++;
			return JSON.stringify({
				status: "requires_approval",
				approvalId: "fictional",
			});
		},
	);
	await expect(approval(input)).rejects.toThrow(
		"requires authorization, approval or result review",
	);
	expect(calls).toBe(1);
	const denied = createCliEvaluationCaller(
		"org_example",
		"example.evaluate_ledger_model",
		async () => {
			calls++;
			throw new Error("FORBIDDEN");
		},
	);
	await expect(denied(input)).rejects.toThrow("did not complete");
	expect(calls).toBe(2);
});

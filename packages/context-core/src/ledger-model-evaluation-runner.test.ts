import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import {
	runLedgerQualification,
	parseManagedEvaluationEnvelope,
	type EvaluationCaller,
} from "../scripts/qualify-ledger-models";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
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
		const second = await runLedgerQualification(directory, call, undefined, 1);
		expect(calls).toBe(3);
		expect(second.records.every((row) => row.grade?.passed === false)).toBe(
			true,
		);
		const file = (await readdir(directory))[0]!;
		const path = join(directory, file);
		const record = JSON.parse(await readFile(path, "utf8"));
		record.state = "started";
		await writeFile(path, JSON.stringify(record));
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
		await runLedgerQualification(directory, call, undefined, 1);
		expect(calls).toBe(3);
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

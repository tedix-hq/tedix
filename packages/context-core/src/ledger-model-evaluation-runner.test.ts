import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import {
	runLedgerQualification,
	parseManagedEvaluationEnvelope,
	createCliEvaluationCaller,
	type EvaluationCaller,
	type ReviewedLedgerContinuation,
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

it("uses the normal scoped native MCP path with argv-only invocation and no direct bearer request", async () => {
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
		error: null,
		providerRequestId: null,
		latencyMs: 1,
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			cachedInputTokens: null,
			reasoningTokens: null,
		},
	};
	const calls: string[][] = [];
	const caller = createCliEvaluationCaller(
		"org_example",
		"example__evaluate_ledger_model",
		async (args) => {
			calls.push(args);
			return JSON.stringify({
				structuredContent: response,
				content: [{ type: "text", text: JSON.stringify(response) }],
			});
		},
	);
	expect(await caller(input)).toEqual(response);
	expect(calls).toEqual([
		[
			"-w",
			"connect",
			"--organization",
			"org_example",
			"mcp",
			"call",
			"tools/call",
			"--params",
			JSON.stringify({
				name: "example__evaluate_ledger_model",
				arguments: input,
			}),
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

it("retains bounded redacted CLI diagnostics and pauses unknown failures without claiming denial", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ledger-cli-failure-"));
	let calls = 0;
	const call = createCliEvaluationCaller(
		"org_example",
		"example__evaluate_ledger_model",
		async () => {
			calls++;
			throw Object.assign(new Error("do not persist the full command"), {
				code: 1,
				signal: "SIGTERM",
				killed: true,
				stderr: `Connection closed\nAuthorization: Bearer sensitive-fake-token\n${"x".repeat(4000)}`,
				stdout: "",
				cliElapsedMs: 35010,
			});
		},
	);
	try {
		await expect(
			runLedgerQualification(directory, call, undefined, 1),
		).rejects.toThrow("did not complete");
		const saved = JSON.parse(
			await readFile(join(directory, (await readdir(directory))[0]!), "utf8"),
		);
		expect(saved).toMatchObject({
			state: "completed",
			interrupted: true,
			grade: { passed: false },
			cliFailure: {
				kind: "indeterminate",
				exitCode: 1,
				signal: "SIGTERM",
				killed: true,
				timedOut: null,
				configuredTimeoutMs: 35000,
				elapsedMs: 35010,
			},
		});
		expect(saved.denied).not.toBe(true);
		expect(saved.cliFailure.stderr.length).toBeLessThanOrEqual(2000);
		expect(JSON.stringify(saved)).not.toContain("sensitive-fake-token");
		await expect(
			runLedgerQualification(directory, call, undefined, 1),
		).rejects.toThrow("indeterminate CLI failure");
		expect(calls).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each(["authorization", "approval"] as const)(
	"retains actual %s evidence as a non-overridable global block",
	async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), "ledger-auth-failure-"));
		let calls = 0;
		const traceId = "10000000-0000-4000-8000-000000000009";
		const call = createCliEvaluationCaller(
			"org_example",
			"example__evaluate_ledger_model",
			async () => {
				calls++;
				if (kind === "authorization")
					throw Object.assign(new Error("CLI error"), {
						code: 2,
						stderr: JSON.stringify({ error: { code: "FORBIDDEN", traceId } }),
					});
				return JSON.stringify({
					status: "requires_approval",
					approvalId: "fictional-approval",
					traceId,
				});
			},
		);
		try {
			await expect(
				runLedgerQualification(directory, call, undefined, 1),
			).rejects.toThrow("requires authorization or approval");
			const saved = JSON.parse(
				await readFile(join(directory, (await readdir(directory))[0]!), "utf8"),
			);
			expect(saved).toMatchObject({
				denied: true,
				cliFailure: { kind, traceId },
			});
			if (kind === "authorization")
				expect(saved.cliFailure.errorCode).toBe("FORBIDDEN");
			else expect(saved.cliFailure.approvalId).toBe("fictional-approval");
			await expect(
				runLedgerQualification(directory, call, undefined, 1),
			).rejects.toThrow("Stored qualification was denied");
			expect(calls).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

it.each([false, true])(
	"continues only unrelated cohorts with a receipt-bound review, preserving the failed receipt (legacy=%s)",
	async (legacy) => {
		const directory = await mkdtemp(
			join(tmpdir(), "ledger-reviewed-continuation-"),
		);
		const broken = createCliEvaluationCaller(
			"org_example",
			"example__evaluate_ledger_model",
			async () => {
				throw Object.assign(new Error("unknown"), {
					code: 1,
					stderr: "Connection closed",
				});
			},
		);
		try {
			await expect(
				runLedgerQualification(directory, broken, undefined, 1),
			).rejects.toThrow("did not complete");
			const file = (await readdir(directory))[0]!;
			const path = join(directory, file);
			const failed = JSON.parse(await readFile(path, "utf8"));
			if (legacy) {
				delete failed.interrupted;
				delete failed.cliFailure;
				failed.denied = true;
				failed.error =
					"Tedix CLI evaluation did not complete; inspect the normal authorization, approval or transport result before continuing";
				await writeFile(path, JSON.stringify(failed));
			}
			const original = await readFile(path, "utf8");
			const cachedJob = { ...failed.job, repetition: 1 };
			const cachedId = "10000000-0000-4000-8000-000000000009";
			const { repetition: _, ...cachedInput } = cachedJob;
			const cached = {
				job: cachedJob,
				evaluationId: cachedId,
				state: "completed",
				systemHash: failed.systemHash,
				inputHash: failed.inputHash,
				gradingVersion: 1,
				grade: { passed: true, failures: [], parsed: { historical: true } },
				response: {
					...cachedInput,
					evaluationId: cachedId,
					systemHash: failed.systemHash,
					inputHash: failed.inputHash,
					status: "completed",
					output: "{}",
				},
			};
			const cachedPath = join(
				directory,
				`${createHash("sha256")
					.update(
						JSON.stringify({
							job: cachedJob,
							systemHash: failed.systemHash,
							inputHash: failed.inputHash,
						}),
					)
					.digest("hex")}.json`,
			);
			const cachedBytes = JSON.stringify(cached);
			await writeFile(cachedPath, cachedBytes);
			const preflightBytes = JSON.stringify({
				isError: true,
				structuredContent: {
					code: "BAD_REQUEST",
					message: "Unknown evaluation case or prompt variant",
					data: {},
				},
				_meta: {
					"tedix/error": { code: "BAD_REQUEST", status: 400 },
					"com.tedix/traceId": "10000000-0000-4000-8000-000000000008",
				},
			});
			const responseFile = join(directory, "native-preflight.json");
			await writeFile(responseFile, preflightBytes);
			const review: ReviewedLedgerContinuation = {
				schemaVersion: 1,
				decision: "continue_unrelated_no_replay",
				failedReceipt: {
					file,
					evaluationId: failed.evaluationId,
					sha256: createHash("sha256").update(original).digest("hex"),
				},
				preflight: {
					workspace: "connect",
					organization: "org_example",
					callable: "example.evaluate_ledger_model",
					endpoint: "workAgentSessions/evaluateLedgerModel",
					toolName: "example__evaluate_ledger_model",
					transport: "mcp_tools_call",
					responseSha256: createHash("sha256")
						.update(preflightBytes)
						.digest("hex"),
					responseFile,
					observedAt: "2026-11-02T10:06:00Z",
					code: "BAD_REQUEST",
					message: "Unknown evaluation case or prompt variant",
					executionId: null,
					traceId: "10000000-0000-4000-8000-000000000008",
				},
			};
			let calls = 0;
			const call: EvaluationCaller = async (input) => {
				calls++;
				expect([
					input.modelRef,
					input.surface,
					input.promptVariant,
				]).not.toEqual([
					failed.job.modelRef,
					failed.job.surface,
					failed.job.promptVariant,
				]);
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
			const options = {
				continuation: review,
				organization: "org_example",
				callable: "example.evaluate_ledger_model",
				toolName: "example__evaluate_ledger_model",
			};
			await expect(
				runLedgerQualification(directory, call, undefined, 0, {
					...options,
					organization: "foreign",
				}),
			).rejects.toThrow("preflight binding");
			for (const wrong of [
				{ toolName: "foreign__evaluate_ledger_model" },
				{ callable: "foreign.evaluate_ledger_model" },
			]) {
				await expect(
					runLedgerQualification(directory, call, undefined, 0, {
						...options,
						...wrong,
					}),
				).rejects.toThrow("preflight binding");
			}
			await expect(
				runLedgerQualification(directory, call, undefined, 0, {
					...options,
					continuation: {
						...review,
						failedReceipt: { ...review.failedReceipt, sha256: "0".repeat(64) },
					},
				}),
			).rejects.toThrow("receipt hash mismatch");
			await expect(
				runLedgerQualification(directory, call, undefined, 0, {
					...options,
					continuation: {
						...review,
						preflight: { ...review.preflight, responseSha256: "0".repeat(64) },
					},
				}),
			).rejects.toThrow("preflight response hash mismatch");
			const forbiddenBytes = JSON.stringify({
				isError: true,
				structuredContent: { code: "FORBIDDEN", message: "Denied" },
				_meta: { "tedix/error": { code: "FORBIDDEN", status: 403 } },
			});
			await writeFile(responseFile, forbiddenBytes);
			await expect(
				runLedgerQualification(directory, call, undefined, 0, {
					...options,
					continuation: {
						...review,
						preflight: {
							...review.preflight,
							responseSha256: createHash("sha256")
								.update(forbiddenBytes)
								.digest("hex"),
						},
					},
				}),
			).rejects.toThrow("does not prove");
			await writeFile(responseFile, preflightBytes);
			expect(calls).toBe(0);
			const summary = await runLedgerQualification(
				directory,
				call,
				undefined,
				2,
				options,
			);
			expect(calls).toBe(2);
			expect(summary.continuation).toEqual(review);
			expect(summary.records).toHaveLength(4);
			expect(
				summary.records.find((row) => row.evaluationId === cachedId),
			).toEqual(cached);
			expect(await readFile(cachedPath, "utf8")).toBe(cachedBytes);
			expect(
				summary.groups.find((group) => group.excludedByContinuation),
			).toMatchObject({
				modelRef: failed.job.modelRef,
				surface: failed.job.surface,
				promptVariant: failed.job.promptVariant,
				calls: 2,
				qualified: false,
			});
			expect(await readFile(path, "utf8")).toBe(original);
			const blocked = {
				...failed,
				denied: true,
				cliFailure: { kind: "authorization", errorCode: "FORBIDDEN" },
			};
			await writeFile(path, JSON.stringify(blocked));
			const blockedBytes = await readFile(path, "utf8");
			await expect(
				runLedgerQualification(directory, call, undefined, 0, {
					...options,
					continuation: {
						...review,
						failedReceipt: {
							...review.failedReceipt,
							sha256: createHash("sha256").update(blockedBytes).digest("hex"),
						},
					},
				}),
			).rejects.toThrow("Only an indeterminate failed receipt");
			expect(calls).toBe(2);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

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
		"example__evaluate_ledger_model",
		async () => {
			calls++;
			return JSON.stringify({
				status: "requires_approval",
				approvalId: "fictional",
			});
		},
	);
	await expect(approval(input)).rejects.toThrow(
		"requires authorization or approval",
	);
	expect(calls).toBe(1);
	const denied = createCliEvaluationCaller(
		"org_example",
		"example__evaluate_ledger_model",
		async () => {
			calls++;
			throw new Error("FORBIDDEN");
		},
	);
	await expect(denied(input)).rejects.toThrow("did not complete");
	expect(calls).toBe(2);
});

it("unwraps only exact native MCP results and stops on ambiguity, errors and approvals without fallback", async () => {
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
			getLedgerEvaluationCase("status", "trim-tabs")!,
		)),
		status: "completed",
		output: "{}",
		error: null,
		providerRequestId: "synthetic-request",
		latencyMs: 5,
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			cachedInputTokens: null,
			reasoningTokens: null,
		},
	};
	const reversed = Object.fromEntries(Object.entries(response).reverse());
	for (const envelope of [
		{
			structuredContent: response,
			content: [{ type: "text", text: "Presentation receipt" }],
		},
		{ content: [{ type: "text", text: JSON.stringify(response) }] },
		{
			structuredContent: response,
			content: [{ type: "text", text: JSON.stringify(reversed) }],
		},
	]) {
		const call = createCliEvaluationCaller(
			"org_example",
			"example__evaluate_ledger_model",
			async () => JSON.stringify(envelope),
		);
		expect(await call(input)).toEqual(response);
	}
	for (const [envelope, message] of [
		[
			{
				structuredContent: response,
				content: [
					{
						type: "text",
						text: JSON.stringify({ ...response, output: "different" }),
					},
				],
			},
			"did not complete",
		],
		[{ structuredContent: { ...response, extra: true } }, "did not complete"],
		[{ result: { structuredContent: response } }, "did not complete"],
		[{ isError: true, structuredContent: response }, "did not complete"],
		[
			{
				isError: true,
				_meta: {
					"tedix/error": { code: "FORBIDDEN", traceId: "synthetic-trace" },
				},
			},
			"requires authorization or approval",
		],
		[
			{
				isError: true,
				structuredContent: {
					status: "requires_approval",
					approvalId: "synthetic-approval",
				},
			},
			"requires authorization or approval",
		],
		[
			{
				content: [
					{
						type: "text",
						text: JSON.stringify({
							status: "requires_approval",
							approvalId: "synthetic-approval",
						}),
					},
				],
			},
			"requires authorization or approval",
		],
	] as const) {
		let calls = 0;
		const call = createCliEvaluationCaller(
			"org_example",
			"example__evaluate_ledger_model",
			async () => {
				calls++;
				return JSON.stringify(envelope);
			},
		);
		await expect(call(input)).rejects.toThrow(message);
		expect(calls).toBe(1);
	}
});

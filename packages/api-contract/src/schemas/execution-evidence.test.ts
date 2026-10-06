import { describe, expect, it } from "vite-plus/test";
import {
	buildCodeModeExecutionReceipt,
	buildCompletionEvidence,
	CompletionEvidenceSchema,
	ExecutionRequirementSchema,
	withCompletionEvidence,
} from "./execution-evidence";

describe("execution evidence", () => {
	it("accepts the typed capability lattice and rejects removed surfaces", () => {
		expect(
			ExecutionRequirementSchema.parse({
				surface: "managed_job",
				requiredCapabilities: ["tests", "build"],
				fallbackSurface: "workstation",
				prohibitedSurfaces: [],
				satisfiable: true,
				reason: "bounded validation",
			}),
		).toMatchObject({ surface: "managed_job" });
		expect(() =>
			ExecutionRequirementSchema.parse({
				surface: "either",
				requiredCapabilities: ["tests"],
				fallbackSurface: null,
				prohibitedSurfaces: [],
				satisfiable: true,
				reason: "legacy ambiguity",
			}),
		).toThrow();
	});

	it("does not turn job acceptance into a completion claim", () => {
		const evidence = buildCompletionEvidence({
			operation: "exec",
			result: {
				accepted: true,
				executionId: "job-1",
				status: "running",
				checkpoint: { commitOid: "checkpoint-1" },
			},
			retryKey: "job-1",
		});
		expect(evidence.status).toBe("pending");
		expect(evidence.instruction).toContain("only after a terminal receipt");
		expect(evidence.instruction).toContain("yield for an automatic wake");
		expect(evidence.instruction).toContain(
			"otherwise use its documented status check",
		);
		expect(evidence.instruction).not.toContain("Read read_execution");
		expect(evidence.supportedClaims).toEqual(["the durable job was accepted"]);
		expect(evidence.unsupportedClaims).toContain("the job completed");
		expect(evidence.evidenceRefs).toEqual(["job-1", "checkpoint-1"]);
	});

	it("does not turn a boolean running receipt into a completion claim", () => {
		const evidence = buildCompletionEvidence({
			operation: "read_execution",
			result: {
				executionId: "job-1",
				running: true,
				terminal: false,
				exitCode: null,
			},
			retryKey: "job-1",
		});
		expect(evidence.status).toBe("pending");
		expect(evidence.instruction).toContain("only after a terminal receipt");
		expect(evidence.instruction).toContain("yield for an automatic wake");
		expect(evidence.instruction).toContain(
			"otherwise use its documented status check",
		);
		expect(evidence.instruction).not.toContain("Read read_execution");
		expect(evidence.supportedClaims).toEqual([
			"read_execution is still pending",
		]);
		expect(evidence.unsupportedClaims).toEqual([
			"read_execution fully completed",
		]);
	});

	it("treats canceled and timed-out terminal receipts as non-success", () => {
		const canceled = buildCompletionEvidence({
			operation: "read_execution",
			result: {
				executionId: "job-canceled",
				terminal: true,
				exitCode: null,
				canceled: true,
			},
			retryKey: "job-canceled",
		});
		expect(canceled.status).toBe("canceled");
		expect(canceled.retry.retryable).toBe(false);

		const timedOut = buildCompletionEvidence({
			operation: "read_execution",
			result: {
				executionId: "job-timeout",
				terminal: true,
				exitCode: null,
				timedOut: true,
			},
			retryKey: "job-timeout",
		});
		expect(timedOut.status).toBe("failed");
		expect(timedOut.supportedClaims).toEqual([]);
	});

	it("fails unknown explicit terminal statuses closed", () => {
		const evidence = buildCompletionEvidence({
			operation: "cms_preview",
			result: { status: "timeout", running: false, exitCode: null },
			retryKey: "cms-preview",
		});
		expect(evidence.status).toBe("failed");
		expect(evidence.supportedClaims).toEqual([]);

		const unknown = buildCompletionEvidence({
			operation: "provider_operation",
			result: { status: "waiting_for_vendor" },
			retryKey: "provider-operation",
		});
		expect(unknown.status).toBe("partial");
	});

	it("treats an explicitly ready resource as successful", () => {
		const evidence = buildCompletionEvidence({
			operation: "workstation_status",
			result: { ok: true, status: "ready", ready: true },
			retryKey: "workstation-ready",
		});
		expect(evidence.status).toBe("succeeded");
		expect(evidence.supportedClaims).toEqual([
			"workstation_status returned successfully",
		]);
		expect(evidence.unsupportedClaims).toEqual([]);
	});

	it("treats a successful domain validation status as succeeded", () => {
		const evidence = buildCompletionEvidence({
			operation: "validate_tedi_mcp_access",
			result: {
				status: "valid",
				ok: true,
				evidenceRefs: ["descope-user://U-reviewer"],
			},
			retryKey: "validate-tedi-access",
		});

		expect(evidence.status).toBe("succeeded");
		expect(evidence.supportedClaims).toEqual([
			"validate_tedi_mcp_access returned successfully",
		]);
		expect(evidence.evidenceRefs).toEqual(["descope-user://U-reviewer"]);
	});

	it.each([
		{
			status: "available",
			canonicalUri: "artifact://proof",
			mediaType: "text/plain",
			digest: "a".repeat(64),
			text: "verified preview",
			truncated: false,
		},
		{ status: "unavailable", reason: "source_access_unavailable" },
		{
			status: "external",
			href: "https://example.com/evidence",
			trust: "unverified_external",
		},
	])(
		"treats a valid Work evidence $status result as a completed preview read",
		(result) => {
			const evidence = buildCompletionEvidence({
				operation: "preview_evidence",
				result,
				retryKey: "work-preview",
			});
			expect(evidence.status).toBe("succeeded");
			expect(evidence.retry.retryable).toBe(false);
		},
	);

	it("does not generalize Work preview domain statuses into generic success", () => {
		const malformed = buildCompletionEvidence({
			operation: "preview_evidence",
			result: { status: "available" },
			retryKey: "malformed-preview",
		});
		expect(malformed.status).toBe("partial");
		expect(malformed.retry.retryable).toBe(true);

		const unrelated = buildCompletionEvidence({
			operation: "provider_status",
			result: {
				status: "available",
				canonicalUri: "artifact://proof",
				mediaType: "text/plain",
				digest: "a".repeat(64),
				text: "preview",
				truncated: false,
			},
			retryKey: "provider-status",
		});
		expect(unrelated.status).toBe("partial");
		expect(unrelated.retry.retryable).toBe(true);

		const unsupportedAlias = buildCompletionEvidence({
			operation: "work.preview_evidence",
			result: {
				status: "available",
				canonicalUri: "artifact://proof",
				mediaType: "text/plain",
				digest: "a".repeat(64),
				text: "preview",
				truncated: false,
			},
			retryKey: "unsupported-preview-alias",
		});
		expect(unsupportedAlias.status).toBe("partial");
		expect(unsupportedAlias.retry.retryable).toBe(true);
	});

	it.each([
		{
			status: "available",
			canonicalUri: "artifact://proof",
			mediaType: "text/plain",
			digest: "a".repeat(64),
			text: "x".repeat(51_201),
			truncated: true,
		},
		{
			status: "external",
			href: "https://user:password@example.com/evidence",
			trust: "unverified_external",
		},
	])("rejects an out-of-contract Work preview result", (result) => {
		const evidence = buildCompletionEvidence({
			operation: "preview_evidence",
			result,
			retryKey: "invalid-work-preview",
		});
		expect(evidence.status).toBe("partial");
		expect(evidence.retry.retryable).toBe(true);
	});

	it.each([
		{ ok: false },
		{ error: "preview transport failed" },
		{ canceled: true },
		{ partial: true },
		{ state: "pending" },
	])(
		"keeps generic failure precedence over a valid Work preview shape",
		(override) => {
			const evidence = buildCompletionEvidence({
				operation: "preview_evidence",
				result: {
					status: "available",
					canonicalUri: "artifact://proof",
					mediaType: "text/plain",
					digest: "a".repeat(64),
					text: "preview",
					truncated: false,
					...override,
				},
				retryKey: "work-preview-precedence",
			});
			const expected =
				"canceled" in override
					? "canceled"
					: "partial" in override
						? "partial"
						: "state" in override
							? "pending"
							: "failed";
			expect(evidence.status).toBe(expected);
		},
	);

	it("requires an explicit accepted receipt with a real job id", () => {
		const evidence = buildCompletionEvidence({
			operation: "exec",
			result: { executionId: "fabricated-only" },
			retryKey: "fabricated-only",
		});
		expect(evidence.supportedClaims).not.toContain(
			"the durable job was accepted",
		);
	});

	it("collects array and nested evidence references", () => {
		const evidence = buildCompletionEvidence({
			operation: "read_execution",
			result: {
				executionId: "job-refs",
				terminal: true,
				exitCode: 0,
				artifactRefs: ["r2://bucket/stdout", "r2://bucket/stderr"],
				evidence: {
					traceId: "trace-1",
					checkpoint: { commitOid: "checkpoint-1" },
				},
			},
			retryKey: "job-refs",
		});
		expect(evidence.evidenceRefs).toEqual([
			"job-refs",
			"r2://bucket/stdout",
			"r2://bucket/stderr",
			"trace-1",
			"checkpoint-1",
		]);
		expect(evidence.target).toBe("job-refs");
	});

	it("keeps provider confirmation explicit, bounded, and unknown by default", () => {
		const absent = buildCompletionEvidence({
			operation: "gmail_send",
			result: {
				status: "succeeded",
				id: "must-not-be-inferred",
				evidenceRefs: ["must-not-be-inferred"],
			},
			retryKey: "gmail-send",
		});
		expect(absent.providerConfirmation).toBe("unknown");

		const explicit = buildCompletionEvidence({
			operation: "gmail_send",
			result: { status: "succeeded" },
			retryKey: "gmail-send",
			providerConfirmation: `  gmail-message:${"a".repeat(600)}  `,
		});
		expect(explicit.providerConfirmation).toHaveLength(500);
		expect(explicit.providerConfirmation).toMatch(/^gmail-message:/);
	});

	it("respects authoritative non-retryable failures", () => {
		const evidence = buildCompletionEvidence({
			operation: "read_execution",
			result: {
				ok: false,
				error: "workstation participant is released",
				retryable: false,
			},
			retryKey: "released-job",
		});
		expect(evidence.status).toBe("failed");
		expect(evidence.retry.retryable).toBe(false);
	});

	it("blocks repeated failures with an explicit instruction", () => {
		const result = withCompletionEvidence(
			"deploy",
			{ ok: false, error: "denied" },
			{ key: "deploy:prod", attempts: 2, limit: 2, blocked: true },
		);
		const evidence = CompletionEvidenceSchema.parse(result.completionEvidence);
		expect(evidence.retry).toMatchObject({
			attempts: 2,
			limit: 2,
			blocked: true,
			retryable: false,
		});
		expect(evidence.instruction).toContain("Do not repeat");
	});
});

describe("Code Mode execution receipt", () => {
	it("returns null when the program made no namespaced tool call", () => {
		// Discovery-only or pure computation must stay indistinguishable from the
		// pre-receipt world, or a discovery stall could mint execution evidence.
		expect(buildCodeModeExecutionReceipt([])).toBeNull();
	});

	it("attests execution without ever claiming the task was accomplished", () => {
		const receipt = buildCodeModeExecutionReceipt([
			{ operation: "tedis.list_tedis", status: "succeeded" },
		]);
		expect(receipt?.status).toBe("succeeded");
		expect(receipt?.supportedClaims[0]).toContain("tedis.list_tedis=succeeded");
		expect(receipt?.unsupportedClaims).toContain(
			"the delegated task's goal was achieved",
		);
	});

	it("one failed call fails the whole receipt", () => {
		const receipt = buildCodeModeExecutionReceipt([
			{ operation: "tedis.list_tedis", status: "succeeded" },
			{ operation: "work.claim_work_item", status: "failed" },
		]);
		expect(receipt?.status).toBe("failed");
		expect(receipt?.supportedClaims).toEqual([]);
		expect(receipt?.retry.retryable).toBe(true);
	});

	it("a non-terminal call downgrades the receipt to partial", () => {
		const receipt = buildCodeModeExecutionReceipt([
			{ operation: "tedis.list_tedis", status: "succeeded" },
			{ operation: "workstation.run_job", status: "pending" },
		]);
		expect(receipt?.status).toBe("partial");
		expect(receipt?.unsupportedClaims).toContain(
			"every tool call in this Code Mode program succeeded",
		);
	});
});

it("requires terminal zero-exit evidence for a successful Computer command claim", () => {
	for (const operation of ["exec", "read_execution"]) {
		const complete = buildCompletionEvidence({
			operation,
			result: { executionId: "command-1", terminal: true, exitCode: 0 },
			retryKey: "command-1",
		});
		expect(complete.supportedClaims).toContain(
			"the command completed successfully",
		);
		expect(complete.target).toBe("command-1");
		const incomplete = buildCompletionEvidence({
			operation,
			result: { executionId: "command-1", ok: true },
			retryKey: "command-1",
		});
		expect(incomplete.supportedClaims).not.toContain(
			"the command completed successfully",
		);
	}
	expect(
		buildCompletionEvidence({
			operation: "open_computer",
			result: { ok: true, ready: false },
			retryKey: "open",
		}).status,
	).toBe("pending");
});

import { describe, expect, it } from "vite-plus/test";
import {
	assertCertifiable,
	type BodyCertificationManifest,
	BodyCertificationManifestSchema,
	type BodyExecutionResult,
	BodyExecutionResultSchema,
	DECLARED_BODY_MANIFESTS,
	AGENT_FACET_MANIFEST,
} from "./body-certification";

describe("BodyCertificationManifestSchema", () => {
	it("parses the declared Agent runtime manifest", () => {
		expect(() =>
			BodyCertificationManifestSchema.parse(AGENT_FACET_MANIFEST),
		).not.toThrow();
		expect(DECLARED_BODY_MANIFESTS).toHaveLength(1);
	});

	it("declares the structured Agent runtime voice surface", () => {
		expect(AGENT_FACET_MANIFEST.capabilities.voice).toEqual({
			messages: true,
			browserCall: "experimental",
			telephony: false,
		});
	});

	it("declares the canonical Agent identity and current runtime capabilities", () => {
		expect(AGENT_FACET_MANIFEST.bodyKind).toBe("agent");
		expect(AGENT_FACET_MANIFEST.capabilities).toMatchObject({
			shell: true,
			filesystem: true,
			durableWork: true,
			subagents: true,
		});
	});

	it("declares current Agent runtime certification proof", () => {
		expect(AGENT_FACET_MANIFEST.evidence.smokeName).toBe(
			"body-certification-live-smoke",
		);
		expect(AGENT_FACET_MANIFEST.status).toBe("certified");
		expect(AGENT_FACET_MANIFEST.evidence.lastCertifiedAt).toBe(
			"2026-01-01T00:00:00.000Z",
		);
		expect(AGENT_FACET_MANIFEST.evidence.evalRunId).toBe(
			"hrun_0f0f0f0f-0000-4000-8000-000000000001_validation_0f0f0f0f-0000-4000-8000-000000000002:mcp:0f0f0f0f-0000-4000-8000-000000000003",
		);
		expect(AGENT_FACET_MANIFEST.evidence.proofRefs.length).toBeGreaterThan(0);
	});

	it("rejects a legacy boolean voice capability", () => {
		expect(() =>
			BodyCertificationManifestSchema.parse({
				...AGENT_FACET_MANIFEST,
				capabilities: { ...AGENT_FACET_MANIFEST.capabilities, voice: true },
			}),
		).toThrow();
	});

	it("rejects an invalid browserCall enum value", () => {
		expect(() =>
			BodyCertificationManifestSchema.parse({
				...AGENT_FACET_MANIFEST,
				capabilities: {
					...AGENT_FACET_MANIFEST.capabilities,
					voice: { messages: true, browserCall: "beta", telephony: false },
				},
			}),
		).toThrow();
	});

	it("rejects an invalid canonicalStore enum value", () => {
		expect(() =>
			BodyCertificationManifestSchema.parse({
				...AGENT_FACET_MANIFEST,
				session: { ...AGENT_FACET_MANIFEST.session, canonicalStore: "redis" },
			}),
		).toThrow();
	});
});

describe("BodyExecutionResultSchema", () => {
	const baseResult: BodyExecutionResult = {
		id: "ber_run_1",
		bodyKind: "agent",
		status: "completed",
		runId: "run_1",
		tediId: "tedi_1",
		orgId: "org_1",
		conversationId: "conversation_1",
		sessionKey: "agent:main:main",
		harnessVersionId: "hv_1",
		traceBundleId: "tb_1",
		workstation: null,
		startedAt: "2026-06-12T12:00:00.000Z",
		endedAt: "2026-06-12T12:00:01.000Z",
		durationMs: 1000,
		summary: "Turn completed.",
		structuredResult: { responseKind: "message" },
		error: null,
		usage: {
			provider: "openai",
			model: "gpt-5",
			inputTokens: 10,
			outputTokens: 20,
			reasoningTokens: 0,
			cacheReadTokens: 5,
			cacheWriteTokens: 0,
		},
		cost: {
			pricing: null,
			billingType: "passthrough",
			biller: "openai",
			modelCostUsd: 0.001,
			toolCostUsd: 0,
			totalCostUsd: 0.001,
		},
		session: {
			beforeRef: "ledger:before",
			afterRef: "ledger:after",
			adapterSessionRef: null,
			clearSession: false,
		},
		approvalIds: [],
		artifactIds: ["artifact_1"],
		runtimeServices: ["mcp", "think"],
	};

	it("parses the runtime-neutral body execution result envelope", () => {
		expect(BodyExecutionResultSchema.parse(baseResult)).toEqual(baseResult);
	});

	it("allows identity-less kernel episodes to omit a tedi id", () => {
		expect(
			BodyExecutionResultSchema.parse({
				...baseResult,
				bodyKind: "kernel",
				tediId: null,
			}).tediId,
		).toBeNull();
	});

	it("allows a failed result with error taxonomy and unknown cost", () => {
		expect(() =>
			BodyExecutionResultSchema.parse({
				...baseResult,
				status: "failed",
				endedAt: null,
				durationMs: null,
				error: {
					kind: "runtime",
					message: "gateway unavailable",
					retryable: true,
				},
				cost: {
					pricing: null,
					billingType: "unknown",
					biller: null,
					modelCostUsd: null,
					toolCostUsd: null,
					totalCostUsd: null,
				},
			}),
		).not.toThrow();
	});

	it("rejects non-terminal execution statuses", () => {
		expect(() =>
			BodyExecutionResultSchema.parse({
				...baseResult,
				status: "running",
			}),
		).toThrow();
	});
});

describe("assertCertifiable", () => {
	const certifiedEvidence: BodyCertificationManifest["evidence"] = {
		lastCertifiedAt: "2026-06-12T12:00:00.000Z",
		lastLiveMcpValidationAt: "2026-06-12T12:00:00.000Z",
		lastLiveMcpValidationSurface: "kernel+tedi-mcp",
		smokeName: "agent-chat-smoke",
		evalRunId: "her_eval_run_1",
		traceBundleId: "tb_run_1",
		proofRefs: [
			{
				kind: "smoke",
				id: "agent-chat-smoke",
				description: "Body certification smoke passed.",
				status: "passed",
				surface: "live smoke",
				observedAt: "2026-06-12T12:00:00.000Z",
			},
			{
				kind: "mcp_validation",
				id: "live-mcp-validation-1",
				description: "Kernel and tedi MCP validation passed.",
				status: "passed",
				surface: "kernel+tedi-mcp",
				observedAt: "2026-06-12T12:00:00.000Z",
			},
			{
				kind: "eval_run",
				id: "her_eval_run_1",
				description: "Harness eval run passed certification thresholds.",
				status: "passed",
				surface: "harness_eval_runs",
				observedAt: "2026-06-12T12:00:00.000Z",
			},
			{
				kind: "trace_bundle",
				id: "tb_run_1",
				description: "Trace bundle captured the certified body episode.",
				status: "passed",
				surface: "harness_trace_bundle",
				observedAt: "2026-06-12T12:00:00.000Z",
			},
		],
	};

	it("passes all declared manifests against their current gate state", () => {
		expect(() => assertCertifiable(AGENT_FACET_MANIFEST)).not.toThrow();
		for (const manifest of DECLARED_BODY_MANIFESTS) {
			expect(() => assertCertifiable(manifest)).not.toThrow();
		}
	});

	it("passes a certified manifest that meets every load-bearing gate", () => {
		// Promote the isolate facet to certified with all gates green.
		const certified: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			status: "certified",
			events: { ...AGENT_FACET_MANIFEST.events, compaction: true },
			telemetry: { ...AGENT_FACET_MANIFEST.telemetry, costUsd: true },
			evidence: certifiedEvidence,
		};
		expect(() => assertCertifiable(certified)).not.toThrow();
	});

	it("throws when a certified manifest is missing a load-bearing gate", () => {
		const broken: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			status: "certified",
			session: { ...AGENT_FACET_MANIFEST.session, cacheLossRecovery: false },
			evidence: certifiedEvidence,
		};
		expect(() => assertCertifiable(broken)).toThrow(
			/session\.cacheLossRecovery/,
		);
	});

	it("throws when a certified body persists session to body-local store", () => {
		const broken: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			status: "certified",
			session: {
				...AGENT_FACET_MANIFEST.session,
				canonicalStore: "body-local",
			},
			evidence: certifiedEvidence,
		};
		expect(() => assertCertifiable(broken)).toThrow(/canonicalStore/);
	});

	it("throws when a certified body lacks live proof references", () => {
		const broken: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			status: "certified",
			events: { ...AGENT_FACET_MANIFEST.events, compaction: true },
			telemetry: { ...AGENT_FACET_MANIFEST.telemetry, costUsd: true },
			evidence: {
				...AGENT_FACET_MANIFEST.evidence,
				lastCertifiedAt: null,
				lastLiveMcpValidationAt: null,
				evalRunId: null,
				traceBundleId: null,
				proofRefs: [],
			},
		};
		expect(() => assertCertifiable(broken)).toThrow(/evidence/);
	});

	it("throws when a certified body's proof refs do not match the evidence ids", () => {
		const broken: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			status: "certified",
			events: { ...AGENT_FACET_MANIFEST.events, compaction: true },
			telemetry: { ...AGENT_FACET_MANIFEST.telemetry, costUsd: true },
			evidence: {
				...certifiedEvidence,
				evalRunId: "her_eval_run_missing",
			},
		};
		expect(() => assertCertifiable(broken)).toThrow(/eval_run/);
	});

	it("throws when a certified approval-capable body does not default-deny", () => {
		const broken: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			status: "certified",
			events: { ...AGENT_FACET_MANIFEST.events, compaction: true },
			telemetry: { ...AGENT_FACET_MANIFEST.telemetry, costUsd: true },
			approvals: { model: "first-class", timeoutBehavior: "allow" },
			evidence: certifiedEvidence,
		};
		expect(() => assertCertifiable(broken)).toThrow(/timeoutBehavior/);
	});

	it("rejects a certified body with body-local session state", () => {
		const broken: BodyCertificationManifest = {
			...AGENT_FACET_MANIFEST,
			session: {
				...AGENT_FACET_MANIFEST.session,
				harnessRead: false,
				harnessWrite: false,
				canonicalStore: "body-local",
				cacheLossRecovery: false,
			},
			status: "certified",
		};
		expect(() => assertCertifiable(broken)).toThrow(/load-bearing gates/);
	});
});

import { describe, expect, it } from "vite-plus/test";
import {
	bodyExecutionDurationMs,
	buildBodyExecutionResult,
	defaultBodyExecutionCost,
	defaultBodyExecutionSession,
	defaultBodyExecutionUsage,
} from "./body-execution-result";

describe("body execution result helpers", () => {
	it("builds the certified body envelope with shared defaults", () => {
		const result = buildBodyExecutionResult({
			bodyKind: "agent",
			status: "completed",
			runId: "run-1",
			tediId: "tedi-1",
			orgId: "org-1",
			conversationId: "agent:main:qa",
			sessionKey: "agent:main:qa",
			harnessVersionId: "hv-1",
			traceBundleId: "run-1:bundle",
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: "2026-06-13T10:00:02.500Z",
			structuredResult: { outcome: "success" },
			runtimeServices: ["cloudflare-agents"],
		});

		expect(result).toMatchObject({
			id: "run-1:bundle:body-execution-result",
			bodyKind: "agent",
			status: "completed",
			durationMs: 2500,
			usage: {
				provider: null,
				model: null,
				inputTokens: null,
				outputTokens: null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			},
			cost: {
				billingType: "unknown",
				biller: null,
				modelCostUsd: null,
				toolCostUsd: null,
				totalCostUsd: null,
			},
			session: {
				beforeRef: null,
				afterRef: null,
				adapterSessionRef: null,
				clearSession: false,
			},
			workstation: null,
			approvalIds: [],
			artifactIds: [],
		});
	});

	it("preserves explicit ids, telemetry, and session refs", () => {
		const result = buildBodyExecutionResult({
			id: "custom-result",
			bodyKind: "kernel",
			status: "blocked",
			runId: "home-run-1",
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: null,
			durationMs: 42,
			usage: { provider: "openai", inputTokens: 12 },
			cost: { billingType: "passthrough", totalCostUsd: 0.01 },
			session: {
				beforeRef: "before",
				afterRef: "after",
				adapterSessionRef: "adapter",
				clearSession: true,
			},
			approvalIds: ["approval-1"],
			artifactIds: ["artifact-1"],
		});

		expect(result.id).toBe("custom-result");
		expect(result.durationMs).toBe(42);
		expect(result.usage).toMatchObject({
			provider: "openai",
			inputTokens: 12,
			outputTokens: null,
		});
		expect(result.cost).toMatchObject({
			billingType: "passthrough",
			totalCostUsd: 0.01,
		});
		expect(result.session).toEqual({
			beforeRef: "before",
			afterRef: "after",
			adapterSessionRef: "adapter",
			clearSession: true,
		});
		expect(result.approvalIds).toEqual(["approval-1"]);
		expect(result.artifactIds).toEqual(["artifact-1"]);
	});

	it("preserves workstation evidence for capability-backed body turns", () => {
		const result = buildBodyExecutionResult({
			bodyKind: "agent",
			status: "completed",
			runId: "run-workstation-1",
			traceBundleId: "run-workstation-1:bundle",
			workstation: {
				profileId: "general",
				workstationId: "ws_1",
				leaseId: "lease_1",
				sessionId: "session_1",
				participantIds: ["participant_cto"],
			},
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: "2026-06-13T10:00:01.000Z",
		});

		expect(result.workstation).toEqual({
			profileId: "general",
			workstationId: "ws_1",
			leaseId: "lease_1",
			sessionId: "session_1",
			participantIds: ["participant_cto"],
		});
	});

	it("handles invalid or reversed timestamps conservatively", () => {
		expect(
			bodyExecutionDurationMs({
				startedAt: "2026-06-13T10:00:03.000Z",
				endedAt: "2026-06-13T10:00:00.000Z",
			}),
		).toBe(0);
		expect(
			bodyExecutionDurationMs({
				startedAt: "not-a-date",
				endedAt: "2026-06-13T10:00:00.000Z",
			}),
		).toBeNull();
		expect(
			bodyExecutionDurationMs({ startedAt: null, endedAt: null }),
		).toBeNull();
	});

	it("exposes default helpers for call sites that need partial composition", () => {
		expect(defaultBodyExecutionUsage({ model: "gpt-5" }).model).toBe("gpt-5");
		expect(defaultBodyExecutionCost({ biller: "tedix" }).billingType).toBe(
			"unknown",
		);
		expect(
			defaultBodyExecutionSession({ adapterSessionRef: "agent:main" }),
		).toEqual({
			beforeRef: null,
			afterRef: null,
			adapterSessionRef: "agent:main",
			clearSession: false,
		});
	});
});

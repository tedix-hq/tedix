import { describe, expect, it, vi } from "vite-plus/test";
import {
	assembleKernelTraceBundleFiles,
	kernelTraceBundleRetentionExpiresAt,
	kernelTraceBundlePrefix,
	writeKernelTraceBundle,
} from "./kernel-trace-bundle-writer";

const evidence = {
	organizationId: "org-1",
	conversationId: "conversation-1",
	runId: "widget:run-1",
	harnessVersionId: "version-1",
	createdAt: "2026-09-03T00:00:00.000Z",
	traceInput: {
		provider: "azure.chat",
		model: "gpt-5.6-luna",
		systemPrompt: "System with Authorization: Bearer secret-value",
		userPrompt: "password=not-for-storage",
		requestShape: "prompt" as const,
		truncated: false,
		mediaOmitted: false,
		messages: [{ role: "user", content: "password=not-for-storage" }],
	},
	assistantText: "Safe answer",
	route: { routeKind: "answer_in_home", rationale: "Safe rationale" },
	contextManifest: { version: 1, inputTokens: 42 },
	bodyExecutionResult: {
		id: "result-1",
		bodyKind: "kernel" as const,
		status: "completed" as const,
		runId: "widget:run-1",
		tediId: null,
		orgId: "org-1",
		conversationId: "conversation-1",
		sessionKey: "conversation-1",
		harnessVersionId: "version-1",
		traceBundleId: "widget:run-1:bundle",
		workstation: null,
		startedAt: "2026-09-03T00:00:00.000Z",
		endedAt: "2026-09-03T00:00:01.000Z",
		durationMs: 1000,
		summary: "Safe answer",
		structuredResult: {},
		error: null,
		usage: {
			provider: "azure.chat",
			model: "gpt-5.6-luna",
			inputTokens: 42,
			outputTokens: 10,
			reasoningTokens: 4,
			cacheReadTokens: 0,
			cacheWriteTokens: 40,
		},
		cost: null,
		session: {
			beforeRef: null,
			afterRef: "kernel_runtime_runs:widget:run-1",
			adapterSessionRef: null,
			clearSession: false,
		},
		approvalIds: [],
		artifactIds: [],
		runtimeServices: ["kernel-runtime"],
	},
	outcome: "success" as const,
};

describe("kernel trace bundle writer", () => {
	it("assembles replayable Kernel evidence without hidden reasoning text", () => {
		const files = assembleKernelTraceBundleFiles(evidence);
		expect(files.map((file) => file.name)).toEqual([
			"manifest.json",
			"prompt.json",
			"context-manifest.json",
			"route.json",
			"output.md",
			"outcome.json",
		]);
		expect(JSON.stringify(files)).not.toContain("reasoningText");
		expect(JSON.stringify(files)).toContain('"reasoningTokens":4');
	});

	it("redacts every file before writing and returns the durable folder URI", async () => {
		const put = vi.fn(async () => undefined);
		const uri = await writeKernelTraceBundle({
			bucket: { put } as unknown as R2Bucket,
			evidence,
		});
		expect(uri).toBe(
			"r2://tedix-tedi-production/kernel/org-1/harness/runs/widget:run-1/",
		);
		expect(put).toHaveBeenCalledTimes(6);
		const written = put.mock.calls.map((call) => String(call[1])).join("\n");
		expect(written).not.toContain("secret-value");
		expect(written).not.toContain("not-for-storage");
		expect(written).toContain("__TEDIX_REDACTED__");
		const prompt = JSON.parse(String(put.mock.calls[1]?.[1]));
		expect(prompt.request).toMatchObject({
			provider: "azure.chat",
			model: "gpt-5.6-luna",
			shape: "prompt",
			truncated: false,
			mediaOmitted: false,
		});
	});

	it("returns null when no R2 object can be written", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const bucket = {
			put: vi.fn(async () => {
				throw new Error("R2 unavailable: password=not-for-storage");
			}),
		} as unknown as R2Bucket;
		await expect(
			writeKernelTraceBundle({ bucket, evidence }),
		).resolves.toBeNull();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("not-for-storage");
		warn.mockRestore();
	});

	it("does not index a partial folder when the prompt file fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const put = vi.fn(async (key: string) => {
			if (key.endsWith("/prompt.json")) throw new Error("R2 unavailable");
		});
		await expect(
			writeKernelTraceBundle({
				bucket: { put } as unknown as R2Bucket,
				evidence,
			}),
		).resolves.toBeNull();
		expect(put).toHaveBeenCalledTimes(6);
		warn.mockRestore();
	});

	it("uses an org-scoped prefix for the identity-less Kernel", () => {
		expect(kernelTraceBundlePrefix("org-1", "run-1")).toBe(
			"kernel/org-1/harness/runs/run-1",
		);
	});

	it("stamps a deterministic 30-day retention deadline", () => {
		expect(kernelTraceBundleRetentionExpiresAt(evidence.createdAt)).toBe(
			"2026-10-03T00:00:00.000Z",
		);
		expect(assembleKernelTraceBundleFiles(evidence)[0]?.content).toMatchObject({
			retentionExpiresAt: "2026-10-03T00:00:00.000Z",
		});
	});
});

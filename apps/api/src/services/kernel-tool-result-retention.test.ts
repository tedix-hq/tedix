import * as queries from "@tedix/db/queries/kernel-tool-results";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	KERNEL_TOOL_RESULT_AUXILIARY_DEADLINE_MS,
	literalSearch,
	retainKernelToolResult,
	utf8Page,
} from "./kernel-tool-result-retention";

vi.mock("@tedix/db/queries/kernel-tool-results", () => ({
	KERNEL_TOOL_RESULT_MAX_BYTES: 1024 * 1024,
	deleteEvictedKernelToolResult: vi.fn(),
	getKernelToolResultById: vi.fn(),
	getReadableKernelToolResult: vi.fn(),
	getReadableKernelToolResultBySource: vi.fn(),
	insertKernelToolResultWithRetention: vi.fn(),
	listKernelToolResultsForCleanup: vi.fn(),
}));

const canonical = {
	id: "4a057a3c-1e35-46d5-8909-320aa6cfbd55",
	organizationId: "org",
	conversationId: "home:one",
	runId: "run",
	sourceKind: "approved_write" as const,
	sourceId: "approval",
	objectKey: "home-tool-results/org/canonical",
	sha256: "a".repeat(64),
	byteSize: 12,
	contentType: "application/json",
	createdAt: "2026-09-22T00:00:00.000Z",
	expiresAt: "2026-09-23T00:00:00.000Z",
	evictedAt: null,
	evictionReason: null,
};

function input(bucket: R2Bucket) {
	return {
		db: {} as never,
		bucket,
		organizationId: "org",
		conversationId: "home:one",
		runId: "run",
		sourceKind: "approved_write" as const,
		sourceId: "approval",
		value: { ok: true },
		now: new Date("2026-09-22T00:00:00.000Z"),
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("retainKernelToolResult", () => {
	it("returns the existing canonical source without uploading a retry", async () => {
		vi.mocked(queries.getReadableKernelToolResultBySource).mockResolvedValue(
			canonical,
		);
		const put = vi.fn();
		const result = await retainKernelToolResult(input({ put } as never));
		expect(result).toEqual({
			id: canonical.id,
			sha256: canonical.sha256,
			byteSize: canonical.byteSize,
			expiresAt: canonical.expiresAt,
		});
		expect(put).not.toHaveBeenCalled();
	});

	it("recovers an ambiguous committed insert by its exact generated id", async () => {
		let candidate:
			| Parameters<typeof queries.insertKernelToolResultWithRetention>[1]
			| null = null;
		vi.mocked(queries.insertKernelToolResultWithRetention).mockImplementation(
			async (_db, value) => {
				candidate = value;
				throw new Error("D1 timeout");
			},
		);
		const put = vi.fn(async () => ({}));
		vi.mocked(queries.getReadableKernelToolResultBySource).mockResolvedValue(
			null,
		);
		vi.mocked(queries.getKernelToolResultById).mockImplementation(async () => ({
			...canonical,
			...(candidate ?? {}),
			evictedAt: null,
			evictionReason: null,
		}));
		const result = await retainKernelToolResult(input({ put } as never));
		expect(result?.id).toBe(candidate?.id);
		expect(result?.sha256).toBe(candidate?.sha256);
	});

	it("returns the prior canonical source after a duplicate-source conflict", async () => {
		vi.mocked(queries.getReadableKernelToolResultBySource)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(canonical);
		vi.mocked(queries.insertKernelToolResultWithRetention).mockRejectedValue(
			new Error("unique source"),
		);
		vi.mocked(queries.getKernelToolResultById).mockResolvedValue(null);
		expect(
			await retainKernelToolResult(
				input({ put: vi.fn(async () => ({})) } as never),
			),
		).toMatchObject({ id: canonical.id, sha256: canonical.sha256 });
	});

	it("returns no reference when deletion wins before the conditional insert", async () => {
		vi.mocked(queries.getReadableKernelToolResultBySource).mockResolvedValue(
			null,
		);
		vi.mocked(queries.insertKernelToolResultWithRetention).mockRejectedValue(
			new Error("conversation is unavailable"),
		);
		vi.mocked(queries.getKernelToolResultById).mockResolvedValue(null);
		expect(
			await retainKernelToolResult(
				input({ put: vi.fn(async () => ({})) } as never),
			),
		).toBeNull();
	});

	it("does not return a reference when the new row evicts itself", async () => {
		vi.mocked(queries.getReadableKernelToolResultBySource).mockResolvedValue(
			null,
		);
		vi.mocked(queries.insertKernelToolResultWithRetention).mockImplementation(
			async (_db, value) => ({
				result: { ...canonical, ...value },
				evicted: [
					{
						id: value.id,
						objectKey: value.objectKey,
						sha256: value.sha256,
						evictedAt: value.now,
					},
				],
			}),
		);
		vi.mocked(queries.deleteEvictedKernelToolResult).mockResolvedValue(true);
		const bucket = {
			put: vi.fn(async () => ({})),
			delete: vi.fn(async () => undefined),
		};
		expect(
			await retainKernelToolResult(input(bucket as unknown as R2Bucket)),
		).toBeNull();
		expect(bucket.delete).toHaveBeenCalledOnce();
	});

	it("returns on the auxiliary deadline while late storage remains lifecycle bounded", async () => {
		vi.useFakeTimers();
		vi.mocked(queries.getReadableKernelToolResultBySource).mockResolvedValue(
			null,
		);
		const result = retainKernelToolResult(
			input({ put: vi.fn(() => new Promise(() => undefined)) } as never),
		);
		await vi.advanceTimersByTimeAsync(KERNEL_TOOL_RESULT_AUXILIARY_DEADLINE_MS);
		await expect(result).resolves.toBeNull();
	});
});

describe("retained result text windows", () => {
	it("pages by Unicode code points without exceeding the byte ceiling", () => {
		expect(utf8Page("A😀B", 1, 4)).toEqual({
			content: "😀",
			nextOffset: 2,
		});
	});

	it("searches literally rather than treating input as a pattern", () => {
		expect(literalSearch("before .* after", ".*", 0)).toMatchObject({
			content: ".* after",
			matchOffset: 7,
		});
		expect(literalSearch("no match", "[a-z]", 0).matchOffset).toBeNull();
		const adversarial = `${"a".repeat(500_000)}b`;
		expect(
			literalSearch(adversarial, `${"a".repeat(10_000)}b`, 0).matchOffset,
		).toBe(490_000);
	});
});

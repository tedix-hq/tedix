import { describe, expect, it } from "vite-plus/test";
import {
	AUDIT_METADATA_INLINE_BYTES,
	auditBodyKey,
	spillAuditMetadata,
	splitAuditMetadata,
} from "./audit-metadata-spill";

const KEY = auditBodyKey("org-fictional-lighthouse", "audit-1");

describe("splitAuditMetadata", () => {
	it("keeps metadata within the inline budget untouched", () => {
		const metadata = { clientId: "client-1", durationMs: 12, ok: true };
		expect(splitAuditMetadata(metadata, KEY)).toEqual({
			inline: metadata,
			body: null,
		});
	});

	it("keeps short scalars and points at the body for the rest", () => {
		const metadata = {
			clientId: "client-1",
			executionId: "exec-1",
			durationMs: 12,
			result: "x".repeat(AUDIT_METADATA_INLINE_BYTES),
			arguments: { query: "y".repeat(300) },
			nothing: null,
		};
		const split = splitAuditMetadata(metadata, KEY);
		expect(split.body).toBe(JSON.stringify(metadata));
		expect(split.inline).toEqual({
			clientId: "client-1",
			executionId: "exec-1",
			durationMs: 12,
			nothing: null,
			bodyKey: KEY,
			bodyBytes: new TextEncoder().encode(split.body ?? "").byteLength,
			bodyKeys: ["result", "arguments"],
		});
	});
});

describe("spillAuditMetadata", () => {
	const large = { clientId: "client-1", result: "x".repeat(5000) };

	it("writes the body before returning the pointer row", async () => {
		const objects = new Map<string, string>();
		const bucket = {
			put: async (key: string, value: string) => {
				objects.set(key, value);
			},
		} as unknown as R2Bucket;
		const stored = await spillAuditMetadata(large, {
			bucket,
			organizationId: "org-fictional-lighthouse",
			auditId: "audit-1",
		});
		expect(stored.bodyKey).toBe(KEY);
		expect(stored.result).toBeUndefined();
		expect(objects.get(KEY)).toBe(JSON.stringify(large));
	});

	it("stores inline without a bucket or when the write fails", async () => {
		expect(
			await spillAuditMetadata(large, {
				organizationId: "org-fictional-lighthouse",
				auditId: "audit-1",
			}),
		).toBe(large);
		expect(
			await spillAuditMetadata(large, {
				bucket: {
					put: async () => {
						throw new Error("unavailable");
					},
				} as unknown as R2Bucket,
				organizationId: "org-fictional-lighthouse",
				auditId: "audit-1",
			}),
		).toBe(large);
	});
});

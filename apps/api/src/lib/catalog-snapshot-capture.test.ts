import { describe, expect, it } from "vite-plus/test";
import { CatalogSnapshotSchema } from "@tedix/api-contract/schemas/catalog-snapshot";
import { assertSnapshotCaptureUrl } from "./catalog-snapshot-capture";
const item = {
	source: "chatgpt",
	sourceAppId: "a",
	name: "A",
	connectorType: "MCP",
	developerType: "THIRD_PARTY",
};
describe("supplier snapshot boundary", () => {
	it("rejects an incomplete capture before catalog writes", () => {
		expect(() =>
			CatalogSnapshotSchema.parse({
				expectedSourceCount: 200,
				capturedSourceCount: 20,
				items: [item],
			}),
		).toThrow("incomplete");
	});
	it("rejects duplicate store identities, permits a cross-store match", () => {
		expect(() =>
			CatalogSnapshotSchema.parse({
				expectedSourceCount: 2,
				capturedSourceCount: 2,
				items: [item, item],
			}),
		).toThrow("Duplicate");
		expect(
			CatalogSnapshotSchema.parse({
				expectedSourceCount: 1,
				capturedSourceCount: 1,
				items: [item, { ...item, source: "claude" }],
			}).items,
		).toHaveLength(2);
	});
	it("rejects empty snapshots and unknown normalized fields", () => {
		expect(() =>
			CatalogSnapshotSchema.parse({
				expectedSourceCount: 0,
				capturedSourceCount: 0,
				items: [],
			}),
		).toThrow();
		expect(() =>
			CatalogSnapshotSchema.parse({
				expectedSourceCount: 1,
				capturedSourceCount: 1,
				items: [{ ...item, admin: true }],
			}),
		).toThrow();
	});
	it("rejects credentialed, private and platform origins", () => {
		for (const url of [
			"http://example.com",
			"https://127.1/",
			"https://169.254.169.254",
			"https://api.tedix.dev",
			"https://user:password@example.com",
		])
			expect(() => assertSnapshotCaptureUrl(url)).toThrow();
		expect(assertSnapshotCaptureUrl("https://example.com/path")).toBe(
			"https://example.com",
		);
	});
});

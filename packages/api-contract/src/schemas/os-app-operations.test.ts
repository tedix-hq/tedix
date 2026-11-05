import { describe, expect, it } from "vite-plus/test";
import { AppRuntimePublicOperationSchema } from "./os-app-runtime";
import { OsGadgetManifestWriteSchema } from "./os-workspaces";

const operation = {
	name: "count",
	description: "Count cards in the sheet",
	input: {
		type: "object",
		properties: { status: { type: "string", enum: ["open", "done"] } },
		required: ["status"],
		additionalProperties: false,
	},
	effect: "read",
	outputSlot: "cards",
};
const manifest = {
	entry: "tedix:runtime/v1",
	config: { version: 1 },
	resourceGrants: [{ slot: "cards", operations: ["outputs.read"] }],
	operations: [operation],
};

describe("runtime app operation declarations", () => {
	it("preserves operation schemas and accepts existing apps without declarations", () => {
		expect(OsGadgetManifestWriteSchema.parse(manifest).operations).toEqual([
			operation,
		]);
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				entry: manifest.entry,
				config: { version: 1 },
			}).success,
		).toBe(true);
	});
	it.each(["constructor", "alarm", "webSocketMessage", "invalid_name"])(
		"rejects private or invalid method %s",
		(name) => {
			expect(
				AppRuntimePublicOperationSchema.safeParse({ ...operation, name })
					.success,
			).toBe(false);
		},
	);
	it.each([
		{ input: { type: "array" } },
		{ input: { type: "array", properties: {} } },
		{ input: { type: "object", if: { type: "object" }, then: {} } },
		{ input: { type: "object", $ref: "https://example.test/schema" } },
		{ input: { type: "object", description: "x".repeat(16000) } },
		{ effect: "execute" },
	])("rejects unusable input schemas and invalid effects: %j", (override) => {
		expect(
			AppRuntimePublicOperationSchema.safeParse({ ...operation, ...override })
				.success,
		).toBe(false);
	});
	it("rejects duplicate names, non-runtime declarations and missing Output grants", () => {
		for (const invalid of [
			{ ...manifest, operations: [operation, operation] },
			{ ...manifest, entry: "widget:test" },
			{ ...manifest, resourceGrants: [] },
			{
				...manifest,
				resourceGrants: [{ slot: "other", operations: ["outputs.read"] }],
			},
			{ ...manifest, operations: [{ ...operation, effect: "write" }] },
		])
			expect(OsGadgetManifestWriteSchema.safeParse(invalid).success).toBe(
				false,
			);
	});
	it("accepts Output writes with patch grants and methods without an Output slot", () => {
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				...manifest,
				resourceGrants: [{ slot: "cards", operations: ["outputs.patch"] }],
				operations: [{ ...operation, effect: "write" }],
			}).success,
		).toBe(true);
		const { outputSlot: _slot, ...local } = operation;
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				...manifest,
				resourceGrants: [],
				operations: [local],
			}).success,
		).toBe(true);
	});
});

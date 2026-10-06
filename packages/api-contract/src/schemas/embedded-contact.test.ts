import { describe, expect, it } from "vite-plus/test";
import {
	EmbeddedContactAttributesSchema,
	EmbeddedContactProfilePatchSchema,
} from "./embedded-contact";
describe("embedded contact profile contract", () => {
	it("retains sparse clear/false/zero semantics", () => {
		expect(
			EmbeddedContactProfilePatchSchema.parse({
				user: {
					name: null,
					customAttributes: { active: false, amount: 0, remove: null },
				},
			}),
		).toEqual({
			user: {
				name: null,
				customAttributes: { active: false, amount: 0, remove: null },
			},
		});
	});
	it("rejects nested attributes and reserved authority keys", () => {
		for (const value of [
			{ nested: {} },
			{ scopes: "*" },
			{ hostUserId: "other" },
			{ constructor: "bad" },
		])
			expect(EmbeddedContactAttributesSchema.safeParse(value).success).toBe(
				false,
			);
		expect(
			EmbeddedContactProfilePatchSchema.safeParse({ user: { id: "other" } })
				.success,
		).toBe(false);
	});
	it("bounds key count, values, number and encoded payload size", () => {
		for (const value of [
			Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, i])),
			{ big: "x".repeat(501) },
			{ number: Infinity },
			Object.fromEntries(
				Array.from({ length: 20 }, (_, i) => [`key${i}`, "é".repeat(500)]),
			),
		])
			expect(EmbeddedContactAttributesSchema.safeParse(value).success).toBe(
				false,
			);
	});
});

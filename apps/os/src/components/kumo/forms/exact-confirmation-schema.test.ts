import { describe, expect, it } from "vite-plus/test";
import { exactConfirmationSchema } from "./exact-confirmation-schema";

describe("exactConfirmationSchema", () => {
	it("accepts only the exact visible identifier", () => {
		const schema = exactConfirmationSchema("Tedix", "Organization name");

		expect(schema.parse({ confirmation: "Tedix" })).toEqual({
			confirmation: "Tedix",
		});
		expect(schema.safeParse({ confirmation: "tedix" }).success).toBe(false);
		expect(schema.safeParse({ confirmation: " Tedix " }).success).toBe(false);
	});

	it("returns the caller-owned mismatch label", () => {
		const result = exactConfirmationSchema("docs", "Site slug").safeParse({
			confirmation: "wrong",
		});

		expect(result.error?.issues[0]?.message).toBe("Site slug does not match.");
	});
});

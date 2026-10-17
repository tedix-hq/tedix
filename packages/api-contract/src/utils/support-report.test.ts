import { describe, expect, it } from "vite-plus/test";
import {
	redactSupportReport,
	redactSupportText,
	supportObjectId,
	supportPayloadDigest,
} from "./support-report";
import { SupportReportSchema } from "../schemas/support";
describe("support payload preview", () => {
	it("removes credential headers, query strings, fragments and URL userinfo before digesting", async () => {
		const report = SupportReportSchema.parse({
			title: "Connection failure",
			expected: "Connect",
			actual:
				"Authorization: Bearer example-secret\nVisit https://user:pass@example.invalid/path?token=secret#private",
			observedAt: "2026-10-17T10:00:00Z",
			origin: "agent",
		});
		const clean = redactSupportReport(report);
		expect(clean.actual).toBe(
			"Authorization: [removed]\nVisit https://example.invalid/path",
		);
		expect(await supportPayloadDigest(clean)).not.toBe(
			await supportPayloadDigest(report),
		);
		expect(await supportPayloadDigest(clean)).toBe(
			await supportPayloadDigest(redactSupportReport(clean)),
		);
	});
	it("redacts common token formats and scopes stable IDs to the tenant", async () => {
		const syntheticToken = ["ghp", "synthetic".repeat(3)].join("_");
		expect(redactSupportText(`${syntheticToken} Bearer abc.def.ghi`)).toBe(
			"[token removed] [credential removed]",
		);
		expect(await supportObjectId("tenant-a:key")).not.toBe(
			await supportObjectId("tenant-b:key"),
		);
		expect(await supportObjectId("tenant-a:key")).toBe(
			await supportObjectId("tenant-a:key"),
		);
	});
});

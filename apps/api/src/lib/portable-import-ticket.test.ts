import { describe, expect, it } from "vite-plus/test";
import {
	issuePortableImportTicket,
	verifyPortableImportTicket,
} from "./portable-import-ticket";

const organizationId = "11111111-1111-4111-8111-111111111111";
const tediId = "22222222-2222-4222-8222-222222222222";
const sourceTediId = "33333333-3333-4333-8333-333333333333";
const manifestSha256 = "a".repeat(64);
const nowMs = Date.parse("2026-09-28T03:00:00Z");

describe("portable import ticket", () => {
	it("binds write access to one destination and manifest", async () => {
		const issued = await issuePortableImportTicket({
			secret: "test-master-key",
			organizationId,
			tediId,
			sourceTediId,
			manifestSha256,
			nowMs,
		});
		expect(
			await verifyPortableImportTicket({
				secret: "test-master-key",
				token: issued.token,
				nowMs,
			}),
		).toEqual({ organizationId, tediId, sourceTediId, manifestSha256 });
		expect(
			await verifyPortableImportTicket({
				secret: "test-master-key",
				token: issued.token.replace(manifestSha256, "b".repeat(64)),
				nowMs,
			}),
		).toBeNull();
		expect(
			await verifyPortableImportTicket({
				secret: "test-master-key",
				token: issued.token,
				nowMs: Date.parse(issued.expiresAt),
			}),
		).toBeNull();
	});
});

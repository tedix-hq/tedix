import { describe, expect, it } from "vite-plus/test";
import {
	issuePortableSnapshotTicket,
	verifyPortableSnapshotTicket,
} from "./portable-snapshot-ticket";

const organizationId = "11111111-1111-4111-8111-111111111111";
const tediId = "22222222-2222-4222-8222-222222222222";
const nowMs = Date.parse("2026-09-28T03:00:00Z");

describe("portable snapshot ticket", () => {
	it("binds an expiring bearer to the exact organization and tedi", async () => {
		const issued = await issuePortableSnapshotTicket({
			secret: "test-master-key",
			organizationId,
			tediId,
			nowMs,
		});
		expect(
			await verifyPortableSnapshotTicket({
				secret: "test-master-key",
				token: issued.token,
				nowMs,
			}),
		).toEqual({ organizationId, tediId });
		expect(
			await verifyPortableSnapshotTicket({
				secret: "test-master-key",
				token: issued.token.replace(tediId, organizationId),
				nowMs,
			}),
		).toBeNull();
		expect(
			await verifyPortableSnapshotTicket({
				secret: "test-master-key",
				token: issued.token,
				nowMs: Date.parse(issued.expiresAt),
			}),
		).toBeNull();
	});
});

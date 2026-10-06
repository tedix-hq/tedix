import { describe, expect, it } from "vite-plus/test";
import {
	snapshotFenceFromOutboundParams,
	snapshotMatches,
	type WorkstationResumeSnapshot,
} from "./snapshot-resume";

const fence = {
	leaseId: "lease-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	workstationId: "workstation-1",
	workItemId: "work-1",
};
const snapshot = {
	createdAt: "2026-10-01T00:00:00.000Z",
	expiresAt: "2026-10-30T00:00:00.000Z",
	fence,
	image: "registry/image@sha256:one",
	snapshot: { id: "snapshot-1", size: 1 },
} satisfies WorkstationResumeSnapshot;

describe("native workstation snapshot fences", () => {
	it("extracts only complete trusted lease context", () => {
		expect(snapshotFenceFromOutboundParams(fence)).toEqual(fence);
		expect(
			snapshotFenceFromOutboundParams({ ...fence, leaseId: "" }),
		).toBeNull();
		expect(
			snapshotFenceFromOutboundParams({ ...fence, organizationId: undefined }),
		).toBeNull();
	});

	it("restores only the same lease, tenant, tedi, work item and image", () => {
		expect(
			snapshotMatches(snapshot, {
				fence,
				image: snapshot.image,
				now: Date.parse("2026-10-02T00:00:00.000Z"),
			}),
		).toBe(true);
		for (const changed of [
			{ leaseId: "lease-2" },
			{ organizationId: "org-2" },
			{ tediId: "tedi-2" },
			{ workstationId: "workstation-2" },
			{ workItemId: "work-2" },
		])
			expect(
				snapshotMatches(snapshot, {
					fence: { ...fence, ...changed },
					image: snapshot.image,
					now: Date.parse("2026-10-02T00:00:00.000Z"),
				}),
			).toBe(false);
		expect(
			snapshotMatches(snapshot, {
				fence,
				image: "registry/image@sha256:two",
				now: Date.parse("2026-10-02T00:00:00.000Z"),
			}),
		).toBe(false);
	});

	it("rejects a snapshot at or beyond its safety expiry", () => {
		expect(
			snapshotMatches(snapshot, {
				fence,
				image: snapshot.image,
				now: Date.parse(snapshot.expiresAt),
			}),
		).toBe(false);
	});
});

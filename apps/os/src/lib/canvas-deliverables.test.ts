import type { OsOutputLibraryItem } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	byUpdatedAtDesc,
	deliveryBadgeLabel,
	deliveryState,
	groupDeliverables,
	matchesStateFilter,
	outputStateCounts,
} from "./canvas-deliverables";

type Delivery = {
	status: "candidate" | "approved" | "rejected";
	verdict?: "pass" | "revise" | "reject";
	score?: number;
};

function videoItem(
	id: string,
	updatedAt: string,
	delivery: Delivery | undefined,
	status: "active" | "archived" = "active",
): OsOutputLibraryItem {
	return {
		output: {
			id,
			kind: "video",
			title: `video ${id}`,
			status,
			updatedAt,
		},
		preview: { kind: "video", mimeType: "video/mp4", delivery },
	} as unknown as OsOutputLibraryItem;
}

function docItem(
	id: string,
	updatedAt: string,
	status: "active" | "archived" = "active",
): OsOutputLibraryItem {
	return {
		output: { id, kind: "document", title: `doc ${id}`, status, updatedAt },
		preview: { kind: "document", lines: [], blockCount: 0 },
	} as unknown as OsOutputLibraryItem;
}

describe("deliveryState", () => {
	it("reports the gate verdict for gated outputs", () => {
		expect(
			deliveryState(
				videoItem("a", "2026-08-25T00:00:00Z", { status: "approved" }),
			),
		).toBe("approved");
		expect(
			deliveryState(
				videoItem("b", "2026-08-25T00:00:00Z", { status: "rejected" }),
			),
		).toBe("rejected");
	});

	it("treats an ungated video as a reference, not a failed candidate", () => {
		expect(
			deliveryState(videoItem("c", "2026-08-25T00:00:00Z", undefined)),
		).toBe("reference");
	});

	it("treats documents as references regardless of kind", () => {
		expect(deliveryState(docItem("d", "2026-08-25T00:00:00Z"))).toBe(
			"reference",
		);
	});
});

describe("byUpdatedAtDesc", () => {
	it("orders newest first", () => {
		const older = docItem("old", "2026-08-01T00:00:00Z");
		const newer = docItem("new", "2026-08-25T00:00:00Z");
		expect(
			[older, newer].sort(byUpdatedAtDesc).map((i) => i.output.id),
		).toEqual(["new", "old"]);
	});

	it("sorts unparsable timestamps last instead of throwing", () => {
		const broken = docItem("broken", "not-a-date");
		const good = docItem("good", "2026-08-25T00:00:00Z");
		expect(
			[broken, good].sort(byUpdatedAtDesc).map((i) => i.output.id),
		).toEqual(["good", "broken"]);
	});
});

describe("outputStateCounts and matchesStateFilter", () => {
	const items = [
		docItem("a", "2026-08-25T00:00:00Z", "active"),
		docItem("b", "2026-08-24T00:00:00Z", "archived"),
		docItem("c", "2026-08-23T00:00:00Z", "archived"),
	];

	it("counts each state and totals to all", () => {
		const counts = outputStateCounts(items);
		expect(counts).toEqual({ active: 1, archived: 2, all: 3 });
		expect(counts.active + counts.archived).toBe(counts.all);
	});

	it("filters by state, with all passing everything", () => {
		expect(items.filter((i) => matchesStateFilter(i, "active"))).toHaveLength(
			1,
		);
		expect(items.filter((i) => matchesStateFilter(i, "archived"))).toHaveLength(
			2,
		);
		expect(items.filter((i) => matchesStateFilter(i, "all"))).toHaveLength(3);
	});
});

describe("groupDeliverables", () => {
	it("keeps documents out of the iteration history", () => {
		const groups = groupDeliverables([
			docItem("brief", "2026-08-25T00:00:00Z"),
			videoItem("v1", "2026-08-24T00:00:00Z", { status: "candidate" }),
		]);
		expect(groups.references.map((i) => i.output.id)).toEqual(["brief"]);
		expect(groups.latestCandidate?.output.id).toBe("v1");
		expect(groups.earlierIterations).toHaveLength(0);
	});

	it("surfaces a document-only workspace as references with no candidate", () => {
		const groups = groupDeliverables([
			docItem("a", "2026-08-25T00:00:00Z"),
			docItem("b", "2026-08-24T00:00:00Z"),
		]);
		expect(groups.approved).toBeNull();
		expect(groups.latestCandidate).toBeNull();
		expect(groups.references).toHaveLength(2);
	});

	it("picks the newest candidate by timestamp, not list order", () => {
		const groups = groupDeliverables([
			videoItem("older", "2026-08-01T00:00:00Z", { status: "candidate" }),
			videoItem("newest", "2026-08-25T00:00:00Z", { status: "rejected" }),
			videoItem("middle", "2026-08-10T00:00:00Z", { status: "candidate" }),
		]);
		expect(groups.latestCandidate?.output.id).toBe("newest");
		expect(groups.earlierIterations.map((i) => i.output.id)).toEqual([
			"middle",
			"older",
		]);
	});

	it("separates the approved deliverable from the newest attempt", () => {
		const groups = groupDeliverables([
			videoItem("approved", "2026-08-10T00:00:00Z", { status: "approved" }),
			videoItem("newer-try", "2026-08-25T00:00:00Z", { status: "rejected" }),
		]);
		expect(groups.approved?.output.id).toBe("approved");
		expect(groups.latestCandidate?.output.id).toBe("newer-try");
	});

	it("demotes a superseded approved output into the history", () => {
		const groups = groupDeliverables([
			videoItem("old-approved", "2026-08-01T00:00:00Z", { status: "approved" }),
			videoItem("new-approved", "2026-08-25T00:00:00Z", { status: "approved" }),
		]);
		expect(groups.approved?.output.id).toBe("new-approved");
		expect(groups.latestCandidate?.output.id).toBe("old-approved");
	});
});

describe("deliveryBadgeLabel", () => {
	it("shows the verdict and rounded score when the gate emitted one", () => {
		expect(
			deliveryBadgeLabel(
				videoItem("a", "2026-08-25T00:00:00Z", {
					status: "rejected",
					verdict: "reject",
					score: 45.4,
				}),
			),
		).toBe("reject · 45");
	});

	it("falls back to the status when there is no verdict or score", () => {
		expect(
			deliveryBadgeLabel(
				videoItem("b", "2026-08-25T00:00:00Z", { status: "candidate" }),
			),
		).toBe("candidate");
	});

	it("labels an ungated artifact with its kind", () => {
		expect(deliveryBadgeLabel(docItem("c", "2026-08-25T00:00:00Z"))).toBe(
			"document",
		);
	});
});

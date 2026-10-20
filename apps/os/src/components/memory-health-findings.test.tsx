import type {
	MemoryHealthFinding,
	MemoryHealthFindingSample,
} from "@tedix/api-contract/schemas/memory-graph";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	findingCount,
	findingHeadline,
	graphLayerStatus,
	MemoryHealthFindingItem,
	ProvenanceDetails,
	provenanceLines,
	reviewTarget,
} from "./memory-health-findings";

const context = { unusedDays: 60, staleDays: 90, orphanWindow: 2000 };

const sample: MemoryHealthFindingSample = {
	factId: "f1",
	tediId: null,
	text: "Refunds above 500 EUR need a second approver.",
	detail: "Never retrieved since it was recorded.",
	confidence: 0.8,
	source: "doc://policies/refunds.md",
	sourceUrl: null,
	sourceSessionId: null,
	reviewStatus: "pending",
	createdAt: "2026-05-02T09:00:00.000Z",
	lastVerifiedAt: null,
	lastAccessedAt: null,
};

const finding = (
	kind: MemoryHealthFinding["kind"],
	count: number,
	capped = false,
): MemoryHealthFinding => ({ kind, count, capped, samples: [] });

describe("findingHeadline", () => {
	it("puts the number and the window in plain English", () => {
		expect(findingHeadline(finding("unused", 38), context)).toBe(
			"38 facts were not retrieved in the last 60 days",
		);
		expect(findingHeadline(finding("contradiction", 1), context)).toBe(
			"1 fact contradicts another current fact",
		);
		expect(findingHeadline(finding("orphan", 12), context)).toContain(
			"12 of the 2,000 most recently updated facts aren't linked",
		);
	});

	it("shows 500+ when the server capped the count", () => {
		const capped = finding("unused", 500, true);
		expect(findingCount(capped)).toBe("500+");
		expect(findingHeadline(capped, context)).toContain("500+ facts");
	});

	it("says so when nothing needs review", () => {
		for (const kind of [
			"unused",
			"stale_in_use",
			"duplicate",
			"contradiction",
			"orphan",
		] as const) {
			expect(findingHeadline(finding(kind, 0), context)).not.toMatch(/^0 /);
		}
	});
});

describe("graphLayerStatus", () => {
	it("calls an unconfigured Neo4j layer paused, never live", () => {
		const status = graphLayerStatus({ configured: false });
		expect(status.label).toBe("Paused (projection only)");
		expect(status.detail).toContain("D1 is the record");
	});
});

describe("provenance", () => {
	it("lists the recorded source", () => {
		expect(provenanceLines(sample)).toEqual([
			"Source: doc://policies/refunds.md",
		]);
		expect(
			renderToStaticMarkup(<ProvenanceDetails sample={sample} />),
		).toContain("Source: doc://policies/refunds.md");
	});

	it("says a fact with no source is unverified", () => {
		const html = renderToStaticMarkup(
			<ProvenanceDetails sample={{ ...sample, source: null }} />,
		);
		expect(html).toContain("No source was recorded");
		expect(html).toContain("never verified");
	});
});

describe("review links", () => {
	it("only links facts that belong to a tedi", () => {
		expect(reviewTarget({ tediId: null })).toBeNull();
		expect(reviewTarget({ tediId: "t1" })).toEqual({ tediId: "t1" });
	});
});

describe("MemoryHealthFindingItem", () => {
	it("renders the count, the action and the trigger for each named fact", () => {
		const html = renderToStaticMarkup(
			<MemoryHealthFindingItem
				context={context}
				finding={{ ...finding("unused", 3), samples: [sample] }}
			/>,
		);
		expect(html).toContain("3 facts were not retrieved");
		expect(html).toContain("Refunds above 500 EUR");
		expect(html).toContain("Why do we believe this?");
		expect(html).toContain("Org-wide fact");
		expect(html).toContain("Showing 1.");
	});
});

it("groups identical health text while keeping each fact and its provenance", () => {
	const html = renderToStaticMarkup(
		<MemoryHealthFindingItem
			context={context}
			finding={{
				...finding("unused", 3),
				samples: [
					sample,
					{ ...sample, factId: "f2", source: "doc://second", confidence: 0.3 },
					{ ...sample, factId: "f3", text: "A distinct summary." },
				],
			}}
		/>,
	);
	const root = document.createElement("div");
	root.innerHTML = html;
	expect(
		root.querySelectorAll('[data-slot="memory-health-sample"]'),
	).toHaveLength(2);
	expect(
		root.textContent?.match(/Refunds above 500 EUR need a second approver\./g),
	).toHaveLength(1);
	expect(root.querySelector("[aria-expanded=false]")?.textContent).toContain(
		"2 sources",
	);
	expect(root.textContent).toContain("f1");
	expect(root.textContent).toContain("f2");
	expect(root.textContent).toContain("doc://second");
	expect(root.textContent).toContain("Confidence 30%");
	expect(root.textContent).toContain("A distinct summary.");
	expect(root.textContent).not.toContain("Showing 2.");
});

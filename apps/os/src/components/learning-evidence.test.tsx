import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GrowthSnapshot } from "@tedix/api-contract/contracts/growth-snapshots";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const memoryGraphApi = vi.hoisted(() => ({ expertise: vi.fn() }));
const growthApi = vi.hoisted(() => ({ latest: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { memoryGraph: memoryGraphApi, growthSnapshots: growthApi },
}));

import {
	ExpertiseDomainRow,
	ExpertiseEmpty,
	type ExpertiseInput,
	expertiseRows,
	GrowthSnapshotPanel,
	growthMetricRows,
	LearningEvidence,
	snapshotDrift,
} from "./learning-evidence";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEDI_ID = "11111111-1111-4111-8111-111111111111";

const expertise = (
	id: string,
	domainName: string | null,
	competenceScore: number,
	overrides: Partial<ExpertiseInput> = {},
): ExpertiseInput => ({
	id,
	domainId: `domain-${id}-0000-0000-0000`,
	domainName,
	factCount: 10,
	avgConfidence: 0.8,
	competenceScore,
	expertiseLevel: "proficient",
	lastActivityAt: "2026-08-12T08:30:00.000Z",
	...overrides,
});

const snapshot = (domains: number): GrowthSnapshot => ({
	id: "snap-1",
	tediId: TEDI_ID,
	orgId: "org-1",
	snapshotDate: "2026-08-10",
	metrics: {
		facts: 128,
		avgConfidence: 0.82,
		skills: 14,
		avgRevision: 2.1,
		muscles: 5,
		avgUsage: 11.4,
		domains,
		autonomyRate: 0.64,
		expertiseLevels: { reporting: "expert" },
	},
	createdAt: "2026-08-10T00:00:00.000Z",
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("expertiseRows", () => {
	it("ranks domains by weighted competence, strongest first", () => {
		const rows = expertiseRows([
			expertise("a", "churn", 0.4),
			expertise("b", "revenue", 0.9),
		]);
		expect(rows.map((row) => row.domainName)).toEqual(["revenue", "churn"]);
	});

	// A domain the graph could not name is still a competence claim; hiding it
	// would understate what the tedi is asserting expertise over.
	it("labels an unnamed domain instead of dropping it", () => {
		const rows = expertiseRows([expertise("a", null, 0.5)]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.domainName).toContain("domain ");
	});

	it("breaks ties deterministically so the ordering is total", () => {
		const first = expertiseRows([
			expertise("b", "beta", 0.5),
			expertise("a", "alpha", 0.5),
		]);
		const second = expertiseRows([
			expertise("a", "alpha", 0.5),
			expertise("b", "beta", 0.5),
		]);
		expect(first.map((row) => row.id)).toEqual(second.map((row) => row.id));
	});

	it("normalizes absent optional fields to null rather than undefined", () => {
		const rows = expertiseRows([
			{
				id: "a",
				domainId: "d",
				factCount: 1,
				avgConfidence: 0.5,
				competenceScore: 0.5,
				expertiseLevel: "novice",
			},
		]);
		expect(rows[0]?.lastActivityAt).toBe(null);
	});
});

describe("growthMetricRows", () => {
	it("formats each metric in its own dialect, not one undifferentiated grid", () => {
		const rows = growthMetricRows(snapshot(6));
		const byId = new Map(rows.map((row) => [row.id, row.value]));
		// A rate rendered as a raw 0.64 reads as "64 things".
		expect(byId.get("autonomy-rate")).toBe("64%");
		expect(byId.get("avg-confidence")).toBe("82%");
		expect(byId.get("facts")).toBe("128");
		expect(byId.get("avg-revision")).toBe("2.1");
	});
});

describe("snapshotDrift", () => {
	it("is null when there is no snapshot to compare against", () => {
		expect(snapshotDrift(null, 3)).toBe(null);
		expect(snapshotDrift(undefined, 3)).toBe(null);
	});

	it("detects when the dated photo no longer matches the live read", () => {
		expect(snapshotDrift(snapshot(4), 3)).toEqual({
			drifted: true,
			snapshotDomains: 4,
		});
		expect(snapshotDrift(snapshot(3), 3)?.drifted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Presentational subcomponents
// ---------------------------------------------------------------------------

describe("ExpertiseDomainRow", () => {
	it("shows the level, competence, fact count, and confidence", () => {
		const html = renderToStaticMarkup(
			<ExpertiseDomainRow
				row={expertiseRows([expertise("a", "revenue", 0.79)])[0]!}
			/>,
		);
		expect(html).toContain("revenue");
		expect(html).toContain("Proficient");
		expect(html).toContain("competence 79%");
		expect(html).toContain("10 facts");
		expect(html).toContain("80% avg confidence");
	});

	it("clamps the bar to the canvas for an out-of-range score", () => {
		const html = renderToStaticMarkup(
			<ExpertiseDomainRow
				row={expertiseRows([expertise("a", "revenue", 1.8)])[0]!}
			/>,
		);
		expect(html).toContain('data-filled="100"');
	});
});

describe("ExpertiseEmpty", () => {
	it("says expertise comes from learned facts, not from a title", () => {
		expect(renderToStaticMarkup(<ExpertiseEmpty />)).toContain(
			"not from a title or a role assignment",
		);
	});
});

describe("GrowthSnapshotPanel", () => {
	it("labels every metric it renders", () => {
		const html = renderToStaticMarkup(
			<GrowthSnapshotPanel snapshot={snapshot(6)} />,
		);
		expect(html).toContain("Autonomy rate");
		expect(html).toContain("Muscle memories");
		expect(html).toContain('data-metric="facts"');
		expect(html).toContain('aria-label="Learning growth summary"');
		expect(html).toContain('data-slot="metric-grid"');
		expect(html.match(/data-slot="metric-item"/g)).toHaveLength(8);
	});
});

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderSection(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<LearningEvidence tediId={TEDI_ID} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	memoryGraphApi.expertise.mockReset();
	growthApi.latest.mockReset();
	memoryGraphApi.expertise.mockResolvedValue({
		expertise: [expertise("a", "revenue", 0.79), expertise("b", "churn", 0.4)],
	});
	growthApi.latest.mockResolvedValue(snapshot(4));
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("LearningEvidence", () => {
	it("reads both canonical endpoints scoped to the tedi", async () => {
		renderSection();
		await flush();
		expect(memoryGraphApi.expertise).toHaveBeenCalledWith(
			{ tediId: TEDI_ID },
			// The contract-derived options forward TanStack Query's AbortSignal.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(growthApi.latest).toHaveBeenCalledWith(
			{ tediId: TEDI_ID },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("keeps the live read and the dated photo separately labeled", async () => {
		const container = renderSection();
		await flush();
		expect(
			container.querySelector('[data-slot="page-section"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-slot="section-header"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Observed expertise");
		expect(container.textContent).toContain("revenue");
		expect(container.textContent).toContain("Snapshot taken Aug 10, 2026");
		expect(container.textContent).toContain("a dated photo, not a live read");
	});

	it("states the drift when the snapshot no longer matches live expertise", async () => {
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"Live expertise now covers 2 domains against 4 in the snapshot",
		);
	});

	// "No snapshot yet" and "the snapshot read failed" are different answers.
	it("distinguishes a never-written snapshot from a failed read", async () => {
		growthApi.latest.mockResolvedValue(null);
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"No growth snapshot has been recorded for this tedi yet",
		);
	});

	it("distinguishes a refused expertise read from a broken one", async () => {
		memoryGraphApi.expertise.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"Expertise is not readable with your access",
		);
		expect(container.textContent).not.toContain("No domain expertise yet");
	});

	it("states no drift when the live expertise read never landed", async () => {
		// The drift sentence compares a LIVE count to a dated one. With the live
		// read refused, rows is [] for want of data, and the surface used to
		// print "live expertise now covers 0 domains against 4 in the snapshot"
		// immediately below "expertise is not readable" — a measurement
		// fabricated from a read that never happened.
		memoryGraphApi.expertise.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"Expertise is not readable with your access",
		);
		expect(container.textContent).not.toContain("Live expertise now covers");
		expect(container.textContent).toContain("Snapshot taken");
	});

	it("surfaces a genuine expertise failure with its message", async () => {
		memoryGraphApi.expertise.mockRejectedValue(new Error("graph offline"));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("Expertise is unavailable");
		expect(container.textContent).toContain("graph offline");
	});

	// A failed snapshot read must not take the expertise section down with it.
	it("keeps rendering expertise when the snapshot read fails", async () => {
		growthApi.latest.mockRejectedValue(new Error("snapshot table missing"));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("revenue");
		expect(container.textContent).toContain("Growth snapshots are unavailable");
	});

	it("renders the empty state when the tedi has learned no domain yet", async () => {
		memoryGraphApi.expertise.mockResolvedValue({ expertise: [] });
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("No domain expertise yet");
	});
});

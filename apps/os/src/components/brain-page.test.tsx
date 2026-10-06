import type {
	KnowledgeEntry,
	KnowledgeEntryType,
} from "@tedix/api-contract/schemas/cognitive";
import type { MemoryHealth } from "@tedix/api-contract/schemas/memory-graph";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CardRunLinkProps } from "./chat-cards";
import {
	BRAIN_PREVIEW_LENGTH,
	confidencePercent,
	ENTRY_TYPE_VARIANTS,
	KnowledgeEmpty,
	KnowledgeRow,
	MemoryVitals,
	memoryVitals,
	OUTCOME_BADGE_VARIANTS,
	OUTCOME_TABS,
	OutcomeChip,
	RationaleEmpty,
	RationaleRow,
	runtimeReferenceLabel,
	workflowRunLinkId,
} from "./brain-page";

// TanStack Link needs a RouterProvider — the injectable-link seam from
// chat-cards lets static-markup tests render the run chip without one.
function StubRunLink(props: CardRunLinkProps) {
	return (
		<a
			data-to={props.to}
			data-run-id={props.params.runId}
			className={props.className}
			aria-label={props["aria-label"]}
		>
			{props.children}
		</a>
	);
}

const baseRecord: RationaleRecord = {
	id: "11111111-1111-4111-8111-111111111111",
	tediId: "22222222-2222-4222-8222-222222222222",
	orgId: "33333333-3333-4333-8333-333333333333",
	action: "Escalated the failing deploy to the CTO",
	rationale: "Two consecutive deploy failures with the same provenance error.",
	category: "escalation",
	confidence: 0.82,
	evidence: {},
	outcome: null,
	outcomeStatus: "pending",
	approvalRequestId: null,
	objectiveId: null,
	runId: "55555555-5555-4555-8555-555555555555",
	workItemId: null,
	toolCallRefs: null,
	proofRef: null,
	createdAt: "2026-08-12T10:00:00.000Z",
	completedAt: null,
};

const baseHealth: MemoryHealth = {
	totalFacts: 1340,
	activeFacts: 1200,
	archivedFacts: 140,
	totalGaps: 12,
	totalOpinions: 30,
	totalEdges: 4210,
	totalDomains: 9,
	avgConfidence: 0.734,
	orphanRatio: 0.05,
	staleFacts: 0,
	contradictions: 0,
	curiosityQueue: { queued: 3, exploring: 1, completedTotal: 44 },
};

const baseEntry: KnowledgeEntry = {
	id: "44444444-4444-4444-8444-444444444444",
	organizationId: "33333333-3333-4333-8333-333333333333",
	tediId: null,
	domainId: null,
	title: "Deploys go through main",
	content: "GitHub Actions deploys production directly from main.",
	entryType: "convention",
	sourceFactIds: null,
	sourceCount: 4,
	confidence: 0.9,
	revision: 1,
	revisionReasoning: null,
	supersedesId: null,
	visibility: "org",
	tags: null,
	lastValidatedAt: null,
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-10T10:00:00.000Z",
};

describe("outcome helpers", () => {
	it("maps every outcome status to an honest badge variant", () => {
		expect(OUTCOME_BADGE_VARIANTS.pending).toBe("info");
		expect(OUTCOME_BADGE_VARIANTS.success).toBe("success");
		expect(OUTCOME_BADGE_VARIANTS.failure).toBe("error");
		expect(OUTCOME_BADGE_VARIANTS.partial).toBe("warning");
		// unverified = a success claim without proof — warns, never celebrates
		expect(OUTCOME_BADGE_VARIANTS.unverified).toBe("warning");
	});

	it("keeps tab statuses inside the outcome enum", () => {
		expect(OUTCOME_TABS[0].status).toBeUndefined();
		for (const tab of OUTCOME_TABS.slice(1)) {
			expect(tab.status).toBeDefined();
			expect(OUTCOME_BADGE_VARIANTS[tab.status as never]).toBeDefined();
		}
	});

	it("renders the chip with its status stamped", () => {
		const html = renderToStaticMarkup(<OutcomeChip status="unverified" />);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-status="unverified"');
		expect(html).toContain("Unverified");
	});
});

describe("confidencePercent", () => {
	it("rounds to whole percents", () => {
		expect(confidencePercent(0.724)).toBe("72%");
		expect(confidencePercent(0.005)).toBe("1%");
		expect(confidencePercent(0)).toBe("0%");
		expect(confidencePercent(1)).toBe("100%");
	});
});

describe("Brain run references", () => {
	it("links only canonical workflow run ids", () => {
		expect(workflowRunLinkId("55555555-5555-4555-8555-555555555555")).toBe(
			"55555555-5555-4555-8555-555555555555",
		);
		expect(
			workflowRunLinkId(
				"tedi:mcp:66666666-6666-4666-8666-666666666666_delegate",
			),
		).toBeNull();
		expect(workflowRunLinkId(null)).toBeNull();
	});

	it("extracts a stable compact label from compound runtime references", () => {
		expect(
			runtimeReferenceLabel(
				"tedi:mcp:66666666-6666-4666-8666-666666666666_delegate:tedi",
			),
		).toBe("Runtime 66666666…");
	});
});

describe("memoryVitals", () => {
	it("keeps hygiene counters at default tone when clean", () => {
		const vitals = memoryVitals(baseHealth);
		const byId = Object.fromEntries(vitals.map((v) => [v.id, v]));
		expect(byId["active-facts"]?.value).toBe("1,200");
		expect(byId["edges"]?.value).toBe("4,210");
		expect(byId["avg-confidence"]?.value).toBe("73%");
		expect(byId["stale-facts"]?.tone).toBe("default");
		expect(byId["contradictions"]?.tone).toBe("default");
		expect(byId["curiosity"]?.value).toBe("3 queued · 1 exploring");
	});

	it("escalates stale facts and contradictions when non-zero", () => {
		const vitals = memoryVitals({
			...baseHealth,
			staleFacts: 7,
			contradictions: 2,
		});
		const byId = Object.fromEntries(vitals.map((v) => [v.id, v]));
		expect(byId["stale-facts"]?.tone).toBe("warn");
		expect(byId["contradictions"]?.tone).toBe("danger");
	});

	it("renders each vital with its id and tone stamped", () => {
		const html = renderToStaticMarkup(
			<MemoryVitals health={{ ...baseHealth, contradictions: 2 }} />,
		);
		expect(html).toContain('data-vital="active-facts"');
		expect(html).toContain("Active facts");
		expect(html).toContain('data-vital="contradictions"');
		expect(html).toContain('data-tone="danger"');
		expect(html).toContain("Curiosity queue");
		expect(html).toContain('data-slot="metric-grid"');
		expect(html).toContain('aria-label="Memory vitals"');
		expect(html.match(/data-slot="metric-item"/g)).toHaveLength(8);
		expect(html).not.toContain('data-slot="surface"');
	});
});

describe("RationaleRow", () => {
	it("renders outcome chip, action, rationale, actor, time, and run link", () => {
		const html = renderToStaticMarkup(
			<RationaleRow
				record={baseRecord}
				tediNames={{ [baseRecord.tediId]: "CTO" }}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain('data-status="pending"');
		expect(html).toContain("Escalated the failing deploy to the CTO");
		expect(html).toContain("Two consecutive deploy failures");
		expect(html).toContain("escalation · 82% confident");
		expect(html).toContain("CTO · decided");
		expect(html).toContain('dateTime="2026-08-12T10:00:00.000Z"');
		expect(html).toContain(
			'data-run-id="55555555-5555-4555-8555-555555555555"',
		);
		expect(html).toContain("Run details");
		expect(html).toContain(
			'aria-label="Open run details for Escalated the failing deploy to the CTO"',
		);
		expect(html).toContain("hover:bg-kumo-tint");
		expect(html).toContain("focus-visible:ring-kumo-focus");
		expect(html).toContain('data-slot="brain-decision-row"');
		expect(html).toContain('data-preview="rationale"');
		expect(html).toContain("line-clamp-2 break-words sm:line-clamp-1");
		expect(
			html.indexOf("Escalated the failing deploy to the CTO"),
		).toBeLessThan(html.indexOf("Pending"));
	});

	it("labels compound runtime evidence without linking to workflow Run detail", () => {
		const compoundRunId =
			"tedi:mcp:66666666-6666-4666-8666-666666666666_delegate:tedi";
		const html = renderToStaticMarkup(
			<RationaleRow
				record={{ ...baseRecord, runId: compoundRunId }}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain('data-slot="runtime-reference"');
		expect(html).toContain("Runtime 66666666…");
		expect(html).toContain(`title="${compoundRunId}"`);
		expect(html).not.toContain("data-run-id");
		expect(html).not.toContain("Run details");
		expect(html).not.toContain("hover:bg-kumo-tint");
	});

	it("falls back to a generic actor and omits the run chip without a runId", () => {
		const html = renderToStaticMarkup(
			<RationaleRow
				record={{ ...baseRecord, runId: null }}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain("a tedi · decided");
		expect(html).not.toContain("data-run-id");
		expect(html).not.toContain("Run details");
		expect(html).not.toContain("hover:bg-kumo-tint");
	});

	it("truncates a 5000-char rationale and hides pending outcomes", () => {
		const html = renderToStaticMarkup(
			<RationaleRow
				record={{
					...baseRecord,
					rationale: "x".repeat(5000),
					outcome: "should not render while pending",
				}}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain(`${"x".repeat(BRAIN_PREVIEW_LENGTH - 1)}…`);
		expect(html).not.toContain("x".repeat(BRAIN_PREVIEW_LENGTH + 1));
		expect(html).not.toContain("should not render while pending");
	});

	it("shows the outcome line once the record completes", () => {
		const html = renderToStaticMarkup(
			<RationaleRow
				record={{
					...baseRecord,
					outcomeStatus: "success",
					outcome: "Deploy recovered after the provenance fix",
					completedAt: "2026-08-12T11:00:00.000Z",
				}}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain('data-status="success"');
		expect(html).toContain("Deploy recovered after the provenance fix");
		expect(html).toContain('data-preview="outcome"');
		expect(
			html.match(/line-clamp-2 break-words sm:line-clamp-1/g),
		).toHaveLength(2);
	});
});

describe("KnowledgeRow", () => {
	it("renders type chip, org-wide scope, sources, and content", () => {
		const html = renderToStaticMarkup(<KnowledgeRow entry={baseEntry} />);
		expect(html).toContain('data-entry-type="convention"');
		expect(html).toContain("Convention");
		expect(html).toContain("Deploys go through main");
		expect(html).toContain("org-wide · 90% confident · 4 source facts");
		expect(html).toContain("GitHub Actions deploys production");
		expect(html).toContain('dateTime="2026-08-10T10:00:00.000Z"');
		expect(html.indexOf("Deploys go through main")).toBeLessThan(
			html.indexOf("Convention"),
		);
	});

	it("resolves tedi scope, singular source, and revision when present", () => {
		const html = renderToStaticMarkup(
			<KnowledgeRow
				entry={{
					...baseEntry,
					tediId: "tedi-1",
					sourceCount: 1,
					revision: 3,
				}}
				tediNames={{ "tedi-1": "CMO" }}
			/>,
		);
		expect(html).toContain("CMO · 90% confident · 1 source fact · rev 3");
	});

	it("omits sources at zero and the time line when both dates are null", () => {
		const html = renderToStaticMarkup(
			<KnowledgeRow
				entry={{
					...baseEntry,
					sourceCount: 0,
					createdAt: null,
					updatedAt: null,
				}}
			/>,
		);
		expect(html).not.toContain("source fact");
		expect(html).not.toContain("updated");
	});

	it("keeps every entry type mapped and only warns on anti-patterns", () => {
		const warned = (
			Object.keys(ENTRY_TYPE_VARIANTS) as KnowledgeEntryType[]
		).filter((type) => ENTRY_TYPE_VARIANTS[type] === "warning");
		expect(warned).toEqual(["anti_pattern"]);
	});
});

describe("empty states", () => {
	it("distinguishes a filtered decision list from a truly empty one", () => {
		expect(renderToStaticMarkup(<RationaleEmpty filtered={false} />)).toContain(
			"No decisions yet",
		);
		expect(renderToStaticMarkup(<RationaleEmpty filtered={true} />)).toContain(
			"No decisions match this filter",
		);
	});

	it("explains the empty knowledge list without implying failure", () => {
		expect(renderToStaticMarkup(<KnowledgeEmpty />)).toContain(
			"No knowledge entries yet",
		);
	});
});

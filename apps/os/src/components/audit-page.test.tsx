import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/kumo/button";
import { Collection, Page } from "@/components/kumo/page";
import { AUDIT_ALL_RESOURCES, AUDIT_PAGE_SIZE } from "@/lib/audit-search";
import { auditSearchQueryOptions } from "@/lib/os-query-options";
import { getOsSurface } from "@/lib/os-navigation";
import { describe, expect, it } from "vite-plus/test";
import {
	actorLabel,
	actorTone,
	actorTypeLabel,
	AuditActorChip,
	AuditEmpty,
	type AuditEvent,
	AuditEventDetails,
	AuditEventRow,
	AuditEventTable,
	AuditFilters,
	AuditPage,
	FACET_LIMIT,
	formatAuditMetadata,
	resourceTypeFacets,
} from "./audit-page";

function renderAuditPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false, retry: false } },
	});
	client.setQueryData(
		auditSearchQueryOptions({ limit: AUDIT_PAGE_SIZE }).queryKey,
		{
			data: [
				baseEvent,
				event({
					id: "22222222-2222-4222-8222-222222222223",
					resourceType: "app",
				}),
			],
			pagination: { total: 2, limit: AUDIT_PAGE_SIZE, offset: 0 },
		} as never,
	);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<AuditPage
					search={{ resourceType: AUDIT_ALL_RESOURCES, action: "", page: 1 }}
					onSearchChange={() => {}}
				/>
			</QueryClientProvider>,
		),
		"text/html",
	);
}
const kumoClass = (element: React.ReactElement) =>
	new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html")
		.body.firstElementChild?.className;

const baseEvent: AuditEvent = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	actorId: "33333333-3333-4333-8333-333333333333",
	actorType: "tedi",
	action: "record_skill",
	resourceType: "skill",
	resourceId: "44444444-4444-4444-8444-444444444444",
	metadata: { toolId: "record_skill" },
	ipAddress: null,
	userAgent: null,
	timestamp: "2026-08-12T10:00:00.000Z",
};

function event(overrides: Partial<AuditEvent>): AuditEvent {
	return { ...baseEvent, ...overrides };
}

describe("actorTone", () => {
	it("marks humans active, tedis done, external agents warn", () => {
		expect(actorTone("user")).toBe("active");
		expect(actorTone("tedi")).toBe("done");
		expect(actorTone("external_agent")).toBe("warn");
	});

	it("keeps machine actors neutral — machine writes are normal, not warnings", () => {
		expect(actorTone("service")).toBe("neutral");
		expect(actorTone("m2m")).toBe("neutral");
		expect(actorTone("api_key")).toBe("neutral");
		expect(actorTone("kernel")).toBe("neutral");
		expect(actorTone("anonymous")).toBe("neutral");
	});
});

describe("actorTypeLabel", () => {
	it("sentence-cases ordinary actor types", () => {
		expect(actorTypeLabel("user")).toBe("User");
		expect(actorTypeLabel("external_agent")).toBe("External agent");
		expect(actorTypeLabel("kernel")).toBe("Kernel");
	});

	it("preserves acronym casings sentenceCase would mangle", () => {
		expect(actorTypeLabel("api_key")).toBe("API key");
		expect(actorTypeLabel("m2m")).toBe("M2M");
	});
});

describe("actorLabel", () => {
	it("resolves tedi actors through the shared name map", () => {
		expect(
			actorLabel(baseEvent, {
				"33333333-3333-4333-8333-333333333333": "CTO",
			}),
		).toBe("CTO");
		expect(actorLabel(baseEvent)).toBe("a tedi");
	});

	it("shows the raw principal id for non-tedi actors", () => {
		expect(actorLabel(event({ actorType: "user", actorId: "U123" }))).toBe(
			"U123",
		);
		expect(actorLabel(event({ actorType: "api_key", actorId: "sk_1" }))).toBe(
			"sk_1",
		);
	});

	it("returns null for anonymous actors — the chip already says so", () => {
		expect(actorLabel(event({ actorType: "anonymous" }))).toBeNull();
	});
});

describe("resourceTypeFacets", () => {
	it("orders facets by frequency with name tiebreaks", () => {
		const events = [
			event({ resourceType: "skill" }),
			event({ resourceType: "app" }),
			event({ resourceType: "app" }),
			event({ resourceType: "tedi" }),
		];
		expect(resourceTypeFacets(events)).toEqual(["app", "skill", "tedi"]);
	});

	it("caps the facet list and handles the empty case", () => {
		const events = ["a", "b", "c", "d", "e", "f"].map((resourceType) =>
			event({ resourceType }),
		);
		expect(resourceTypeFacets(events)).toHaveLength(FACET_LIMIT);
		expect(resourceTypeFacets(events, 2)).toEqual(["a", "b"]);
		expect(resourceTypeFacets([])).toEqual([]);
	});
});

describe("AuditActorChip", () => {
	it("renders a Kumo Badge stamped with the actor tone", () => {
		const html = renderToStaticMarkup(<AuditActorChip actorType="tedi" />);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-tone="done"');
		expect(html).toContain("Tedi");
	});

	it("stamps the warn tone for external harness agents", () => {
		const html = renderToStaticMarkup(
			<AuditActorChip actorType="external_agent" />,
		);
		expect(html).toContain('data-tone="warn"');
		expect(html).toContain("External agent");
	});
});

describe("AuditEventRow", () => {
	it("uses one canonical divided collection on narrow screens", () => {
		const doc = renderAuditPage();
		const collection = doc.querySelector(
			'[data-slot="collection"][aria-label="Audit events"]',
		);
		expect(collection?.className).toBe(
			kumoClass(
				<Collection aria-label="Audit events" className="lg:hidden">
					<li />
				</Collection>,
			),
		);
		expect(collection?.querySelectorAll("li")).toHaveLength(2);
	});

	it("renders actor identity, action, target, and machine-readable time", () => {
		const html = renderToStaticMarkup(
			<AuditEventRow
				event={baseEvent}
				tediNames={{ "33333333-3333-4333-8333-333333333333": "CTO" }}
			/>,
		);
		expect(html).toContain('data-tone="done"');
		expect(html).toContain("CTO");
		expect(html).toContain("Record skill");
		// The exact action string survives on the title attribute.
		expect(html).toContain('title="record_skill"');
		expect(html).toContain("skill · 44444444-4444-4444-8444-444444444444");
		expect(html).toContain('dateTime="2026-08-12T10:00:00.000Z"');
	});

	it("omits the target id and ip when absent", () => {
		const html = renderToStaticMarkup(
			<AuditEventRow
				event={event({ actorType: "kernel", resourceId: null })}
			/>,
		);
		expect(html).toContain("Kernel");
		expect(html).not.toContain("44444444-4444-4444-8444-444444444444");
		expect(html).not.toContain("from ");
	});

	it("shows the source ip when the event carries one", () => {
		const html = renderToStaticMarkup(
			<AuditEventRow
				event={event({ actorType: "user", ipAddress: "203.0.113.7" })}
			/>,
		);
		expect(html).toContain("from 203.0.113.7");
	});

	it("offers a labelled detail action while keeping the summary visible", () => {
		const html = renderToStaticMarkup(
			<AuditEventRow event={baseEvent} onInspect={() => {}} />,
		);
		expect(html).toContain("Record skill");
		expect(html).toContain('aria-label="View details for record_skill event"');
		expect(html).toContain(">Details<");
	});
});

describe("AuditEventTable", () => {
	it("uses the Kumo table adapter for wide operational scans", () => {
		const html = renderToStaticMarkup(
			<AuditEventTable
				events={[baseEvent]}
				tediNames={{ "33333333-3333-4333-8333-333333333333": "CTO" }}
			/>,
		);
		expect(html).toContain('data-slot="table"');
		expect(html).toContain('class="hidden lg:block"');
		expect(html).toContain('aria-label="Audit events table"');
		expect(html).toContain("Actor");
		expect(html).toContain("Record skill");
		expect(html).toContain("CTO");
	});

	it("offers one detail action per event without turning the row into a link", () => {
		const html = renderToStaticMarkup(
			<AuditEventTable events={[baseEvent]} onInspect={() => {}} />,
		);
		expect(html).toContain("Details");
		expect(html).toContain('aria-label="View details for record_skill event"');
		expect(html).toContain("Record skill");
	});
});

describe("AuditEventDetails", () => {
	it("shows exact event context and escaped metadata", () => {
		const html = renderToStaticMarkup(
			<AuditEventDetails
				event={event({
					ipAddress: "203.0.113.7",
					userAgent: "Example browser",
					metadata: { traceId: "trace-1", note: "<script>alert(1)</script>" },
				})}
				tediNames={{ "33333333-3333-4333-8333-333333333333": "CTO" }}
			/>,
		);
		expect(html).toContain("CTO");
		expect(html).toContain("record_skill");
		expect(html).toContain("203.0.113.7");
		expect(html).toContain("Example browser");
		expect(html).toContain("trace-1");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("handles absent or unrenderable metadata", () => {
		expect(formatAuditMetadata(null)).toBe("No metadata recorded");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(formatAuditMetadata(cyclic)).toBe("Metadata could not be displayed");
	});
});

describe("AuditFilters", () => {
	const noop = () => undefined;

	it("seeds the drafts from the applied URL values", () => {
		const html = renderToStaticMarkup(
			<AuditFilters
				appliedAction="record_skill"
				appliedResourceType="skill"
				onApply={noop}
				onClear={noop}
			/>,
		);
		expect(html).toContain('value="record_skill"');
		expect(html).toContain('value="skill"');
		expect(html).toContain(">Clear<");
	});

	it("shows the 'all' sentinel as an empty resource-type draft with no Clear", () => {
		const html = renderToStaticMarkup(
			<AuditFilters
				appliedAction=""
				appliedResourceType="all"
				onApply={noop}
				onClear={noop}
			/>,
		);
		expect(html).not.toContain('value="all"');
		expect(html).not.toContain(">Clear<");
	});

	it("uses integrated Kumo fields inside one bounded operational toolbar", () => {
		const html = renderToStaticMarkup(
			<AuditFilters
				appliedAction=""
				appliedResourceType="all"
				onApply={noop}
				onClear={noop}
			/>,
		);
		// The closed phone disclosure does not mount hidden form controls; the
		// desktop lane remains the only rendered form in the default view.
		expect(html.match(/data-slot="input"/g)).toHaveLength(2);
		expect(html).toContain(">Action<");
		expect(html).toContain(">Resource type<");
		expect(html).toContain('data-slot="page-toolbar"');
		expect(html).toContain('data-tier="well"');
		expect(html).toContain('aria-label="Audit filters"');
		expect(html).toContain("border-kumo-line");
		expect(html).not.toContain("border-kumo-hairline");
		expect(html).not.toContain("rounded-lg border border-kumo-line p-3");
	});

	it("collapses default phone filters behind a labelled Kumo disclosure", () => {
		const html = renderToStaticMarkup(
			<AuditFilters
				appliedAction=""
				appliedResourceType="all"
				onApply={noop}
				onClear={noop}
			/>,
		);
		expect(html).toContain('data-kumo-component="CollapsibleTrigger"');
		expect(html).toContain("All actions · all resource types");
		expect(html).toContain("md:hidden");
		expect(html).toContain("hidden md:block");
	});

	it("summarizes applied phone filters and renders their clear action", () => {
		const html = renderToStaticMarkup(
			<AuditFilters
				appliedAction="record_skill"
				appliedResourceType="skill"
				onApply={noop}
				onClear={noop}
			/>,
		);
		expect(html).toContain("2 active · record_skill · Skill");
		expect(html).toContain("rotate-180");
		expect(html).toContain('data-appearance="inline"');
		expect(html.match(/data-slot="input"/g)).toHaveLength(4);
		expect(html).toContain(">Clear<");
	});

	it("uses the canonical xl operational-table page grammar", () => {
		const doc = renderAuditPage();
		const page = doc.querySelector('[data-slot="page"]');
		expect(page?.className).toBe(kumoClass(<Page width="xl" />));
		const surface = getOsSurface("audit");
		expect(doc.querySelector("h1")?.textContent).toBe(surface.label);
		expect(doc.body.textContent).toContain(surface.description);
		// The header refresh action keeps the default control size.
		const refresh = [...doc.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Refresh"),
		);
		expect(refresh?.className).toBe(
			kumoClass(<Button variant="outline">Refresh</Button>),
		);
	});
});

describe("AuditPage", () => {
	it("uses the public Kumo tabs for resource facets", () => {
		const doc = renderAuditPage();
		const group = doc.querySelector(
			'[role="group"][aria-label="Resource type"]',
		);
		expect(group?.querySelector('[data-kumo-component="Tabs"]')).not.toBeNull();
		expect(group?.textContent).toContain("All");
		expect(group?.textContent).toContain("App");
		expect(group?.textContent).toContain("Skill");
	});
});

describe("AuditEmpty", () => {
	it("explains the empty trail without implying failure", () => {
		const html = renderToStaticMarkup(<AuditEmpty filtered={false} />);
		expect(html).toContain("No audit events yet");
		expect(html).toContain("immutable org event log");
		expect(html).toContain('data-appearance="quiet"');
		expect(html).toContain("rounded-lg!");
		expect(html).toContain("bg-transparent!");
	});

	it("distinguishes a filtered miss from an empty trail", () => {
		expect(renderToStaticMarkup(<AuditEmpty filtered />)).toContain(
			"No audit events match this filter",
		);
	});
});

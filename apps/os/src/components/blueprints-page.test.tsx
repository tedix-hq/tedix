import type {
	OsBlueprintGalleryItem,
	OsBlueprintWithVisibility,
} from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsBlueprintDefinition,
	OsBlueprintExport,
	OsBlueprintPreflight,
	OsBlueprintRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const blueprintsApi = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	revise: vi.fn(),
	publish: vi.fn(),
	instantiate: vi.fn(),
	preflight: vi.fn(),
	setVisibility: vi.fn(),
	gallery: vi.fn(),
	instantiateFromGallery: vi.fn(),
	export: vi.fn(),
	import: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: { blueprints: blueprintsApi } },
}));

import {
	BlueprintRow,
	BlueprintsEmpty,
	BlueprintsPage,
	BLUEPRINTS_VISIBLE_PAGE_SIZE,
	blueprintPackageFilename,
	blueprintStatusVariant,
	definitionToDraft,
	draftToDefinition,
	draftValidationError,
	GalleryCard,
	GalleryEmpty,
	isConflictError,
	newGadgetDraft,
	parseListInput,
	revisionIndicator,
	serializeBlueprintPackage,
} from "./blueprints-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BLUEPRINT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_BLUEPRINT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REVISION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function preflightFixture(
	overrides: Partial<OsBlueprintPreflight> = {},
): OsBlueprintPreflight {
	return {
		blueprintId: BLUEPRINT_ID,
		revisionId: REVISION_ID,
		revision: 2,
		status: "ready",
		instantiateAllowed: true,
		targetTediId: null,
		requirements: baseDefinition.requirements,
		decisions: [],
		blockingReasons: [],
		consentReasons: [],
		configurationReasons: [],
		resolvedAt: "2026-08-13T10:00:00.000Z",
		...overrides,
	};
}

const baseDefinition: OsBlueprintDefinition = {
	gadgets: [
		{
			name: "Report",
			manifest: {
				capabilities: ["outputs.write"],
				entry: "gadgets/report.tsx",
			},
		},
	],
	requirements: {
		version: 1,
		skills: [
			{
				role: "skill",
				skillId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				slug: "weekly-digest",
				revision: 4,
				workflowSha256: null,
			},
		],
		connections: [],
		policies: [{ scope: "organization", slug: "approval-finance", version: 1 }],
		runtime: null,
		layout: null,
		outputs: [],
	},
};

function blueprintFixture(
	overrides: Partial<OsBlueprintWithVisibility> = {},
): OsBlueprintWithVisibility {
	return {
		id: BLUEPRINT_ID,
		organizationId: "org-1",
		name: "Reporting workspace",
		description: "Weekly reporting pod",
		status: "draft",
		visibility: "org",
		currentRevisionId: REVISION_ID,
		lineage: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-12T10:00:00.000Z",
		...overrides,
	};
}

function galleryItemFixture(
	overrides: Partial<OsBlueprintGalleryItem> = {},
): OsBlueprintGalleryItem {
	return {
		id: OTHER_BLUEPRINT_ID,
		name: "Sales Pod",
		description: "Shared sales pod",
		gadgetCount: 2,
		organizationName: "Second Org",
		publishedAt: "2026-08-13T09:00:00.000Z",
		...overrides,
	};
}

function revisionFixture(
	overrides: Partial<OsBlueprintRevision> = {},
): OsBlueprintRevision {
	return {
		id: REVISION_ID,
		organizationId: "org-1",
		blueprintId: BLUEPRINT_ID,
		revision: 2,
		definition: baseDefinition,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-10T10:00:00.000Z",
		publishedAt: null,
		...overrides,
	};
}

function portableExportFixture(): OsBlueprintExport {
	return {
		envelopeVersion: 1,
		exportedAt: "2026-08-17T20:00:00.000Z",
		exportedByKind: "user",
		source: {
			organizationId: "org-1",
			organizationName: "Source Org",
			blueprintId: BLUEPRINT_ID,
			blueprintName: "Reporting workspace",
			revisionId: REVISION_ID,
			revision: 2,
			definitionSha256: "a".repeat(64),
			forkedAt: "2026-08-17T20:00:00.000Z",
			via: "export",
			attested: true,
		},
		blueprint: {
			name: "Reporting workspace",
			description: "Weekly reporting pod",
			status: "draft",
		},
		revision: {
			revision: 2,
			createdAt: "2026-08-10T10:00:00.000Z",
			publishedAt: null,
			createdByKind: "user",
		},
		definition: baseDefinition,
		lineage: null,
	};
}

// ---------------------------------------------------------------------------
// Interactive harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderPage(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<BlueprintsPage />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function findButton(container: Element, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((button) =>
		(button.textContent ?? "").includes(label),
	);
	if (!match) throw new Error(`button not found: ${label}`);
	return match;
}

function click(element: Element) {
	if (!(element instanceof HTMLElement))
		throw new Error("click target missing");
	act(() => {
		element.click();
	});
}

function fieldByLabel(
	container: Element,
	label: string,
): HTMLInputElement | HTMLTextAreaElement {
	const node = container.querySelector(`[aria-label="${label}"]`);
	const field =
		node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
			? node
			: node?.querySelector("input, textarea");
	if (
		!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
	) {
		throw new Error(`field not found: ${label}`);
	}
	return field;
}

/** Prototype-setter write + input event so React's value tracker sees the change. */
function setFieldValue(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	const proto =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (!setter) throw new Error("value setter missing");
	act(() => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeEach(() => {
	for (const mock of Object.values(blueprintsApi)) {
		mock.mockReset();
	}
	blueprintsApi.preflight.mockResolvedValue({ preflight: preflightFixture() });
});

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseListInput", () => {
	it("splits on commas and newlines, trims, and drops empties", () => {
		expect(parseListInput("a, b\n c,,\n")).toEqual(["a", "b", "c"]);
		expect(parseListInput("")).toEqual([]);
	});
});

describe("definition draft mapping", () => {
	it("round-trips a definition through the draft shape", () => {
		const draft = definitionToDraft(baseDefinition);
		expect(draft.gadgets).toHaveLength(1);
		expect(draft.gadgets[0]).toMatchObject({
			name: "Report",
			entry: "gadgets/report.tsx",
			capabilities: "outputs.write",
			notes: "",
		});
		// The editor authors gadgets; it carries the pins through byte-identically
		// rather than re-deriving them from operator text that cannot express one.
		expect(draft.requirements).toEqual(baseDefinition.requirements);
		expect(draftToDefinition(draft)).toEqual(baseDefinition);
	});

	it("starts empty for a blueprint with no revision", () => {
		expect(definitionToDraft(null)).toEqual({
			gadgets: [],
			requirements: null,
		});
	});

	it("omits empty notes, parses capability CSV, and preserves the pins", () => {
		const gadget = {
			...newGadgetDraft(),
			name: "  Board ",
			entry: " gadgets/board.tsx ",
			capabilities: "outputs.write, kernel.read",
			notes: "  ",
		};
		const noted = { ...newGadgetDraft(), ...gadget, notes: "keep me" };
		const definition = draftToDefinition({
			gadgets: [gadget, noted],
			requirements: baseDefinition.requirements,
		});
		expect(definition.gadgets[0]).toEqual({
			name: "Board",
			manifest: {
				capabilities: ["outputs.write", "kernel.read"],
				entry: "gadgets/board.tsx",
			},
		});
		expect(definition.gadgets[1]?.manifest.notes).toBe("keep me");
		expect(definition.requirements).toEqual(baseDefinition.requirements);
	});
});

describe("draftValidationError", () => {
	it("requires a name and entry on every gadget, by position", () => {
		const empty = { ...newGadgetDraft() };
		expect(draftValidationError({ gadgets: [empty], requirements: null })).toBe(
			"Gadget 1 needs a name",
		);
		expect(
			draftValidationError({
				gadgets: [{ ...empty, name: "x" }],
				requirements: null,
			}),
		).toBe("Gadget 1 needs an entry point");
		expect(
			draftValidationError({ gadgets: [], requirements: null }),
		).toBeNull();
	});
});

describe("status and conflict helpers", () => {
	it("maps every lifecycle status to a badge variant", () => {
		expect(blueprintStatusVariant("draft")).toBe("info");
		expect(blueprintStatusVariant("published")).toBe("success");
		expect(blueprintStatusVariant("archived")).toBe("secondary");
	});

	it("labels the revision indicator honestly", () => {
		expect(revisionIndicator(REVISION_ID)).toBe("Revision recorded");
		expect(revisionIndicator(null)).toBe("No revision yet");
	});

	it("recognizes only the typed CONFLICT error", () => {
		expect(isConflictError({ code: "CONFLICT" })).toBe(true);
		expect(isConflictError({ code: "BAD_REQUEST" })).toBe(false);
		expect(isConflictError(new Error("boom"))).toBe(false);
		expect(isConflictError(null)).toBe(false);
	});

	it("uses a stable portable filename and deterministic pretty JSON", () => {
		expect(blueprintPackageFilename(" Reporting / Workspace ", 2)).toBe(
			"reporting-workspace-r2.tedix-blueprint.json",
		);
		const serialized = serializeBlueprintPackage(portableExportFixture());
		expect(serialized).toContain('"envelopeVersion": 1');
		expect(serialized.endsWith("\n")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

describe("BlueprintRow", () => {
	it("renders name, description, status badge, revision indicator, and time", () => {
		const html = renderToStaticMarkup(
			<BlueprintRow blueprint={blueprintFixture()} />,
		);
		expect(html).toContain("Reporting workspace");
		expect(html).toContain("Weekly reporting pod");
		expect(html).toContain('data-status="draft"');
		expect(html).toContain("Draft");
		expect(html).toContain("Revision recorded");
		expect(html).toContain('dateTime="2026-08-12T10:00:00.000Z"');
		expect(html).not.toContain("aria-expanded");
		expect(html.indexOf("Reporting workspace")).toBeLessThan(
			html.indexOf('data-status="draft"'),
		);
		expect(html).toContain(">Open<");
	});

	it("states the missing revision instead of hiding it", () => {
		const html = renderToStaticMarkup(
			<BlueprintRow
				blueprint={blueprintFixture({ currentRevisionId: null })}
			/>,
		);
		expect(html).toContain("No revision yet");
	});

	it("flags catalog-visible blueprints with the In gallery badge", () => {
		expect(
			renderToStaticMarkup(<BlueprintRow blueprint={blueprintFixture()} />),
		).not.toContain("In gallery");
		expect(
			renderToStaticMarkup(
				<BlueprintRow
					blueprint={blueprintFixture({
						status: "published",
						visibility: "catalog",
					})}
				/>,
			),
		).toContain("In gallery");
	});
});

describe("GalleryCard", () => {
	it("renders only boundary-safe fields: name, org, gadget count, description, time", () => {
		const html = renderToStaticMarkup(
			<GalleryCard item={galleryItemFixture()} />,
		);
		// The gallery card composes the `Surface` adapter, which owns the
		// boundary; the class literal it used to spell out by hand is gone on
		// purpose. The protection is unchanged: a gallery tile is a nested well
		// in the gallery grid, so it stays on the 8px control tier and never
		// takes the 12px card tier.
		expect(html).toContain('data-slot="surface"');
		expect(html).toContain('data-tier="well"');
		expect(html).toContain("blueprint-gallery-card");
		expect(html).toContain("rounded-lg");
		expect(html).not.toContain("rounded-xl");
		expect(html).toContain("Sales Pod");
		expect(html).toContain("by Second Org");
		expect(html).toContain("2 gadgets");
		expect(html).toContain("Shared sales pod");
		expect(html).toContain('dateTime="2026-08-13T09:00:00.000Z"');
	});

	it("omits the missing description and publish time without breaking", () => {
		const html = renderToStaticMarkup(
			<GalleryCard
				item={galleryItemFixture({
					description: null,
					publishedAt: null,
					gadgetCount: 1,
				})}
			/>,
		);
		expect(html).toContain("1 gadget");
		expect(html).not.toContain("published");
	});
});

describe("GalleryEmpty", () => {
	it("explains the empty gallery without implying failure", () => {
		expect(renderToStaticMarkup(<GalleryEmpty />)).toContain(
			"The gallery is empty",
		);
	});
});

describe("BlueprintsEmpty", () => {
	it("explains the empty list without implying failure", () => {
		expect(renderToStaticMarkup(<BlueprintsEmpty />)).toContain(
			"No blueprints yet",
		);
	});
});

// ---------------------------------------------------------------------------
// Page behavior (mocked osApi)
// ---------------------------------------------------------------------------

describe("BlueprintsPage list", () => {
	it("progressively discloses a long owned inventory", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: Array.from({ length: 18 }, (_, index) =>
				blueprintFixture({
					id: `blueprint-${index}`,
					name: `Blueprint ${index + 1}`,
				}),
			),
			truncated: false,
		});
		const container = renderPage();
		await flush();

		const list = container.querySelector('[data-slot="blueprint-owned-list"]');
		expect(list?.children).toHaveLength(BLUEPRINTS_VISIBLE_PAGE_SIZE);
		expect(container.textContent).toContain("Showing 15 of 18 blueprints");
		const libraryToolbar = container.querySelector(
			'[data-slot="page-toolbar"][aria-label="Blueprint library controls"]',
		);
		expect(
			libraryToolbar?.querySelector('input[aria-label="Search blueprints"]'),
		).not.toBeNull();
		expect(libraryToolbar?.textContent).toContain(
			"Showing 15 of 18 blueprints",
		);
		click(findButton(container, "Show more"));
		expect(list?.children).toHaveLength(18);
		expect(libraryToolbar?.textContent).toContain(
			"Showing 18 of 18 blueprints",
		);
		setFieldValue(fieldByLabel(container, "Search blueprints"), "Blueprint");
		expect(list?.children).toHaveLength(BLUEPRINTS_VISIBLE_PAGE_SIZE);
	});

	it("delegates the owned inventory boundary to the Kumo collection", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		const container = renderPage();
		await flush();

		const list = container.querySelector('[data-slot="blueprint-owned-list"]');
		expect(list?.getAttribute("aria-label")).toBe("Owned blueprints");
		expect(list?.className).toContain("rounded-lg");
		expect(list?.className).not.toContain("rounded-xl");
	});

	it("replaces a failed cold load with an actionable retry", async () => {
		blueprintsApi.list
			.mockRejectedValueOnce(new Error("API request timed out after 15000ms"))
			.mockResolvedValueOnce({
				items: [blueprintFixture()],
				truncated: false,
			});
		const container = renderPage();
		await flush();

		expect(container.textContent).toContain("Blueprints are unavailable");
		expect(container.textContent).toContain(
			"API request timed out after 15000ms",
		);
		click(findButton(container, "Try again"));
		await flush();

		expect(blueprintsApi.list).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Reporting workspace");
	});

	it("renders every listed blueprint and passes the explicit limit", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [
				blueprintFixture(),
				blueprintFixture({
					id: OTHER_BLUEPRINT_ID,
					name: "Ops pod",
					status: "published",
				}),
			],
			truncated: false,
		});
		const container = renderPage();
		await flush();
		expect(blueprintsApi.list).toHaveBeenCalledWith(
			{ limit: 100 },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain("Reporting workspace");
		expect(container.textContent).toContain("Ops pod");
		expect(container.textContent).toContain("My blueprints");
		expect(
			container.querySelector('[data-slot="section-header"]'),
		).not.toBeNull();
		expect(container.querySelector("ul.divide-y.border")).not.toBeNull();
	});

	it("filters the inventory without misreporting a search miss as an empty library", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		const container = renderPage();
		await flush();

		const search = fieldByLabel(container, "Search blueprints");
		expect(
			search.closest('[data-kumo-component="SearchInput"]')?.className,
		).toContain("sm:w-64 sm:shrink-0");
		setFieldValue(search, "finance");

		expect(container.textContent).toContain("No blueprints match “finance”.");
		expect(container.textContent).toContain(
			"Showing 0 of 0 matching blueprints",
		);
		expect(container.textContent).not.toContain("No blueprints yet");
	});

	it("shows the empty state when no blueprints exist", async () => {
		blueprintsApi.list.mockResolvedValue({ items: [], truncated: false });
		const container = renderPage();
		await flush();
		expect(container.textContent).toContain("No blueprints yet");
	});
});

describe("create flow", () => {
	it("submits the trimmed name and description and closes the form", async () => {
		blueprintsApi.list.mockResolvedValue({ items: [], truncated: false });
		blueprintsApi.create.mockResolvedValue({ blueprint: blueprintFixture() });
		const container = renderPage();
		await flush();

		click(findButton(container, "New blueprint"));
		setFieldValue(
			fieldByLabel(container, "Blueprint name"),
			"  Reporting workspace ",
		);
		setFieldValue(
			fieldByLabel(container, "Blueprint description"),
			"Weekly reporting pod",
		);
		click(findButton(container, "Create blueprint"));
		await flush();

		expect(blueprintsApi.create).toHaveBeenCalledWith({
			name: "Reporting workspace",
			description: "Weekly reporting pod",
		});
		expect(container.querySelector('[aria-label="Blueprint name"]')).toBeNull();
	});
});

describe("portable package flow", () => {
	it("downloads the current revision through the canonical export verb", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture(),
			currentRevision: revisionFixture(),
		});
		blueprintsApi.export.mockResolvedValue({
			export: portableExportFixture(),
		});
		const createObjectUrl = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:portable-blueprint");
		const revokeObjectUrl = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation(() => undefined);
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();
		const detail = container.querySelector('[data-slot="blueprint-detail"]');
		expect(detail?.className).toContain("rounded-lg");
		expect(detail?.className).not.toContain("rounded-xl");
		click(findButton(container, "Export package"));
		await flush();

		expect(blueprintsApi.export).toHaveBeenCalledWith({
			blueprintId: BLUEPRINT_ID,
			revisionId: REVISION_ID,
		});
		expect(createObjectUrl).toHaveBeenCalledTimes(1);
		expect(anchorClick).toHaveBeenCalledTimes(1);
		expect(revokeObjectUrl).toHaveBeenCalledWith("blob:portable-blueprint");
		expect(container.textContent).toContain("Portable package downloaded.");
		anchorClick.mockRestore();
		revokeObjectUrl.mockRestore();
		createObjectUrl.mockRestore();
	});

	it("parses a package, imports it under an override, and closes the form", async () => {
		blueprintsApi.list.mockResolvedValue({ items: [], truncated: false });
		const imported = blueprintFixture({
			id: OTHER_BLUEPRINT_ID,
			name: "Imported reporting workspace",
		});
		blueprintsApi.import.mockResolvedValue({
			blueprint: imported,
			revision: revisionFixture({
				id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				blueprintId: OTHER_BLUEPRINT_ID,
				revision: 1,
			}),
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Import package"));
		const fileInput = fieldByLabel(
			container,
			"Portable Blueprint package",
		) as HTMLInputElement;
		const file = new File(
			[serializeBlueprintPackage(portableExportFixture())],
			"reporting.tedix-blueprint.json",
			{ type: "application/json" },
		);
		Object.defineProperty(fileInput, "files", {
			configurable: true,
			value: [file],
		});
		act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
		setFieldValue(
			fieldByLabel(container, "Imported Blueprint name"),
			" Imported reporting workspace ",
		);
		const importButtons = [...container.querySelectorAll("button")].filter(
			(button) => (button.textContent ?? "").includes("Import package"),
		);
		click(importButtons.at(-1) as HTMLButtonElement);
		await flush();

		expect(blueprintsApi.import).toHaveBeenCalledWith({
			export: portableExportFixture(),
			name: "Imported reporting workspace",
		});
		expect(
			container.querySelector('[aria-label="Portable Blueprint package"]'),
		).toBeNull();
	});
});

describe("definition editing", () => {
	it("emits the revise payload built from the edited draft with the CAS guard", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture(),
			currentRevision: revisionFixture({ revision: 2 }),
		});
		blueprintsApi.revise.mockResolvedValue({
			blueprint: blueprintFixture(),
			revision: revisionFixture({ revision: 3 }),
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		setFieldValue(fieldByLabel(container, "Gadget 1 name"), "Report v2");
		click(findButton(container, "Save definition"));
		await flush();

		expect(blueprintsApi.revise).toHaveBeenCalledWith({
			blueprintId: BLUEPRINT_ID,
			definition: {
				gadgets: [
					{
						name: "Report v2",
						manifest: {
							capabilities: ["outputs.write"],
							entry: "gadgets/report.tsx",
						},
					},
				],
				requirements: baseDefinition.requirements,
			},
			expectedRevision: 2,
		});
	});

	it("surfaces a lost CAS as the reload-and-retry conflict alert", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture(),
			currentRevision: revisionFixture(),
		});
		blueprintsApi.revise.mockRejectedValue({
			code: "CONFLICT",
			data: { expectedRevision: 2, currentRevision: 3 },
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();
		click(findButton(container, "Save definition"));
		await flush();

		expect(container.textContent).toContain("Revision conflict");
		const getCallsBefore = blueprintsApi.get.mock.calls.length;
		click(findButton(container, "Reload latest"));
		await flush();
		expect(blueprintsApi.get.mock.calls.length).toBeGreaterThan(getCallsBefore);
	});
});

describe("publish gating", () => {
	it("disables publish until a revision exists and explains why", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture({ currentRevisionId: null })],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture({ currentRevisionId: null }),
			currentRevision: null,
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		expect(findButton(container, "Publish").disabled).toBe(true);
		expect(container.textContent).toContain(
			"Record a definition revision before publishing.",
		);
	});

	it("publishes a revised draft on click", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture(),
			currentRevision: revisionFixture(),
		});
		blueprintsApi.publish.mockResolvedValue({
			blueprint: blueprintFixture({ status: "published" }),
			revision: revisionFixture({ publishedAt: "2026-08-13T09:00:00.000Z" }),
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		const publishButton = findButton(container, "Publish");
		expect(publishButton.disabled).toBe(false);
		click(publishButton);
		await flush();

		expect(blueprintsApi.publish).toHaveBeenCalledWith({
			blueprintId: BLUEPRINT_ID,
		});
	});
});

describe("instantiate", () => {
	function mockPublishedBlueprint() {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture({ status: "published" })],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture({ status: "published" }),
			currentRevision: revisionFixture({
				publishedAt: "2026-08-13T09:00:00.000Z",
			}),
		});
	}

	it("shows the created workspace name, id, and gadget count", async () => {
		mockPublishedBlueprint();
		blueprintsApi.instantiate.mockResolvedValue({
			workspace: { id: WORKSPACE_ID, name: "Ops room" },
			blueprint: blueprintFixture({ status: "published" }),
			revision: revisionFixture(),
			gadgets: [{}, {}],
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		setFieldValue(fieldByLabel(container, "Workspace name"), "Ops room");
		click(findButton(container, "Instantiate workspace"));
		await flush();

		expect(blueprintsApi.instantiate).toHaveBeenCalledWith({
			blueprintId: BLUEPRINT_ID,
			workspaceName: "Ops room",
		});
		expect(container.textContent).toContain("Created workspace");
		expect(container.textContent).toContain("Ops room");
		expect(container.textContent).toContain(WORKSPACE_ID);
		expect(container.textContent).toContain("2 gadgets");
		expect(
			container.querySelector(`a[href="/workspace/${WORKSPACE_ID}"]`)
				?.textContent,
		).toContain("Open workspace");
	});

	it("shows a blocked pin and prevents an observed invalid instantiation", async () => {
		mockPublishedBlueprint();
		blueprintsApi.preflight.mockResolvedValue({
			preflight: preflightFixture({
				status: "blocked",
				instantiateAllowed: false,
				blockingReasons: ["Pinned skill revision moved"],
				decisions: [
					{
						kind: "skill",
						subject: "weekly-digest",
						verdict: "incompatible",
						reason: "Pinned skill revision moved",
					},
				],
			}),
		});
		const container = renderPage();
		await flush();
		click(findButton(container, "Reporting workspace"));
		await flush();
		setFieldValue(fieldByLabel(container, "Workspace name"), "Ops room");
		expect(container.textContent).toContain(
			"Pinned requirements need attention",
		);
		expect(container.textContent).toContain("Pinned skill revision moved");
		expect(findButton(container, "Instantiate workspace").disabled).toBe(true);
		expect(blueprintsApi.instantiate).not.toHaveBeenCalled();
	});

	it("allows creation with connection consent outstanding and links setup", async () => {
		mockPublishedBlueprint();
		blueprintsApi.preflight.mockResolvedValue({
			preflight: preflightFixture({
				status: "needs_consent",
				consentReasons: ["Google needs user consent"],
				requirements: {
					...baseDefinition.requirements!,
					connections: [
						{
							providerId: "google",
							tokenScope: "user",
							scopes: ["gmail.readonly"],
						},
					],
				},
			}),
		});
		const container = renderPage();
		await flush();
		click(findButton(container, "Reporting workspace"));
		await flush();
		setFieldValue(fieldByLabel(container, "Workspace name"), "Ops room");
		expect(container.textContent).toContain(
			"Connections need consent after creation",
		);
		expect(
			container.querySelector('a[href="/account/connections"]'),
		).not.toBeNull();
		expect(findButton(container, "Instantiate workspace").disabled).toBe(false);
	});

	it("keeps an incomplete resource selection unresolved", async () => {
		mockPublishedBlueprint();
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture({ status: "published" }),
			currentRevision: revisionFixture({
				definition: {
					...baseDefinition,
					requirements: {
						...baseDefinition.requirements!,
						resources: [
							{
								slot: "primary_repo",
								providerId: "github",
								tokenScope: "user",
								scopes: [],
								resourceType: "repo",
								label: "Primary repo",
							},
						],
					},
				},
			}),
		});
		blueprintsApi.preflight.mockResolvedValue({
			preflight: preflightFixture({
				status: "needs_configuration",
				instantiateAllowed: false,
				configurationReasons: ["Select a primary repo"],
			}),
		});
		const container = renderPage();
		await flush();
		click(findButton(container, "Reporting workspace"));
		await flush();
		expect(container.textContent).toContain("Select the required resources");
		expect(blueprintsApi.preflight).toHaveBeenCalledWith(
			expect.objectContaining({
				blueprintId: BLUEPRINT_ID,
				resourceBindings: [],
			}),
			expect.anything(),
		);
		setFieldValue(fieldByLabel(container, "Workspace name"), "Ops room");
		expect(findButton(container, "Instantiate workspace").disabled).toBe(true);
	});

	it("surfaces a taken workspace name inline", async () => {
		mockPublishedBlueprint();
		blueprintsApi.instantiate.mockRejectedValue({ code: "CONFLICT" });
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		setFieldValue(fieldByLabel(container, "Workspace name"), "Ops room");
		click(findButton(container, "Instantiate workspace"));
		await flush();

		expect(container.textContent).toContain(
			"That workspace name is already taken",
		);
	});

	it("shows the server rejection when requirements drift after a ready check", async () => {
		mockPublishedBlueprint();
		blueprintsApi.instantiate.mockRejectedValue({
			code: "UNPROCESSABLE_CONTENT",
			message: "Pinned skill revision moved",
		});
		const container = renderPage();
		await flush();
		click(findButton(container, "Reporting workspace"));
		await flush();
		setFieldValue(fieldByLabel(container, "Workspace name"), "Ops room");
		expect(container.textContent).toContain("Ready to create");
		click(findButton(container, "Instantiate workspace"));
		await flush();
		expect(container.textContent).toContain("Pinned skill revision moved");
		expect(container.textContent).not.toContain("Created workspace");
	});
});

describe("gallery visibility toggle", () => {
	it("publishes a published blueprint to the gallery", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture({ status: "published" })],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture({ status: "published" }),
			currentRevision: revisionFixture({
				publishedAt: "2026-08-13T09:00:00.000Z",
			}),
		});
		blueprintsApi.setVisibility.mockResolvedValue({
			blueprint: blueprintFixture({
				status: "published",
				visibility: "catalog",
			}),
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		expect(container.textContent).toContain("Private to your organization.");
		click(findButton(container, "Publish to gallery"));
		await flush();

		expect(blueprintsApi.setVisibility).toHaveBeenCalledWith({
			blueprintId: BLUEPRINT_ID,
			visibility: "catalog",
		});
	});

	it("retracts a catalog blueprint and shows its gallery state", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture({ status: "published", visibility: "catalog" })],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture({
				status: "published",
				visibility: "catalog",
			}),
			currentRevision: revisionFixture({
				publishedAt: "2026-08-13T09:00:00.000Z",
			}),
		});
		blueprintsApi.setVisibility.mockResolvedValue({
			blueprint: blueprintFixture({ status: "published", visibility: "org" }),
		});
		const container = renderPage();
		await flush();

		expect(container.textContent).toContain("In gallery");
		click(findButton(container, "Reporting workspace"));
		await flush();

		expect(container.textContent).toContain(
			"Listed in the cross-organization Explore gallery.",
		);
		click(findButton(container, "Remove from gallery"));
		await flush();

		expect(blueprintsApi.setVisibility).toHaveBeenCalledWith({
			blueprintId: BLUEPRINT_ID,
			visibility: "org",
		});
	});

	it("never offers the toggle on a draft blueprint", async () => {
		blueprintsApi.list.mockResolvedValue({
			items: [blueprintFixture()],
			truncated: false,
		});
		blueprintsApi.get.mockResolvedValue({
			blueprint: blueprintFixture(),
			currentRevision: revisionFixture(),
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Reporting workspace"));
		await flush();

		expect(container.textContent).not.toContain("Publish to gallery");
	});
});

describe("explore tab", () => {
	it("lists gallery cards and instantiates a copy from one", async () => {
		blueprintsApi.list.mockResolvedValue({ items: [], truncated: false });
		blueprintsApi.gallery.mockResolvedValue({
			items: [galleryItemFixture()],
		});
		blueprintsApi.instantiateFromGallery.mockResolvedValue({
			workspace: { id: WORKSPACE_ID, name: "Ops room" },
			blueprint: blueprintFixture(),
			revision: revisionFixture(),
			gadgets: [{}, {}],
		});
		const container = renderPage();
		await flush();

		// The gallery loads lazily with the tab.
		expect(blueprintsApi.gallery).not.toHaveBeenCalled();
		click(findButton(container, "Explore"));
		await flush();

		expect(blueprintsApi.gallery).toHaveBeenCalledWith(
			{ limit: 100 },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain("Sales Pod");
		expect(container.textContent).toContain("by Second Org");
		expect(container.textContent).toContain("2 gadgets");
		expect(container.textContent).toContain("Published blueprints");
		expect(container.textContent).not.toContain("Featured");
		const gallerySearch = fieldByLabel(container, "Search blueprint gallery");
		expect(
			gallerySearch.closest(
				'[data-slot="page-toolbar"][aria-label="Blueprint gallery controls"]',
			),
		).not.toBeNull();
		expect(container.textContent).toContain("1 of 1 loaded blueprints");
		expect(
			gallerySearch.closest('[data-kumo-component="SearchInput"]')?.className,
		).toContain("sm:w-64 sm:shrink-0");
		setFieldValue(gallerySearch, "sales");
		expect(container.textContent).toContain("Sales Pod");

		setFieldValue(
			fieldByLabel(container, "Workspace name for Sales Pod"),
			"Ops room",
		);
		click(findButton(container, "Instantiate workspace"));
		await flush();

		expect(blueprintsApi.instantiateFromGallery).toHaveBeenCalledWith({
			blueprintId: OTHER_BLUEPRINT_ID,
			workspaceName: "Ops room",
		});
		expect(container.textContent).toContain("Created workspace");
		expect(container.textContent).toContain(
			"The blueprint was copied into your organization.",
		);
	});

	it("shows the empty gallery state", async () => {
		blueprintsApi.list.mockResolvedValue({ items: [], truncated: false });
		blueprintsApi.gallery.mockResolvedValue({ items: [] });
		const container = renderPage();
		await flush();

		click(findButton(container, "Explore"));
		await flush();

		expect(container.textContent).toContain("The gallery is empty");
	});

	it("surfaces a taken workspace name inline on a gallery card", async () => {
		blueprintsApi.list.mockResolvedValue({ items: [], truncated: false });
		blueprintsApi.gallery.mockResolvedValue({
			items: [galleryItemFixture()],
		});
		blueprintsApi.instantiateFromGallery.mockRejectedValue({
			code: "CONFLICT",
		});
		const container = renderPage();
		await flush();

		click(findButton(container, "Explore"));
		await flush();

		setFieldValue(
			fieldByLabel(container, "Workspace name for Sales Pod"),
			"Ops room",
		);
		click(findButton(container, "Instantiate workspace"));
		await flush();

		expect(container.textContent).toContain(
			"That workspace name is already taken",
		);
	});
});

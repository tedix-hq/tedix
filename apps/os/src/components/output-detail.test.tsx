import type {
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVISION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const harness = vi.hoisted(() => ({
	detail: null as unknown,
	workspace: null as unknown,
	save: vi.fn(),
	clearOutcome: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: { queryKey: string[] }) =>
		options.queryKey[0] === "workspace" ? harness.workspace : harness.detail,
}));

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ outputId: OUTPUT_ID }),
	Link: ({
		children,
		to,
		...props
	}: AnchorHTMLAttributes<HTMLAnchorElement> & {
		children?: ReactNode;
		to: string;
	}) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}));

vi.mock("@/lib/os-query-options", () => ({
	outputDetailQueryOptions: (outputId: string) => ({
		queryKey: ["output", outputId],
	}),
	workspaceDetailQueryOptions: (workspaceId: string) => ({
		queryKey: ["workspace", workspaceId],
	}),
}));

vi.mock("@/lib/use-revise-output", () => ({
	useReviseOutput: () => ({
		save: harness.save,
		saving: false,
		outcome: null,
		clearOutcome: harness.clearOutcome,
	}),
}));

vi.mock("@/components/output-content", () => ({
	OutputContentView: () => <div data-output-content>Output preview</div>,
}));

vi.mock("@/components/output-editor", () => ({
	OutputEditor: ({ value }: { value: OsOutputContent }) => (
		<div data-editor={value.kind}>Output editor</div>
	),
}));

vi.mock("@/components/output-export-buttons", () => ({
	OutputExportButtons: ({ compact }: { compact?: boolean }) => (
		<button type="button" data-compact={compact || undefined}>
			Export
		</button>
	),
}));

vi.mock("@/components/share-controls", () => ({
	ShareControls: ({ compact }: { compact?: boolean }) => (
		<button type="button" data-compact={compact || undefined}>
			Share
		</button>
	),
}));

vi.mock("@/components/cost-chip", () => ({
	CostChip: () => <span>Cost unavailable</span>,
}));

import { OutputDetailPage } from "./output-detail";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const content: OsOutputContent = {
	kind: "document",
	blocks: [{ type: "paragraph", text: "Workshop body" }],
};

const output: OsOutput = {
	id: OUTPUT_ID,
	organizationId: "org-1",
	workspaceId: WORKSPACE_ID,
	kind: "document",
	title: "Weekly report",
	status: "active",
	currentRevisionId: REVISION_ID,
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-12T10:00:00.000Z",
};

const currentRevision: OsOutputRevision = {
	id: REVISION_ID,
	organizationId: "org-1",
	outputId: OUTPUT_ID,
	revision: 3,
	content,
	note: null,
	producedBy: null,
	accessEnvelope: null,
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-08-10T10:00:00.000Z",
};

const cleanups: Array<() => void> = [];

function renderPage() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(<OutputDetailPage />));
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

function clickButton(container: Element, label: string) {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.textContent ?? "").includes(label),
	);
	if (!button) throw new Error(`button not found: ${label}`);
	act(() => button.click());
}

beforeEach(() => {
	harness.detail = {
		data: { output, currentRevision },
		isPending: false,
		isError: false,
		error: null,
	};
	harness.workspace = {
		data: {
			workspace: {
				id: WORKSPACE_ID,
				status: "active",
			},
		},
	};
	harness.save.mockReset();
	harness.clearOutcome.mockReset();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("OutputDetailPage", () => {
	it("shows the authorized Home run without calling it an output cost", () => {
		harness.detail = {
			data: {
				output,
				currentRevision,
				authoringHomeRun: { runId: "home-author" },
			},
		};
		const container = renderPage();
		expect(container.textContent).toContain("Authoring Home run");
		expect(container.textContent).toContain("No per-output cost allocation");
	});
	it("does not invent a Home link when no association is available", () => {
		expect(renderPage().textContent).not.toContain("Authoring Home run");
	});
	it("keeps the read-only detail in the standard route lane", () => {
		const container = renderPage();
		const page = container.querySelector('[data-slot="page"]');
		const back = container.querySelector("[data-page-back]");
		const title = container.querySelector('[data-slot="page-title"]');
		const description = container.querySelector(
			'[data-slot="page-description"]',
		);
		const meta = container.querySelector('[data-slot="page-meta"]');

		expect(page?.className).toContain("max-w-4xl");
		expect(page?.hasAttribute("data-full-height")).toBe(false);
		expect(container.querySelector('[data-slot="page-header"]')).not.toBeNull();
		expect(back?.textContent).toContain("All outputs");
		expect(title?.textContent).toBe("Weekly report");
		expect(description?.textContent).toContain(
			"Document · Revision 3 · by user",
		);
		expect(meta?.textContent).toContain("Cost unavailable");
		expect(container.querySelector(".eyebrow")).toBeNull();
		expect(container.querySelector("[data-output-content]")).not.toBeNull();
		expect(container.textContent).toContain("Open in workspace");
	});

	it("separates producer lineage from immutable revision identity", () => {
		harness.detail = {
			data: {
				output,
				currentRevision: {
					...currentRevision,
					producedBy: {
						skillId: "weekly-report",
						skillRunId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
					},
				},
			},
			isPending: false,
			isError: false,
			error: null,
		};
		const container = renderPage();

		expect(
			container.querySelector('[data-slot="page-description"]')?.textContent,
		).toContain("Revision 3 · by user");
		expect(
			container.querySelector('[data-slot="page-meta"]')?.textContent,
		).toContain("Produced by weekly-report · run dddddddd");
	});

	it("turns edit mode into a full-height edge-to-edge workshop", () => {
		const container = renderPage();
		clickButton(container, "Edit");

		const page = container.querySelector('[data-slot="page"]');
		expect(page?.className).toContain("max-w-none");
		expect(page?.className).toContain("output-detail-workshop");
		expect(page?.getAttribute("data-full-height")).toBe("true");
		expect(page?.getAttribute("data-output-kind")).toBe("document");
		expect(container.querySelector('[data-slot="page-header"]')).toBeNull();
		expect(
			container.querySelector('[data-slot="output-workshop-command-bar"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-slot="output-workshop-stage"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-slot="output-workshop-footer"]'),
		).not.toBeNull();
		expect(container.querySelector('[data-editor="document"]')).not.toBeNull();
		expect(container.textContent).toContain("Editing revision 3");
		expect(container.textContent).toContain("Document");
		expect(
			container.querySelector('input[aria-label="Revision note"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Save revision");

		clickButton(container, "Cancel");
		expect(container.querySelector(".output-detail-workshop")).toBeNull();
		expect(container.querySelector("[data-output-content]")).not.toBeNull();
		expect(harness.clearOutcome).toHaveBeenCalledTimes(2);
	});

	/*
	 * The not-found verdict moved out of the route loader,
	 * which could not tell a 404 from a cold-isolate timeout, into this query.
	 */
	it("owns the not-found verdict for a settled NOT_FOUND", () => {
		harness.detail = {
			data: undefined,
			isPending: false,
			isError: true,
			error: Object.assign(new Error("Output not found"), {
				code: "NOT_FOUND",
			}),
		};
		const container = renderPage();

		expect(container.textContent).toContain("Output not found");
		expect(container.querySelector("[data-output-content]")).toBeNull();
	});

	it("never calls a timed-out read not found", () => {
		harness.detail = {
			data: undefined,
			isPending: false,
			isError: true,
			error: new Error("The request timed out."),
		};
		const container = renderPage();

		expect(container.textContent).toContain("Output is unavailable");
		expect(container.textContent).toContain("The request timed out.");
		expect(container.textContent).not.toContain("not found");
	});

	it("renders the pending skeleton, not a verdict, while the read is outstanding", () => {
		harness.detail = {
			data: undefined,
			isPending: true,
			isError: false,
			error: null,
		};
		const container = renderPage();

		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.textContent).not.toContain("not found");
		expect(container.textContent).not.toContain("unavailable");
	});
});

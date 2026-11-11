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
	outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	detail: null as unknown,
	workspace: null as unknown,
	navigate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: { queryKey: string[] }) =>
		options.queryKey[0] === "workspace" ? harness.workspace : harness.detail,
}));

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ outputId: harness.outputId }),
	useNavigate: () => harness.navigate,
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

vi.mock("@/components/output-content", () => ({
	OutputContentView: () => <div data-output-content>Output preview</div>,
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
	return { container };
}

beforeEach(() => {
	harness.outputId = OUTPUT_ID;
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
	harness.navigate.mockReset();
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
		const { container } = renderPage();
		expect(container.textContent).toContain("See how it was made");
		expect(container.textContent).not.toContain("cost");
	});
	it("does not invent a Home link when no association is available", () => {
		expect(renderPage().container.textContent).not.toContain(
			"See how it was made",
		);
	});
	it("keeps the read-only detail in the standard route lane", () => {
		const { container } = renderPage();
		const page = container.querySelector('[data-slot="page"]');
		const back = container.querySelector("[data-page-back]");
		const title = container.querySelector('[data-slot="page-title"]');
		const description = container.querySelector(
			'[data-slot="page-description"]',
		);

		expect(page?.className).toContain("max-w-4xl");
		expect(page?.hasAttribute("data-full-height")).toBe(false);
		expect(container.querySelector('[data-slot="page-header"]')).not.toBeNull();
		expect(back?.textContent).toContain("All outputs");
		expect(title?.textContent).toBe("Weekly report");
		expect(description?.textContent).toContain(
			"Document · Version 3 · updated",
		);
		// No hashes, ids or empty cost chips in the read view.
		expect(container.querySelector('[data-slot="page-meta"]')).toBeNull();
		expect(container.textContent).not.toContain("sha256");
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
		const { container } = renderPage();

		expect(
			container.querySelector('[data-slot="page-description"]')?.textContent,
		).toContain("Version 3 · updated");
		expect(
			container.querySelector('[data-slot="page-meta"]')?.textContent,
		).toContain("Made by weekly-report");
		expect(container.textContent).not.toContain("dddddddd");
	});

	it("opens an output of an active workspace in its gadget", () => {
		renderPage();
		expect(harness.navigate).toHaveBeenCalledWith({
			to: "/workspace/$workspaceId",
			params: { workspaceId: WORKSPACE_ID },
			search: { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" },
			replace: true,
		});
	});

	it("keeps an output without an active workspace readable here", () => {
		harness.workspace = {
			data: { workspace: { id: WORKSPACE_ID, status: "archived" } },
		};
		const { container } = renderPage();
		expect(harness.navigate).not.toHaveBeenCalled();
		expect(container.querySelector("[data-output-content]")).not.toBeNull();
		expect(container.textContent).not.toContain("Edit");
	});

	it("owns the not-found verdict for a settled NOT_FOUND", () => {
		harness.detail = {
			data: undefined,
			isPending: false,
			isError: true,
			error: Object.assign(new Error("Output not found"), {
				code: "NOT_FOUND",
			}),
		};
		const { container } = renderPage();

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
		const { container } = renderPage();

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
		const { container } = renderPage();

		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.textContent).not.toContain("not found");
		expect(container.textContent).not.toContain("unavailable");
	});
});

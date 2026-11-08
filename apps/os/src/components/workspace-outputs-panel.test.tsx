import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CanvasDocSelection } from "@/lib/canvas-search";
import {
	isWorkspaceOutputsItemSelected,
	persistWorkspaceOutputsPanelExpanded,
	restoreWorkspaceOutputsPanelExpanded,
	WORKSPACE_OUTPUTS_EMPTY_COPY,
	WORKSPACE_OUTPUTS_PANEL_KEY,
	WorkspaceOutputsPanel,
	workspaceOutputsPanelItems,
} from "./workspace-outputs-panel";

vi.mock("./create-doc-app-dialog", () => ({
	CreateOutputAppDialog: ({
		workspaceId,
		kind = "document",
		onCreated,
		onOpenOutput,
		onClose,
	}: Parameters<
		typeof import("./create-doc-app-dialog").CreateOutputAppDialog
	>[0]) => (
		<div
			role="dialog"
			data-create-workspace={workspaceId}
			data-create-kind={kind}
		>
			<button
				onClick={() => {
					onCreated({
						id: `created-${kind}`,
						organizationId: "org",
						workspaceId: workspaceId!,
						name: "Created gadget",
						description: null,
						status: "active",
						currentRevisionId: "revision",
						sourceBlueprintRevisionId: null,
						createdByKind: "user",
						createdById: "user",
						createdAt: "2026-11-08",
						updatedAt: "2026-11-08",
					});
					onClose();
				}}
			>
				Create gadget
			</button>
			<button
				onClick={() => {
					onOpenOutput({
						id: "created-output",
						organizationId: "org",
						workspaceId: workspaceId!,
						kind,
						title: "Created file",
						status: "active",
						currentRevisionId: "revision",
						createdByKind: "user",
						createdById: "user",
						createdAt: "2026-11-08",
						updatedAt: "2026-11-08",
					});
					onClose();
				}}
			>
				Open file
			</button>
		</div>
	),
}));

const outputs = [
	{
		id: "old-doc",
		title: "Supplier note",
		kind: "document" as const,
		status: "active" as const,
		updatedAt: "2026-10-20T10:00:00.000Z",
	},
	{
		id: "new-deck",
		title: "Weekly review",
		kind: "presentation" as const,
		status: "active" as const,
		updatedAt: "2026-10-24T09:00:00.000Z",
	},
	{
		id: "archived-sheet",
		title: "Old stock count",
		kind: "sheet" as const,
		status: "archived" as const,
		updatedAt: "2026-10-24T11:00:00.000Z",
	},
];
const gadgets = [
	{ id: "app", name: "Reconciliation", updatedAt: "2026-10-01T00:00:00.000Z" },
];

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		values,
	};
}

describe("workspaceOutputsPanelItems", () => {
	it("shows a canonical file once and opens its bound gadget, while native deep links remain selected", () => {
		const items = workspaceOutputsPanelItems(
			outputs,
			gadgets,
			new Map([["old-doc", "app"]]),
		);
		expect(items.map((item) => item.key)).toEqual([
			"output:new-deck",
			"output:old-doc",
		]);
		const doc = items.find((item) => item.key === "output:old-doc")!;
		expect(doc.doc).toEqual({ type: "gadget", id: "app" });
		expect(doc.kindLabel).toBe("Doc");
		expect(
			isWorkspaceOutputsItemSelected(doc, { type: "output", id: "old-doc" }),
		).toBe(true);
	});
	it("lists apps first, then active outputs newest first", () => {
		const items = workspaceOutputsPanelItems(outputs, gadgets);
		expect(items.map((item) => item.key)).toEqual([
			"gadget:app",
			"output:new-deck",
			"output:old-doc",
		]);
		expect(items.map((item) => item.kindLabel)).toEqual([
			"App",
			"Slides",
			"Document",
		]);
	});
});

describe("panel state memory", () => {
	it("restores a remembered choice regardless of the viewport", () => {
		expect(
			restoreWorkspaceOutputsPanelExpanded(
				memoryStorage({ [WORKSPACE_OUTPUTS_PANEL_KEY]: "collapsed" }),
				1600,
			),
		).toBe(false);
		expect(
			restoreWorkspaceOutputsPanelExpanded(
				memoryStorage({ [WORKSPACE_OUTPUTS_PANEL_KEY]: "expanded" }),
				1000,
			),
		).toBe(true);
	});

	it("starts collapsed only where the stage would be cramped", () => {
		expect(restoreWorkspaceOutputsPanelExpanded(memoryStorage(), 1440)).toBe(
			true,
		);
		expect(restoreWorkspaceOutputsPanelExpanded(memoryStorage(), 1024)).toBe(
			false,
		);
	});

	it("survives storage that throws", () => {
		const broken = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(restoreWorkspaceOutputsPanelExpanded(broken, 1440)).toBe(true);
		expect(() =>
			persistWorkspaceOutputsPanelExpanded(broken, false),
		).not.toThrow();
	});

	it("persists the choice", () => {
		const storage = memoryStorage();
		persistWorkspaceOutputsPanelExpanded(storage, false);
		expect(storage.values.get(WORKSPACE_OUTPUTS_PANEL_KEY)).toBe("collapsed");
	});
});

describe("isWorkspaceOutputsItemSelected", () => {
	const [app, deck] = workspaceOutputsPanelItems(outputs, gadgets);
	it("marks an app selected while its linked output is open", () => {
		const linked: CanvasDocSelection = {
			type: "output",
			id: "new-deck",
			linkedGadgetId: "app",
		};
		expect(isWorkspaceOutputsItemSelected(app!, linked)).toBe(true);
		expect(isWorkspaceOutputsItemSelected(deck!, linked)).toBe(false);
	});

	it("marks a plain output selected", () => {
		expect(
			isWorkspaceOutputsItemSelected(deck!, { type: "output", id: "new-deck" }),
		).toBe(true);
		expect(isWorkspaceOutputsItemSelected(deck!, null)).toBe(false);
	});
});

function renderPanel(
	props: Partial<Parameters<typeof WorkspaceOutputsPanel>[0]> = {},
) {
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<WorkspaceOutputsPanel
				error={false}
				expanded
				items={workspaceOutputsPanelItems(outputs, gadgets)}
				loading={false}
				now={new Date("2026-10-24T12:00:00.000Z")}
				onBrowseLibrary={() => {}}
				onOpenActivity={() => {}}
				onOpenWork={() => {}}
				onSelect={() => {}}
				selectedDoc={{ type: "output", id: "new-deck" }}
				{...props}
			/>,
		),
		"text/html",
	);
}

describe("WorkspaceOutputsPanel", () => {
	it.each([
		["Doc", "document"],
		["Sheet", "sheet"],
		["Slides", "presentation"],
	])(
		"creates %s from the Files header and selects its gadget",
		async (label, kind) => {
			const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				onSelect = vi.fn();
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			await act(async () =>
				root.render(
					<WorkspaceOutputsPanel
						workspaceId={workspaceId}
						expanded
						items={[]}
						loading={false}
						error={false}
						selectedDoc={{ type: "output", id: "open-file" }}
						onSelect={onSelect}
						onBrowseLibrary={() => {}}
						onOpenWork={() => {}}
						onOpenActivity={() => {}}
					/>,
				),
			);
			try {
				const trigger = host.querySelector<HTMLButtonElement>("header button")!;
				expect(trigger.textContent).toContain("New");
				await act(async () => trigger.click());
				const choice = [
					...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
				].find((item) => item.textContent?.trim() === label)!;
				expect(choice).toBeTruthy();
				await act(async () => choice.click());
				const dialog = document.querySelector("[data-create-workspace]")!;
				expect(dialog.getAttribute("data-create-workspace")).toBe(workspaceId);
				expect(dialog.getAttribute("data-create-kind")).toBe(kind);
				await act(async () =>
					dialog.querySelector<HTMLButtonElement>("button")!.click(),
				);
				expect(onSelect).toHaveBeenCalledWith({
					type: "gadget",
					id: `created-${kind}`,
				});
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		},
	);
	it("keeps the created file fallback on the same selection callback", async () => {
		const onSelect = vi.fn(),
			host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () =>
			root.render(
				<WorkspaceOutputsPanel
					workspaceId="workspace"
					expanded
					items={[]}
					loading={false}
					error={false}
					selectedDoc={null}
					onSelect={onSelect}
					onBrowseLibrary={() => {}}
					onOpenWork={() => {}}
					onOpenActivity={() => {}}
				/>,
			),
		);
		try {
			await act(async () =>
				host.querySelector<HTMLButtonElement>("header button")!.click(),
			);
			await act(async () =>
				[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
					.find((item) => item.textContent?.trim() === "Doc")!
					.click(),
			);
			await act(async () =>
				[
					...document.querySelectorAll<HTMLButtonElement>(
						'[role="dialog"] button',
					),
				]
					.find((button) => button.textContent === "Open file")!
					.click(),
			);
			expect(onSelect).toHaveBeenCalledWith({
				type: "output",
				id: "created-output",
			});
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("renders a labelled list with a type icon per row and the selection", () => {
		const doc = renderPanel();
		const panel = doc.querySelector('aside[aria-label="Workspace files"]');
		expect(panel?.getAttribute("data-expanded")).toBe("true");
		const rows = doc.querySelectorAll('ul[aria-label="Files"] button');
		expect(rows).toHaveLength(3);
		expect(
			[...doc.querySelectorAll("[data-output-kind]")].map((icon) =>
				icon.getAttribute("data-output-kind"),
			),
		).toEqual(["app", "presentation", "document"]);
		expect(doc.querySelector('[aria-current="true"]')?.textContent).toContain(
			"Weekly review",
		);
		// The fold is the top bar's job: the panel carries no toggle of its own.
		expect(doc.querySelector("header button")).toBeNull();
		expect(
			doc.querySelector("[data-workspace-outputs-activity]")?.textContent,
		).toContain("Activity and approvals");
		expect(
			doc.querySelector("[data-workspace-outputs-library]"),
		).not.toBeNull();
		expect(doc.querySelector("[data-workspace-outputs-work]")).not.toBeNull();
	});

	it("names icon-only rows when collapsed to the rail", () => {
		const doc = renderPanel({ expanded: false });
		expect(
			doc
				.querySelector('aside[aria-label="Workspace files"]')
				?.getAttribute("data-expanded"),
		).toBe("false");
		expect(
			[...doc.querySelectorAll('ul[aria-label="Files"] button')].map((row) =>
				row.getAttribute("aria-label"),
			),
		).toEqual(["Reconciliation", "Weekly review", "Supplier note"]);
		expect(
			doc
				.querySelector("[data-workspace-outputs-library]")
				?.getAttribute("aria-label"),
		).toBe("Overview");
	});

	it("marks the canvas view the footer row opened", () => {
		const doc = renderPanel({ canvasView: "work", selectedDoc: null });
		expect(
			doc
				.querySelector("[data-workspace-outputs-work]")
				?.getAttribute("aria-current"),
		).toBe("true");
		expect(
			doc
				.querySelector("[data-workspace-outputs-library]")
				?.hasAttribute("aria-current"),
		).toBe(false);
	});

	it("explains an empty workspace", () => {
		const doc = renderPanel({ items: [] });
		expect(
			doc.querySelector("[data-workspace-outputs-empty]")?.textContent,
		).toBe(WORKSPACE_OUTPUTS_EMPTY_COPY);
		expect(doc.querySelector('ul[aria-label="Files"]')).toBeNull();
	});

	it("opens rows, approvals, the library and Work through its callbacks", () => {
		const onSelect = vi.fn();
		const onOpenActivity = vi.fn();
		const onBrowseLibrary = vi.fn();
		const onOpenWork = vi.fn();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() =>
			root.render(
				<WorkspaceOutputsPanel
					error={false}
					expanded
					items={workspaceOutputsPanelItems(outputs, gadgets)}
					loading={false}
					onBrowseLibrary={onBrowseLibrary}
					onOpenActivity={onOpenActivity}
					onOpenWork={onOpenWork}
					onSelect={onSelect}
					selectedDoc={null}
				/>,
			),
		);
		const rows = host.querySelectorAll<HTMLButtonElement>(
			'ul[aria-label="Files"] button',
		);
		act(() => rows[0]!.click());
		act(() => rows[1]!.click());
		expect(onSelect.mock.calls.map(([doc]) => doc)).toEqual([
			{ type: "gadget", id: "app" },
			{ type: "output", id: "new-deck" },
		]);
		act(() =>
			host
				.querySelector<HTMLButtonElement>("[data-workspace-outputs-activity]")!
				.click(),
		);
		expect(onOpenActivity).toHaveBeenCalledOnce();
		act(() =>
			host
				.querySelector<HTMLButtonElement>("[data-workspace-outputs-library]")!
				.click(),
		);
		expect(onBrowseLibrary).toHaveBeenCalledOnce();
		act(() =>
			host
				.querySelector<HTMLButtonElement>("[data-workspace-outputs-work]")!
				.click(),
		);
		expect(onOpenWork).toHaveBeenCalledOnce();
		act(() => root.unmount());
		host.remove();
	});
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const workspaces = vi.hoisted(() => ({
	create: vi.fn(),
	update: vi.fn(),
	archive: vi.fn(),
	setIcon: vi.fn(),
	removeIcon: vi.fn(),
}));

const osSharesApi = vi.hoisted(() => ({
	shares: {
		list: vi.fn(),
		create: vi.fn(),
		previewRevoke: vi.fn(),
		revoke: vi.fn(),
	},
}));

const webPushApi = vi.hoisted(() => ({
	getStatus: vi.fn(),
	setPreferences: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { workspaces, blueprints: { get: vi.fn() } },
		osShares: osSharesApi,
		webPush: webPushApi,
	},
}));

// Keep lifecycle tests focused on the control logic instead of Kumo's portal.
vi.mock("@/components/kumo/dialog", () => ({
	Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
		open ? <>{children}</> : null,
	DialogContent: ({ children }: { children: ReactNode }) => (
		<section>{children}</section>
	),
	DialogDescription: ({ children }: { children: ReactNode }) => (
		<p>{children}</p>
	),
	DialogFooter: ({ children }: { children: ReactNode }) => (
		<footer>{children}</footer>
	),
	DialogHeader: ({ children }: { children: ReactNode }) => (
		<header>{children}</header>
	),
	DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { CanvasWorkspaceControls } from "./canvas-workspace-controls";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE: OsWorkspace = {
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	organizationId: "org-1",
	name: "Operations",
	description: "Daily operations",
	status: "active",
	sourceBlueprintId: null,
	sourceBlueprintRevisionId: null,
	sourceBlueprintRevisionNumber: null,
	instantiationPreflight: null,
	rollbackReference: null,
	blueprintDecision: null,
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-12T10:00:00.000Z",
	visibility: "org",
	ownerUserId: null,
};

const cleanups: Array<() => void> = [];

function renderControls(workspace?: OsWorkspace, compactActions = false) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const onSelected = vi.fn();
	const onArchived = vi.fn();
	const render = (current?: OsWorkspace) =>
		act(() => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<CanvasWorkspaceControls
						workspace={current}
						compactActions={compactActions}
						onSelected={onSelected}
						onArchived={onArchived}
					/>
				</QueryClientProvider>,
			);
		});
	render(workspace);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return { container, onSelected, onArchived, rerender: render };
}

function button(container: Element, text: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.textContent ?? "").includes(text),
	);
	if (!(match instanceof HTMLButtonElement)) {
		throw new Error(`button not found: ${text}`);
	}
	return match;
}

function setValue(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	if (!setter) throw new Error("value setter missing");
	act(() => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 4; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	for (const mock of Object.values(workspaces)) mock.mockReset();
	for (const mock of Object.values(osSharesApi.shares)) mock.mockReset();
	for (const mock of Object.values(webPushApi)) mock.mockReset();
	osSharesApi.shares.list.mockResolvedValue({ items: [], truncated: false });
	webPushApi.getStatus.mockResolvedValue({
		enabled: true,
		publicKey: "B".repeat(87),
		preferences: { mutedProjectIds: ["project-1"], mutedWorkspaceIds: [] },
	});
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("CanvasWorkspaceControls", () => {
	it("uses accessible 32px icon actions in the workspace header", async () => {
		const rendered = renderControls(WORKSPACE, true);
		await flush();
		for (const label of ["Share", "Workspace actions"]) {
			const action = rendered.container.querySelector(
				`button[aria-label="${label}"]`,
			);
			expect(action).not.toBeNull();
			expect(action?.className).toContain("!size-8");
		}
		// Edit and Archive stay in the menu instead of repeating as icons.
		expect(
			rendered.container.querySelector('button[aria-label="Edit workspace"]'),
		).toBeNull();
		expect(
			rendered.container.querySelector(
				'button[aria-label="Archive workspace"]',
			),
		).toBeNull();
	});

	it("creates a durable workspace and selects its stable id", async () => {
		workspaces.create.mockResolvedValue({ workspace: WORKSPACE });
		const rendered = renderControls();
		act(() => button(rendered.container, "New workspace").click());
		await flush();

		const name = rendered.container.querySelector("input");
		const description = rendered.container.querySelector("textarea");
		if (!(name instanceof HTMLInputElement)) throw new Error("name missing");
		if (!(description instanceof HTMLTextAreaElement)) {
			throw new Error("description missing");
		}
		setValue(name, "  Operations  ");
		setValue(description, "  Daily operations  ");
		await flush();
		expect(name.value).toBe("  Operations  ");
		expect(description.value).toBe("  Daily operations  ");
		act(() => button(rendered.container, "Create workspace").click());
		await flush();

		expect(workspaces.create).toHaveBeenCalledWith({
			name: "Operations",
			description: "Daily operations",
		});
		expect(rendered.onSelected).toHaveBeenCalledWith(WORKSPACE.id);
	});

	it("renames a workspace and can clear its description", async () => {
		workspaces.update.mockResolvedValue({
			workspace: { ...WORKSPACE, name: "Ops Center", description: null },
		});
		const rendered = renderControls(WORKSPACE);
		act(() => button(rendered.container, "Edit").click());
		await flush();

		const name = rendered.container.querySelector("input");
		const description = rendered.container.querySelector("textarea");
		if (!(name instanceof HTMLInputElement)) throw new Error("name missing");
		if (!(description instanceof HTMLTextAreaElement)) {
			throw new Error("description missing");
		}
		setValue(name, "Ops Center");
		setValue(description, "");
		await flush();
		expect(name.value).toBe("Ops Center");
		act(() => button(rendered.container, "Save changes").click());
		await flush();

		expect(workspaces.update).toHaveBeenCalledWith({
			workspaceId: WORKSPACE.id,
			name: "Ops Center",
			description: null,
		});
		expect(rendered.onSelected).toHaveBeenCalledWith(WORKSPACE.id);
	});

	it("keeps an unsaved rename when the icon changes and the workspace refetches", async () => {
		const rendered = renderControls(WORKSPACE);
		act(() => button(rendered.container, "Edit").click());
		await flush();
		const name = rendered.container.querySelector("input");
		if (!(name instanceof HTMLInputElement)) throw new Error("name missing");
		setValue(name, "Ops Center");
		await flush();

		rendered.rerender({
			...WORKSPACE,
			iconUrl: "https://imagedelivery.net/hash/0000000000000000/public",
		});
		await flush();

		expect(name.value).toBe("Ops Center");
		expect(
			rendered.container.querySelector(
				'[data-testid="workspace-icon-field"] img',
			),
		).not.toBeNull();
		expect(button(rendered.container, "Remove")).toBeDefined();
	});

	it("toggles the workspace's push mute through saved preferences", async () => {
		webPushApi.setPreferences.mockResolvedValue({
			mutedProjectIds: ["project-1"],
			mutedWorkspaceIds: [WORKSPACE.id],
		});
		const rendered = renderControls(WORKSPACE);
		await flush();
		// The compact header keeps Share as its one icon; mute lives in the menu
		// there and as a plain button in the full controls.
		expect(
			renderControls(WORKSPACE, true).container.querySelector(
				'button[aria-label="Mute workspace notifications"]',
			),
		).toBeNull();
		const mute = button(rendered.container, "Mute");
		expect(mute.disabled).toBe(false);
		act(() => mute.click());
		await flush();
		expect(webPushApi.setPreferences).toHaveBeenCalledWith({
			mutedProjectIds: ["project-1"],
			mutedWorkspaceIds: [WORKSPACE.id],
		});
	});
	it("archives without deleting durable workspace evidence", async () => {
		workspaces.archive.mockResolvedValue({
			workspace: { ...WORKSPACE, status: "archived" },
		});
		const rendered = renderControls(WORKSPACE);
		act(() => button(rendered.container, "Archive").click());
		await flush();
		act(() => button(rendered.container, "Archive workspace").click());
		await flush();

		expect(workspaces.archive).toHaveBeenCalledWith({
			workspaceId: WORKSPACE.id,
		});
		expect(rendered.onArchived).toHaveBeenCalledOnce();
	});
});

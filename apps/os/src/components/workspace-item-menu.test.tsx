import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	outputs: {
		rename: vi.fn(),
		archive: vi.fn(),
		duplicate: vi.fn(),
		move: vi.fn(),
		history: vi.fn(),
	},
	gadgets: { rename: vi.fn(), archive: vi.fn() },
	workspaces: { list: vi.fn() },
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/kumo/toast", () => ({ toast: toasts }));
// Only the calls under test are replaced; the rest of the client is real.
vi.mock("@/lib/api", async (original) => {
	const real = await original<typeof import("@/lib/api")>();
	type Loose = Record<string, Record<string, unknown>>;
	const fakes = api as unknown as Loose;
	const through = (target: object, pick: (key: string) => unknown) =>
		new Proxy(target, {
			get: (inner, key, receiver) =>
				(typeof key === "string" ? pick(key) : undefined) ??
				Reflect.get(inner, key, receiver),
		});
	const workspaces = real.osApi.osWorkspaces as unknown as Loose;
	return {
		...real,
		osApi: through(real.osApi, (key) =>
			key === "osWorkspaces"
				? through(workspaces, (group) =>
						fakes[group]
							? through(workspaces[group]!, (name) => fakes[group]![name])
							: undefined,
					)
				: undefined,
		),
	};
});

import {
	canvasGadgetsQueryOptions,
	canvasOutputsQueryOptions,
} from "@/lib/os-query-options";
import { WorkspaceItemMenu } from "./workspace-item-menu";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const outputId = "22222222-2222-4222-8222-222222222222";
const gadgetId = "33333333-3333-4333-8333-333333333333";
const outputsKey = canvasOutputsQueryOptions(workspaceId).queryKey;
const gadgetsKey = canvasGadgetsQueryOptions(workspaceId).queryKey;

afterEach(() => {
	document.body.replaceChildren();
	vi.clearAllMocks();
});

function setup(item: { outputId?: string; gadgetId?: string }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData<unknown>(outputsKey, {
		items: [{ id: outputId, title: "Plan" }],
	});
	client.setQueryData<unknown>(gadgetsKey, {
		items: [{ id: gadgetId, name: "Tracker" }],
	});
	vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
	const onArchived = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceItemMenu
					workspaceId={workspaceId}
					item={{
						title: item.outputId ? "Plan" : "Tracker",
						kindLabel: item.outputId ? "Document" : "App",
						...item,
					}}
					onOpen={() => undefined}
					onArchived={onArchived}
				>
					<button type="button">row</button>
				</WorkspaceItemMenu>
			</QueryClientProvider>,
		),
	);
	const open = async (label: string) => {
		await act(async () => {
			host
				.querySelector<HTMLElement>("[data-workspace-item-menu]")!
				.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
				);
		});
		const entry = [
			...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((node) => node.textContent?.includes(label));
		expect(entry, label).toBeDefined();
		await act(async () => entry!.click());
		// The rename field takes focus once the menu has closed.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 90));
		});
	};
	const rows = (key: readonly unknown[]) =>
		(client.getQueryData(key) as { items: Record<string, unknown>[] }).items;
	const labels = async () => {
		await act(async () => {
			host
				.querySelector<HTMLElement>("[data-workspace-item-menu]")!
				.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
				);
		});
		return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
			(node) => node.textContent?.trim(),
		);
	};
	return { host, open, labels, rows, onArchived, client };
}
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** Let queries and effects settle until `ready` holds, so a busy machine cannot race the test. */
async function until(ready: () => boolean) {
	for (let turn = 0; turn < 200 && !ready(); turn++) await settle();
}

describe("WorkspaceItemMenu", () => {
	it("renames a file in place at once and keeps the name when the server accepts", async () => {
		api.outputs.rename.mockResolvedValue({});
		const view = setup({ outputId });
		await view.open("Rename");
		const input = view.host.querySelector<HTMLInputElement>("input")!;
		expect(input.value).toBe("Plan");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "Launch plan");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => input.blur());
		await settle();
		expect(api.outputs.rename).toHaveBeenCalledWith({
			outputId,
			title: "Launch plan",
		});
		expect(view.rows(outputsKey)[0]!.title).toBe("Launch plan");
	});

	it("puts an app's name back when the rename is refused", async () => {
		api.gadgets.rename.mockRejectedValue(new Error("no"));
		const view = setup({ gadgetId });
		await view.open("Rename");
		const input = view.host.querySelector<HTMLInputElement>("input")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "Board");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => input.blur());
		await settle();
		expect(api.gadgets.rename).toHaveBeenCalledWith({
			workspaceId,
			gadgetId,
			name: "Board",
		});
		expect(view.rows(gadgetsKey)[0]!.name).toBe("Tracker");
		expect(view.host.textContent).toContain("could not be saved");
	});

	it("archives an app after a confirmation and reports it", async () => {
		api.gadgets.archive.mockResolvedValue({});
		const view = setup({ gadgetId });
		await view.open("Archive");
		expect(document.body.textContent).toContain("Nothing is deleted");
		const confirm = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent === "Archive");
		await act(async () => confirm!.click());
		await settle();
		expect(api.gadgets.archive).toHaveBeenCalledWith({ workspaceId, gadgetId });
		expect(view.rows(gadgetsKey)).toHaveLength(0);
		expect(view.onArchived).toHaveBeenCalledTimes(1);
	});

	it("offers version history, duplicate and move for a file, not for an app", async () => {
		expect(await setup({ outputId }).labels()).toEqual([
			"Open",
			"Rename",
			"Version history",
			"Duplicate",
			"Move to workspace…",
			"Archive",
		]);
		document.body.replaceChildren();
		expect(await setup({ gadgetId }).labels()).toEqual([
			"Open",
			"Rename",
			"Archive",
		]);
	});

	it("duplicates a file and says what the copy is called", async () => {
		api.outputs.duplicate.mockResolvedValue({
			output: { id: "copy", title: "Plan copy" },
		});
		const view = setup({ outputId });
		await view.open("Duplicate");
		await until(() => toasts.success.mock.calls.length > 0);
		expect(api.outputs.duplicate).toHaveBeenCalledWith({ outputId });
		expect(toasts.success).toHaveBeenCalledWith("Created “Plan copy”");
		expect(view.client.invalidateQueries).toHaveBeenCalledTimes(2);
	});

	it("says why when a view-only person may not duplicate", async () => {
		api.outputs.duplicate.mockRejectedValue(
			Object.assign(new Error("Missing permission"), { code: "FORBIDDEN" }),
		);
		const view = setup({ outputId });
		await view.open("Duplicate");
		await until(() => toasts.error.mock.calls.length > 0);
		expect(toasts.error).toHaveBeenCalledWith("“Plan” was not duplicated", {
			description: expect.stringContaining(
				"You are not allowed to duplicate this file",
			),
		});
	});

	it("opens the file's version history from the menu", async () => {
		api.outputs.history.mockResolvedValue({
			revisions: [
				{
					revision: 1,
					note: "First draft",
					createdByKind: "user",
					createdAt: "2026-11-17T10:00:00.000Z",
					author: { name: "Ada", self: false },
				},
			],
			nextBeforeRevision: null,
			pending: [],
		});
		const view = setup({ outputId });
		await view.open("Version history");
		await until(() => document.querySelector("[data-version]") !== null);
		expect(api.outputs.history.mock.calls[0]![0]).toMatchObject({ outputId });
		expect(document.body.textContent).toContain("Version 1");
		expect(document.body.textContent).toContain("First draft");
	});

	it("moves a file to a picked workspace and closes what was showing it", async () => {
		api.workspaces.list.mockResolvedValue({
			items: [
				{ id: workspaceId, name: "Drafts" },
				{ id: gadgetId, name: "Launch" },
			],
			truncated: false,
		});
		api.outputs.move.mockResolvedValue({});
		const view = setup({ outputId });
		await view.open("Move to workspace");
		await until(() => document.querySelector('[role="radio"]') !== null);
		const choice = document.querySelector<HTMLElement>('[role="radio"]')!;
		expect(choice.textContent).toBe("Launch");
		await act(async () => choice.click());
		const move = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent === "Move to Launch");
		await act(async () => move!.click());
		await until(() => view.onArchived.mock.calls.length > 0);
		expect(api.outputs.move).toHaveBeenCalledWith({
			outputId,
			workspaceId: gadgetId,
		});
		expect(toasts.success).toHaveBeenCalledWith("Moved “Plan” to Launch");
		expect(view.onArchived).toHaveBeenCalledTimes(1);
	});
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	outputs: { rename: vi.fn(), archive: vi.fn() },
	gadgets: { rename: vi.fn(), archive: vi.fn() },
}));
// Only the four calls under test are replaced; the rest of the client is real.
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
	return { host, open, rows, onArchived };
}
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

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
});

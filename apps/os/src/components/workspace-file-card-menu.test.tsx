import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	outputs: { rename: vi.fn(), archive: vi.fn() },
}));
// Only the calls under test are replaced; the rest of the client is real.
vi.mock("@/lib/api", async (original) => {
	const real = await original<typeof import("@/lib/api")>();
	const outputs = new Proxy(real.osApi.osWorkspaces.outputs, {
		get: (inner, key, receiver) =>
			(api.outputs as Record<string | symbol, unknown>)[key] ??
			Reflect.get(inner, key, receiver),
	});
	const osWorkspaces = new Proxy(real.osApi.osWorkspaces, {
		get: (inner, key, receiver) =>
			key === "outputs" ? outputs : Reflect.get(inner, key, receiver),
	});
	return {
		...real,
		osApi: new Proxy(real.osApi, {
			get: (inner, key, receiver) =>
				key === "osWorkspaces"
					? osWorkspaces
					: Reflect.get(inner, key, receiver),
		}),
	};
});

import { WorkspaceFileCardMenu } from "./workspace-file-card-menu";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const outputId = "22222222-2222-4222-8222-222222222222";

let root: Root | null = null;

afterEach(() => {
	// Unmount first, so open menus and dialogs leave the page with their owner.
	act(() => root?.unmount());
	root = null;
	document.body.replaceChildren();
	vi.clearAllMocks();
});

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

async function until(ready: () => boolean) {
	for (let turn = 0; turn < 200 && !ready(); turn++) await settle();
}

function setup() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
	const onGone = vi.fn();
	const onOpen = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
		root!.render(
			<QueryClientProvider client={client}>
				<WorkspaceFileCardMenu
					workspaceId={workspaceId}
					outputId={outputId}
					title="Plan"
					kindLabel="File"
					onOpen={onOpen}
					onGone={onGone}
				/>
			</QueryClientProvider>,
		),
	);
	const trigger = host.querySelector<HTMLButtonElement>(
		'button[aria-label="Actions for Plan"]',
	)!;
	const entries = async () => {
		await act(async () => trigger.click());
		await until(() => document.querySelector('[role="menuitem"]') !== null);
		return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
	};
	const choose = async (label: string) => {
		const entry = (await entries()).find((node) =>
			node.textContent?.includes(label),
		);
		expect(entry, label).toBeDefined();
		await act(async () => entry!.click());
		await settle();
	};
	const press = async (label: string) => {
		const button = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent === label);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
		await settle();
	};
	return { trigger, entries, choose, press, onGone, onOpen };
}

describe("WorkspaceFileCardMenu", () => {
	it("offers the same actions as the Files list row", async () => {
		const view = setup();
		expect(view.trigger).not.toBeNull();
		expect(
			(await view.entries()).map((node) => node.textContent?.trim()),
		).toEqual([
			"Open",
			"Rename",
			"Version history",
			"Duplicate",
			"Move to workspace…",
			"Archive",
		]);
	});

	it("renames the file from a dialog", async () => {
		api.outputs.rename.mockResolvedValue({});
		const view = setup();
		await view.choose("Rename");
		const input = document.querySelector<HTMLInputElement>(
			'input[aria-label="File name"]',
		)!;
		expect(input.value).toBe("Plan");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "  Launch plan ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await view.press("Rename");
		expect(api.outputs.rename).toHaveBeenCalledWith({
			outputId,
			title: "Launch plan",
		});
		await until(
			() => document.querySelector('input[aria-label="File name"]') === null,
		);
		expect(document.querySelector('input[aria-label="File name"]')).toBeNull();
	});

	it("keeps the dialog open and says why when a rename is refused", async () => {
		api.outputs.rename.mockRejectedValue(new Error("Missing permission"));
		const view = setup();
		await view.choose("Rename");
		const input = document.querySelector<HTMLInputElement>(
			'input[aria-label="File name"]',
		)!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "Other");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await view.press("Rename");
		await until(() =>
			Boolean(document.body.textContent?.includes("Missing permission")),
		);
		expect(document.body.textContent).toContain("Missing permission");
		expect(
			document.querySelector('input[aria-label="File name"]'),
		).not.toBeNull();
	});

	it("archives after a confirmation and reports the file gone", async () => {
		api.outputs.archive.mockResolvedValue({});
		const view = setup();
		await view.choose("Archive");
		expect(document.body.textContent).toContain("Nothing is deleted");
		await view.press("Archive");
		await until(() => view.onGone.mock.calls.length > 0);
		expect(api.outputs.archive).toHaveBeenCalledWith({ outputId });
		expect(view.onGone).toHaveBeenCalledTimes(1);
	});

	it("keeps the file when an archive is refused", async () => {
		api.outputs.archive.mockRejectedValue(new Error("Missing permission"));
		const view = setup();
		await view.choose("Archive");
		await view.press("Archive");
		await until(() =>
			Boolean(document.body.textContent?.includes("Missing permission")),
		);
		expect(document.body.textContent).toContain("Missing permission");
		expect(view.onGone).not.toHaveBeenCalled();
	});
});

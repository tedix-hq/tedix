import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionAllowedResources,
	ConnectionInventoryRow,
} from "@tedix/api-contract/schemas/connections";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		connections: {
			getAllowedResources: mocks.get,
			setAllowedResources: mocks.set,
			getConnectionsOverview: vi.fn(),
		},
	},
}));
import { ConnectionResourceLimitsEditor } from "./connection-resource-limits";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const flush = async () =>
	act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});

async function mount({
	named = false,
	canManage = true,
	failRead = false,
	failSave = false,
} = {}) {
	let allowedResources: ConnectionAllowedResources | null = null;
	mocks.get.mockImplementation(async () => {
		if (failRead) throw new Error("Unavailable");
		return { allowedResources };
	});
	mocks.set.mockImplementation(async (input) => {
		if (failSave) throw new Error("Unavailable");
		allowedResources = input.allowedResources;
		return { allowedResources };
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const row = {
		provider: { name: "GitHub", appId: "github" },
		accountLabel: "GitHub",
		...(named
			? { connectionInstanceId: "10000000-0000-4000-8000-000000000001" }
			: {}),
	} as ConnectionInventoryRow;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ConnectionResourceLimitsEditor row={row} canManage={canManage} />
			</QueryClientProvider>,
		),
	);
	await flush();
	cleanups.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	const click = async (element: HTMLElement) => {
		await act(async () => element.click());
		await flush();
	};
	const type = async (value: string) => {
		await act(async () => {
			const input = host.querySelector("textarea")!;
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await flush();
	};
	const save = () =>
		[...host.querySelectorAll("button")].find(
			(b) => b.textContent === "Save resource limits",
		)!;
	return { host, click, type, save };
}

it.each([false, true])(
	"saves an X-only limit for default or named accounts (named=%s)",
	async (named) => {
		const view = await mount({ named });
		await view.click(view.host.querySelector('[role="switch"]')!);
		expect(view.host.textContent).toContain("Only these repositories");
		await view.type("example/repo-x");
		await view.click(view.save());
		expect(mocks.set.mock.calls[0]![0]).toEqual({
			providerId: "github",
			...(named ? { id: "10000000-0000-4000-8000-000000000001" } : {}),
			allowedResources: [
				{ resourceType: "github_repository", resourceId: "example/repo-x" },
			],
		});
		expect(view.host.textContent).toContain("Resource limits saved");
	},
);

it("saves an empty list as deny-all and preserves the draft after failure", async () => {
	const view = await mount({ failSave: true });
	await view.click(view.host.querySelector('[role="switch"]')!);
	await view.click(view.save());
	expect(mocks.set.mock.calls[0]![0].allowedResources).toEqual([]);
	expect(view.host.textContent).toContain("could not be saved");
	expect(
		view.host.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("true");
});

it("disables saving malformed names", async () => {
	const view = await mount();
	await view.click(view.host.querySelector('[role="switch"]')!);
	await view.type("https://github.com/example/repo-x");
	expect(view.save().disabled).toBe(true);
	expect(view.host.textContent).toContain(
		"Enter repository names as owner/repository",
	);
	expect(mocks.set).not.toHaveBeenCalled();
});

it.each([{ canManage: false }, { failRead: true }])(
	"keeps unavailable or unauthorized settings read-only %j",
	async (options) => {
		const view = await mount(options);
		expect(
			view.host.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled,
		).toBe(true);
		expect(view.save().disabled).toBe(true);
		expect(mocks.set).not.toHaveBeenCalled();
	},
);

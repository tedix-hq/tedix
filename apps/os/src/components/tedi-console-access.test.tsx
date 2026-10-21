import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { OsOperationalContextSchema } from "@tedix/api-contract/schemas/user-settings";
import { OsWorkspaceSchema } from "@tedix/api-contract/schemas/os-workspaces";

const mocks = vi.hoisted(() => ({
	getGrant: vi.fn(),
	workspaces: vi.fn(),
	setGrant: vi.fn(),
	context: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		tediConsole: { getGrant: mocks.getGrant, setGrant: mocks.setGrant },
		osWorkspaces: { workspaces: { list: mocks.workspaces } },
		userSettings: { getContext: mocks.context },
	},
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: mocks.success, error: mocks.error },
}));
import { TediConsoleAccess } from "./tedi-console-access";
import {
	activeWorkspacesQueryOptions,
	operationalContextQueryOptions,
	osQuery,
} from "@/lib/os-query-options";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tediA = "10000000-0000-4000-8000-000000000001";
const tediB = "10000000-0000-4000-8000-000000000002";
const workspaceA = "20000000-0000-4000-8000-000000000001";
const workspaceB = "20000000-0000-4000-8000-000000000002";
const initialGrant = { enabled: true, workspaceIds: [workspaceA] };
const inventory = {
	items: [
		{ id: workspaceA, name: "Research" },
		{ id: workspaceB, name: "Operations" },
	].map((workspace) =>
		OsWorkspaceSchema.parse({
			...workspace,
			organizationId: "fictional-org",
			description: null,
			status: "active",
			sourceBlueprintId: null,
			sourceBlueprintRevisionId: null,
			sourceBlueprintRevisionNumber: null,
			instantiationPreflight: null,
			rollbackReference: null,
			blueprintDecision: null,
			createdByKind: "user",
			createdById: "fictional-admin",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			visibility: "org",
			ownerUserId: null,
		}),
	),
	truncated: false,
};
const authority = (role = "admin", authType = "user") =>
	OsOperationalContextSchema.parse({
		organization: {
			id: "30000000-0000-4000-8000-000000000001",
			name: "Fictional company",
			slug: "fictional-company",
			type: "organization",
			descopeTenantId: null,
			logoUrl: null,
			appearance: null,
		},
		authority: {
			role,
			authType,
			permissions: [],
			machineScopes: [],
			crossTenantOverrideActive: false,
		},
		purpose: { access: "restricted", charter: null },
	});
const grantOptions = (tediId = tediA) =>
	osQuery.tediConsole.getGrant.queryOptions({ input: { tediId } });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getGrant.mockReset().mockResolvedValue(initialGrant);
	mocks.workspaces.mockReset().mockResolvedValue(inventory);
	mocks.context.mockReset().mockResolvedValue(authority());
	mocks.setGrant.mockReset().mockResolvedValue(initialGrant);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function flush() {
	await act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});
}
async function mount({
	role = "admin",
	authType = "user",
	seedGrant = true,
	seedWorkspaces = true,
} = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	client.setQueryData(
		operationalContextQueryOptions().queryKey,
		authority(role, authType),
	);
	if (seedGrant) client.setQueryData(grantOptions().queryKey, initialGrant);
	if (seedWorkspaces)
		client.setQueryData(activeWorkspacesQueryOptions().queryKey, inventory);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async (tediId = tediA) => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<TediConsoleAccess tediId={tediId} />
				</QueryClientProvider>,
			);
		});
		await flush();
	};
	cleanups.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	await render();
	const button = (name: string) =>
		[...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(el) => el.textContent?.trim() === name,
		)!;
	const save = () => button("Save console access");
	const toggle = () =>
		host.querySelector<HTMLButtonElement>('[role="switch"]')!;
	const box = (index = 0) =>
		host.querySelectorAll<HTMLElement>('[role="checkbox"]')[index]!;
	const click = async (el: HTMLElement) => {
		await act(async () => el.click());
		await flush();
	};
	const check = async (index = 0) =>
		click(box(index).parentElement!.querySelector("input")!);
	const refresh = async (queryKey: readonly unknown[]) => {
		await act(async () => {
			await client.invalidateQueries({ queryKey });
		});
		await flush();
	};
	return {
		host,
		client,
		render,
		button,
		save,
		toggle,
		box,
		click,
		check,
		refresh,
	};
}

it.each([
	["member", "user"],
	["admin", "tedi"],
	["owner", "m2m"],
])("hides Console grants for %s / %s", async (role, authType) => {
	const view = await mount({ role, authType });
	expect(view.host.textContent).toBe("");
	expect(mocks.getGrant).not.toHaveBeenCalled();
	expect(mocks.workspaces).not.toHaveBeenCalled();
	expect(mocks.setGrant).not.toHaveBeenCalled();
});

it.each(["owner", "admin", "tenant-admin"])(
	"allows the existing human %s role",
	async (role) => {
		const view = await mount({ role });
		expect(view.save().disabled).toBe(false);
	},
);

it("keeps all controls fenced during a pending save", async () => {
	const view = await mount();
	const pending = deferred<typeof initialGrant>();
	mocks.setGrant.mockReturnValue(pending.promise);
	await view.click(view.save());
	expect(view.save().disabled).toBe(true);
	expect(view.toggle().disabled).toBe(true);
	expect(view.box().getAttribute("aria-disabled")).toBe("true");
	await view.click(view.save());
	expect(mocks.setGrant).toHaveBeenCalledTimes(1);
	await act(async () => pending.resolve(initialGrant));
	await flush();
	expect(view.save().disabled).toBe(false);
});

it("ignores a late previous-target read when editing the next target", async () => {
	const pending = deferred<typeof initialGrant>();
	mocks.getGrant.mockReturnValue(pending.promise);
	const view = await mount({ seedGrant: false });
	view.client.setQueryData(grantOptions(tediB).queryKey, {
		enabled: true,
		workspaceIds: [workspaceB],
	});
	await view.render(tediB);
	await act(async () => pending.resolve(initialGrant));
	await flush();
	expect(view.box().getAttribute("aria-checked")).toBe("false");
	expect(view.box(1).getAttribute("aria-checked")).toBe("true");
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[0]?.[0]).toEqual({
		tediId: tediB,
		enabled: true,
		workspaceIds: [workspaceB],
	});
});

it("fences a cached grant after refresh failure, then recovers through its named retry", async () => {
	const view = await mount();
	mocks.getGrant.mockRejectedValue(new Error("Grant unavailable"));
	await view.refresh(grantOptions().queryKey);
	expect(view.client.getQueryData(grantOptions().queryKey)).toEqual(
		initialGrant,
	);
	expect(view.toggle().disabled).toBe(true);
	expect(view.save().disabled).toBe(true);
	expect(view.box().getAttribute("aria-disabled")).toBe("true");
	expect(view.host.textContent).toContain(
		"Console access settings are unavailable",
	);
	await view.click(view.save());
	expect(mocks.setGrant).not.toHaveBeenCalled();
	mocks.getGrant.mockResolvedValue(initialGrant);
	await view.click(view.button("Retry console access settings"));
	expect(view.save().disabled).toBe(false);
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[0]?.[0]).toEqual({
		tediId: tediA,
		...initialGrant,
	});
});

it("shows cold grant loading and a retry after failure", async () => {
	const pending = deferred<typeof initialGrant>();
	mocks.getGrant.mockReturnValue(pending.promise);
	const view = await mount({ seedGrant: false });
	expect(view.host.textContent).toContain("Loading console access settings");
	expect(view.toggle().disabled).toBe(true);
	expect(view.save().disabled).toBe(true);
	await act(async () => pending.resolve(initialGrant));
	await flush();
	expect(view.save().disabled).toBe(false);
	mocks.getGrant.mockRejectedValue(new Error("Offline"));
	await view.refresh(grantOptions().queryKey);
	expect(view.button("Retry console access settings")).toBeDefined();
});

it("waits for cold workspace inventory and preserves only current workspace IDs", async () => {
	const pending = deferred<typeof inventory>();
	mocks.workspaces.mockReturnValue(pending.promise);
	const view = await mount({ seedWorkspaces: false });
	expect(view.host.textContent).toContain("Loading Workspaces");
	expect(view.save().disabled).toBe(true);
	expect(view.toggle().disabled).toBe(true);
	await act(async () => {
		view.client.setQueryData(grantOptions().queryKey, {
			enabled: true,
			workspaceIds: [workspaceA, "removed-workspace"],
		});
		pending.resolve(inventory);
	});
	await flush();
	expect(view.box().getAttribute("aria-checked")).toBe("true");
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[0]?.[0]).toEqual({
		tediId: tediA,
		...initialGrant,
	});
});

it("fences failed workspace reads even while access is disabled and retries inventory", async () => {
	const view = await mount();
	await view.click(view.toggle());
	mocks.workspaces.mockRejectedValue(new Error("Workspace unavailable"));
	await view.refresh(activeWorkspacesQueryOptions().queryKey);
	expect(view.save().disabled).toBe(true);
	expect(view.toggle().disabled).toBe(true);
	expect(view.host.textContent).toContain("Workspaces are unavailable");
	mocks.workspaces.mockResolvedValue(inventory);
	await view.click(view.button("Retry Workspaces"));
	expect(view.toggle().getAttribute("aria-checked")).toBe("false");
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[0]?.[0]).toEqual({
		tediId: tediA,
		enabled: false,
		workspaceIds: [workspaceA],
	});
});

it("fences an in-flight refresh with cached data", async () => {
	const view = await mount();
	const pending = deferred<typeof inventory>();
	mocks.workspaces.mockReturnValue(pending.promise);
	let refresh!: Promise<void>;
	await act(async () => {
		refresh = view.client.invalidateQueries({
			queryKey: activeWorkspacesQueryOptions().queryKey,
		});
	});
	await flush();
	expect(view.save().disabled).toBe(true);
	expect(view.toggle().disabled).toBe(true);
	await act(async () => {
		pending.resolve(inventory);
		await refresh;
	});
	await flush();
	expect(view.save().disabled).toBe(false);
});

it("resets the draft for cached and cold target changes without carrying selections", async () => {
	const view = await mount();
	await view.check(1);
	view.client.setQueryData(grantOptions(tediB).queryKey, {
		enabled: false,
		workspaceIds: [],
	});
	await view.render(tediB);
	expect(view.toggle().getAttribute("aria-checked")).toBe("false");
	expect(view.box().getAttribute("aria-checked")).toBe("false");
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[0]?.[0]).toEqual({
		tediId: tediB,
		enabled: false,
		workspaceIds: [],
	});
	await view.render(tediA);
	expect(view.box(1).getAttribute("aria-checked")).toBe("false");
	await act(async () =>
		view.client.removeQueries({ queryKey: grantOptions(tediB).queryKey }),
	);
	const pending = deferred<typeof initialGrant>();
	mocks.getGrant.mockReturnValue(pending.promise);
	await view.render(tediB);
	expect(view.save().disabled).toBe(true);
	expect(view.box().getAttribute("aria-checked")).toBe("false");
	await view.click(view.save());
	expect(mocks.setGrant).toHaveBeenCalledTimes(1);
	await act(async () =>
		pending.resolve({ enabled: true, workspaceIds: [workspaceB] }),
	);
	await flush();
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[1]?.[0]).toEqual({
		tediId: tediB,
		enabled: true,
		workspaceIds: [workspaceB],
	});
});

it("requires a Workspace when enabled, including an empty inventory", async () => {
	const view = await mount();
	await view.check();
	expect(view.save().disabled).toBe(true);
	await act(async () =>
		view.client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
			items: [],
			truncated: false,
		}),
	);
	await flush();
	expect(view.host.textContent).toContain("No active Workspaces");
	expect(view.save().disabled).toBe(true);
	await view.click(view.toggle());
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls[0]?.[0]).toEqual({
		tediId: tediA,
		enabled: false,
		workspaceIds: [],
	});
});

it("retains the draft on save failure and retries the exact local payload", async () => {
	const view = await mount();
	await view.check(1);
	mocks.setGrant.mockRejectedValue(new Error("Write unavailable"));
	await view.click(view.save());
	expect(mocks.error).toHaveBeenCalled();
	expect(view.host.textContent).toContain("Console access could not be saved");
	expect(view.box(1).getAttribute("aria-checked")).toBe("true");
	mocks.setGrant.mockResolvedValue({
		enabled: true,
		workspaceIds: [workspaceA, workspaceB],
	});
	await view.click(view.save());
	expect(mocks.setGrant.mock.calls.map(([input]) => input)).toEqual([
		{ tediId: tediA, enabled: true, workspaceIds: [workspaceA, workspaceB] },
		{ tediId: tediA, enabled: true, workspaceIds: [workspaceA, workspaceB] },
	]);
});

it("withdraws authority immediately and discards the old draft on restoration", async () => {
	const view = await mount();
	await view.check(1);
	await act(async () =>
		view.client.setQueryData(
			operationalContextQueryOptions().queryKey,
			authority("member"),
		),
	);
	await flush();
	expect(view.host.textContent).toBe("");
	await act(async () =>
		view.client.setQueryData(
			operationalContextQueryOptions().queryKey,
			authority(),
		),
	);
	await flush();
	expect(view.box(1).getAttribute("aria-checked")).toBe("false");
	mocks.context.mockRejectedValue(new Error("Authority unavailable"));
	await view.refresh(operationalContextQueryOptions().queryKey);
	expect(view.host.textContent).toBe("");
	expect(mocks.setGrant).not.toHaveBeenCalled();
});

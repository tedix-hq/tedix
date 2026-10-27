import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionConsumerGrants } from "@tedix/api-contract/schemas/connections";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getConsumerGrants: vi.fn(),
	setConsumerGrants: vi.fn(),
	listTedis: vi.fn(),
	listSkills: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		connections: {
			getConsumerGrants: mocks.getConsumerGrants,
			setConsumerGrants: mocks.setConsumerGrants,
		},
		tedis: { list: mocks.listTedis },
		skills: { listByOrg: mocks.listSkills },
	},
}));

import { ConnectionConsumerGrantsEditor } from "./connection-consumer-grants";
import {
	osQuery,
	skillCatalogQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const providerId = "fictional-mail";
const accountId = "10000000-0000-4000-8000-000000000001";
const tediId = "20000000-0000-4000-8000-000000000001";
const skillId = "30000000-0000-4000-8000-000000000001";
const roster = {
	data: [{ id: tediId, name: "researcher", displayName: "Researcher" }],
	total: 1,
};
const catalog = {
	entries: [{ id: skillId, title: "Research brief", revision: 7 }],
	total: 1,
};

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getConsumerGrants.mockResolvedValue({ mode: "all" });
	mocks.setConsumerGrants.mockResolvedValue({ success: true });
	mocks.listTedis.mockResolvedValue(roster);
	mocks.listSkills.mockResolvedValue(catalog);
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
	policy = { mode: "all" },
	connectionInstanceId,
	canManage = true,
	seedPolicy = true,
}: {
	policy?: ConnectionConsumerGrants;
	connectionInstanceId?: string;
	canManage?: boolean;
	seedPolicy?: boolean;
} = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity },
			mutations: { retry: false },
		},
	});
	const input = {
		providerId,
		...(connectionInstanceId ? { connectionInstanceId } : {}),
	};
	if (seedPolicy)
		client.setQueryData(
			osQuery.connections.getConsumerGrants.queryOptions({ input }).queryKey,
			policy,
		);
	client.setQueryData<unknown>(tediRosterQueryOptions(100).queryKey, roster);
	client.setQueryData<unknown>(skillCatalogQueryOptions(100).queryKey, catalog);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<ConnectionConsumerGrantsEditor
					providerId={providerId}
					connectionInstanceId={connectionInstanceId}
					accountLabel="Work account"
					canManage={canManage}
				/>
			</QueryClientProvider>,
		);
	});
	await flush();
	cleanups.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	const button = (name: string) =>
		[...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent?.trim() === name,
		)!;
	const click = async (element: HTMLElement) => {
		await act(async () => element.click());
		await flush();
	};
	return { host, client, button, click };
}

it("defaults to everyone and saves the provider-level policy", async () => {
	const view = await mount();
	expect(view.host.textContent).toContain("Everyone in the organization");
	await view.click(view.button("Save who can use this"));
	expect(mocks.setConsumerGrants.mock.calls[0]![0]).toEqual({
		providerId,
		policy: { mode: "all" },
	});
});

it("saves named tedis and the exact selected skill revision for one account", async () => {
	const view = await mount({ connectionInstanceId: accountId });
	await view.click(view.host.querySelector<HTMLElement>('[role="switch"]')!);
	const boxes = view.host.querySelectorAll<HTMLElement>('[role="checkbox"]');
	await view.click(boxes[0]!.parentElement!.querySelector("input")!);
	await view.click(boxes[1]!.parentElement!.querySelector("input")!);
	await view.click(view.button("Save who can use this"));
	expect(mocks.setConsumerGrants.mock.calls[0]![0]).toEqual({
		providerId,
		connectionInstanceId: accountId,
		policy: {
			mode: "selected",
			tediIds: [tediId],
			skills: [{ id: skillId, revision: 7 }],
		},
	});
});

it("keeps an older exact skill revision visible and removable", async () => {
	const view = await mount({
		policy: {
			mode: "selected",
			tediIds: [],
			skills: [{ id: skillId, revision: 6 }],
		},
	});
	expect(view.host.textContent).toContain("Research brief · revision 6");
	expect(view.host.textContent).toContain("Research brief · revision 7");
});

it("keeps selections after a failed save and fences non-admin changes", async () => {
	mocks.setConsumerGrants.mockRejectedValueOnce(new Error("failed"));
	const view = await mount({
		policy: { mode: "selected", tediIds: [tediId], skills: [] },
	});
	await view.click(view.button("Save who can use this"));
	expect(view.host.textContent).toContain("Your selections are kept");
	expect(
		view.host
			.querySelector<HTMLElement>('[role="checkbox"]')
			?.getAttribute("aria-checked"),
	).toBe("true");

	const readOnly = await mount({ canManage: false });
	expect(
		readOnly.host.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled,
	).toBe(true);
	expect(readOnly.button("Save who can use this").disabled).toBe(true);
	expect(readOnly.host.textContent).toContain("Only an organization admin");
});

it("requires a successful fresh read before saving and offers retry", async () => {
	mocks.getConsumerGrants.mockRejectedValueOnce(new Error("unavailable"));
	const view = await mount({ seedPolicy: false });
	expect(view.host.textContent).toContain("Access settings are unavailable");
	expect(view.button("Save who can use this").disabled).toBe(true);
	expect(view.button("Retry access settings")).toBeDefined();
});

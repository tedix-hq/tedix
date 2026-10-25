import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { App } from "@tedix/api-contract/schemas/app";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { TEDI_ROSTER_LIMIT } from "@/lib/os-query-options";

const api = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { tedis: { list: api.list }, apps: { update: api.update } },
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import {
	AppAggregatedTedis,
	withAggregatedTedi,
	withAggregatedTediSurface,
	withoutAggregatedTedi,
} from "./app-aggregated-tedis";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_ID = "11111111-1111-4111-8111-111111111111";

function gateway(aggregateTedis: unknown[]): App {
	return {
		id: APP_ID,
		name: "Orchard Unified MCP",
		slug: "orchard-unified",
		metadata: { mcpConfig: { codeMode: true, aggregateTedis } },
	} as unknown as App;
}

function roster(...tedis: Array<{ id: string; name: string; slug: string }>) {
	return {
		data: tedis.map((tedi) => ({
			...tedi,
			organizationId: ORG_ID,
			status: "active",
		})),
		pagination: { limit: TEDI_ROSTER_LIMIT, offset: 0, total: tedis.length },
	};
}

const cleanups: Array<() => Promise<void>> = [];

async function mount(app: App, canManage = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<AppAggregatedTedis app={app} canManage={canManage} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});
	return host;
}

async function settles(assertion: () => void) {
	await vi.waitFor(async () => {
		await act(async () => {
			await Promise.resolve();
		});
		assertion();
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	api.list.mockResolvedValue(
		roster(
			{ id: "t1", name: "Harvest Operator", slug: "harvest-operator" },
			{ id: "t2", name: "Orchard Helper", slug: "orchard-helper" },
		),
	);
	api.update.mockResolvedValue({});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("gateway tedi list edits", () => {
	const list = [
		{ slug: "orchard-helper", surface: "full" as const, namespace: "helper" },
		{
			slug: "harvest-operator",
			surface: "collaboration" as const,
			surfaceRev: "rev-1",
		},
	];

	it("adds once, removes exactly one, and keeps fields it does not edit", () => {
		expect(withAggregatedTedi(list, "new-tedi", "full")).toEqual([
			...list,
			{ slug: "new-tedi", surface: "full" },
		]);
		expect(withAggregatedTedi(list, "orchard-helper", "collaboration")).toEqual(
			list,
		);
		expect(withoutAggregatedTedi(list, "harvest-operator")).toEqual([list[0]]);
		expect(withAggregatedTediSurface(list, "harvest-operator", "full")).toEqual(
			[list[0], { slug: "harvest-operator", surface: "full" }],
		);
	});
});

describe("AppAggregatedTedis", () => {
	it("lists included tedis by name with their tools and saves a removal through apps.update", async () => {
		const host = await mount(
			gateway([
				{ slug: "harvest-operator", surface: "full" },
				{ slug: "orchard-helper", surface: "collaboration", namespace: "help" },
			]),
		);
		await settles(() => {
			expect(host.textContent).toContain("Harvest Operator");
			expect(host.textContent).toContain("Collaboration only");
		});
		const remove = host.querySelector<HTMLButtonElement>(
			'[aria-label="Remove Harvest Operator from this gateway"]',
		);
		await act(async () => remove?.click());
		await settles(() =>
			expect(api.update).toHaveBeenCalledWith({
				appId: APP_ID,
				metadata: {
					mcpConfig: {
						aggregateTedis: [
							{
								slug: "orchard-helper",
								surface: "collaboration",
								namespace: "help",
							},
						],
					},
				},
			}),
		);
	});

	it("disables every control for a member who cannot manage apps", async () => {
		const host = await mount(
			gateway([{ slug: "harvest-operator", surface: "full" }]),
			false,
		);
		await settles(() => expect(host.textContent).toContain("Harvest Operator"));
		const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
		expect(buttons.length).toBeGreaterThan(0);
		expect(buttons.every((button) => button.disabled)).toBe(true);
	});
});

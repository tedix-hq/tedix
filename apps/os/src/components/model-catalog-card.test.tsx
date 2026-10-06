import type {
	ModelCatalogModel,
	ModelCatalogRouting,
} from "@tedix/api-contract/schemas/model-catalog-projection";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const modelCatalogApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/api", () => ({
	osApi: { modelCatalog: modelCatalogApi },
}));

import {
	denialGroups,
	ModelCatalogCard,
	ModelCatalogSection,
	modelCounts,
} from "./model-catalog-card";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Fixture fields trace to the producing contract, not to convenience: `ref`,
 * `provider`, `modelId`, `label`, `reasoning` and `tier` are the
 * `ModelCatalogEntry` fields the catalog declares — `imageInput` among them,
 * defaulted to the tri-state's `unknown` so a fixture never asserts a
 * capability the entry under test did not declare — and `allowed` / `checks` /
 * `deniedBy` are the projection fields `evaluateModelCatalogEntry` adds.
 */
function model(
	overrides: Partial<ModelCatalogModel> & Pick<ModelCatalogModel, "ref">,
): ModelCatalogModel {
	const deniedBy = overrides.deniedBy ?? null;
	return {
		provider: "azure-openai",
		modelId: overrides.ref.split("/")[1] ?? overrides.ref,
		label: overrides.ref,
		reasoning: true,
		tier: "balanced",
		imageInput: "unknown",
		governance: {
			weightAccess: "closed-weights",
			residencyControl: "customer-provider",
			routingMode: "fixed",
		},
		lifecycle: "active",
		selectable: true,
		allowed: deniedBy === null,
		checks: [
			{
				filter: "provider_wired",
				verdict: "allow",
				reason: "provider_wired",
				detail: "wired",
				input: {
					source: "serving Worker env (presence booleans only)",
					configured: true,
					expected: ["azure-openai"],
					observed: "azure-openai",
				},
			},
		],
		...overrides,
		deniedBy,
	};
}

function denial(reason: string, detail: string): ModelCatalogModel["deniedBy"] {
	return {
		filter: "org_model_tier",
		verdict: "deny",
		reason,
		detail,
		input: {
			source: "billing_inference_policies.organization.allowed_model_tiers",
			configured: true,
			expected: ["frontier"],
			observed: "economy",
		},
	};
}

const routing: ModelCatalogRouting = {
	slot: "chat",
	modelRef: "azure-openai/gpt-5.6-luna",
	selectedBy: "org_default",
	detail: "Chat turns route at `azure-openai/gpt-5.6-luna`.",
	allowed: true,
	selectable: true,
	deniedBy: null,
};

describe("modelCounts", () => {
	it("counts allowed and denied from the projection's own verdict", () => {
		expect(
			modelCounts([
				model({ ref: "azure-openai/a" }),
				model({ ref: "azure-openai/b", deniedBy: denial("x", "y") }),
			]),
		).toEqual({ allowed: 1, denied: 1 });
	});
});

describe("denialGroups", () => {
	it("groups by reason and keeps the projection's detail verbatim", () => {
		const groups = denialGroups([
			model({ ref: "a/1" }),
			model({
				ref: "a/2",
				deniedBy: denial("model_tier_not_allowed", "tier denied"),
			}),
			model({
				ref: "a/3",
				deniedBy: denial("model_tier_not_allowed", "tier denied"),
			}),
			model({
				ref: "a/4",
				deniedBy: denial("provider_not_wired", "provider missing"),
			}),
		]);
		expect(groups).toEqual([
			{
				reason: "model_tier_not_allowed",
				detail: "tier denied",
				refs: ["a/2", "a/3"],
			},
			{
				reason: "provider_not_wired",
				detail: "provider missing",
				refs: ["a/4"],
			},
		]);
	});

	it("returns nothing when nothing is denied", () => {
		expect(denialGroups([model({ ref: "a/1" })])).toEqual([]);
	});
});

const cleanups: Array<() => void> = [];

function render(node: React.ReactElement): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

describe("ModelCatalogCard", () => {
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("renders the denial reason next to the count so an operator can act on it", () => {
		const container = render(
			<ModelCatalogCard
				models={[
					model({ ref: "azure-openai/gpt-5.6-sol" }),
					model({
						ref: "workers-ai/@cf/meta/llama-3.2-3b-instruct",
						deniedBy: denial(
							"model_tier_not_allowed",
							"Organization model-tier policy denies tier `economy`.",
						),
					}),
				]}
				routing={routing}
				wiredProviders={["azure-openai"]}
			/>,
		);
		expect(container.textContent).toContain("1 allowed");
		expect(container.textContent).toContain("1 denied");
		expect(container.textContent).toContain(
			"Organization model-tier policy denies tier `economy`.",
		);
		expect(container.textContent).toContain("Wired providers: azure-openai");
	});

	it("says no provider is wired rather than rendering an empty provider line", () => {
		const container = render(
			<ModelCatalogCard models={[]} routing={routing} wiredProviders={[]} />,
		);
		expect(container.textContent).toContain(
			"No model provider is wired in this deployment",
		);
	});
});

describe("ModelCatalogCard surface tier", () => {
	/**
	 * Standalone, the catalog sits on the page canvas beside other operational
	 * panels and takes the 12px card tier. Embedded, it is a row inside a shared
	 * collection and carries no chrome at all — the one case
	 * where a bounded box is deliberately not a `Surface`.
	 */
	it("takes the card tier standalone and no chrome when embedded", () => {
		const standalone = render(
			<ModelCatalogCard models={[]} routing={routing} wiredProviders={[]} />,
		);
		const surface = standalone.querySelector('[data-slot="surface"]');
		expect(surface?.getAttribute("data-tier")).toBe("panel");
		expect(surface?.className).toContain("rounded-xl");
		expect(surface?.className).toContain("border-kumo-line");
		expect(surface?.className).not.toContain("border-kumo-hairline");

		const embedded = render(
			<ModelCatalogCard
				models={[]}
				routing={routing}
				wiredProviders={[]}
				embedded
			/>,
		);
		expect(embedded.querySelector('[data-slot="surface"]')).toBeNull();
		expect(embedded.firstElementChild?.className).toBe(
			"grid gap-1.5 px-4 py-3",
		);
	});
});

describe("ModelCatalogSection", () => {
	beforeEach(() => {
		modelCatalogApi.list.mockReset();
	});
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("requests denied models so the reasons are available", async () => {
		modelCatalogApi.list.mockResolvedValue({
			models: [model({ ref: "azure-openai/gpt-5.6-sol" })],
			selections: [],
			routing,
			wiredProviders: ["azure-openai"],
		});
		const container = render(<ModelCatalogSection />);
		await flush();
		expect(modelCatalogApi.list).toHaveBeenCalledWith(
			{ includeDenied: true },
			// The contract-derived option forwards TanStack Query's AbortSignal.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain("1 allowed");
	});

	it("reports a failed read instead of rendering a zero-allowed verdict", async () => {
		modelCatalogApi.list.mockRejectedValue(new Error("catalog down"));
		const container = render(<ModelCatalogSection />);
		await flush();
		expect(container.textContent).toContain("The model catalog is unavailable");
		expect(container.textContent).toContain("catalog down");
		expect(container.textContent).not.toContain("0 allowed");
	});
});

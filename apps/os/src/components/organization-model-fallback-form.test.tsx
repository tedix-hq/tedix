import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { modelCatalogEntry } from "@tedix/api-contract/test/model-catalog";
import type { ModelFallbackPolicy } from "@tedix/api-contract/schemas/model-fallback";
import { modelCatalogQueryOptions } from "@/lib/os-query-options";
import { OrganizationModelFallbackForm } from "./organization-model-fallback-form";
vi.mock("@/lib/api", () => ({
	osApi: {
		organizations: { update: vi.fn() },
		modelCatalog: { list: vi.fn() },
	},
}));
const primary = modelCatalogEntry("azure-openai/fixture-primary", {
	label: "Primary fixture",
});
const secondary = modelCatalogEntry("azure-openai/fixture-secondary", {
	label: "Secondary fixture",
});

function renderPolicy(initialPolicy: ModelFallbackPolicy | null) {
	const client = new QueryClient();
	client.setQueryData(modelCatalogQueryOptions().queryKey, {
		models: [primary, secondary].map((entry) => ({
			...entry,
			allowed: true,
			selectable: true,
			checks: [],
			deniedBy: null,
		})),
		selections: [],
		routing: {
			slot: "chat",
			modelRef: primary.ref,
			selectedBy: "org_default",
			detail: "Fixture",
			allowed: true,
			selectable: true,
			deniedBy: null,
		},
		wiredProviders: ["azure-openai"],
	});
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<OrganizationModelFallbackForm
				organizationId="fictional-org"
				initialPolicy={initialPolicy}
			/>
		</QueryClientProvider>,
	);
}

describe("organization fallback settings", () => {
	afterEach(() => vi.restoreAllMocks());

	it("shows inherited policy, cap and critical boundaries", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const html = renderPolicy(null);
		expect(html).toContain("Using the platform default");
		expect(html).toContain("Maximum switches per model operation");
		expect(html).toContain("Every switch is recorded on the run");
		expect(html).toContain(
			"Fixed-model and residency requirements still apply",
		);
		const container = document.createElement("div");
		container.innerHTML = html;
		const cap = container.querySelector('input[type="number"]')!;
		const label = container.querySelector("label")!;
		const labelText = label.querySelector("span[id]")!;
		expect(cap.getAttribute("aria-labelledby")).toBe(labelText.id);
		expect(labelText.id).not.toBe("");
		expect(label.htmlFor).toBe(cap.id);
		expect(label.textContent).toBe("Maximum switches per model operation");
		expect(warn).not.toHaveBeenCalled();
	});
	it("shows the ordered fallback from an explicit organization policy", () => {
		const html = renderPolicy({
			version: 1,
			maxTransitions: 2,
			ladder: { [primary.ref]: [secondary.ref] },
		});
		expect(html).toContain("Organization policy");
		const container = document.createElement("div");
		container.innerHTML = html;
		const fallback = container.querySelector('[role="combobox"]');
		expect(fallback?.getAttribute("aria-label")).toBe(
			"Primary fixture fallback 1",
		);
		expect(fallback?.textContent).toBe("Secondary fixture");
		expect(
			container.querySelector('input[type="number"]')?.getAttribute("value"),
		).toBe("2");
	});
});

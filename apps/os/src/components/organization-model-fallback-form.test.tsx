import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { COGNITION_MODEL_CATALOG } from "@tedix/api-contract/schemas/model-catalog";
import { modelCatalogQueryOptions } from "@/lib/os-query-options";
import { OrganizationModelFallbackForm } from "./organization-model-fallback-form";
vi.mock("@/lib/api", () => ({
	osApi: {
		organizations: { update: vi.fn() },
		modelCatalog: { list: vi.fn() },
	},
}));
describe("organization fallback settings", () => {
	afterEach(() => vi.restoreAllMocks());

	it("shows inherited policy, ordered fallbacks, cap and critical boundaries", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = new QueryClient();
		client.setQueryData(modelCatalogQueryOptions().queryKey, {
			models: COGNITION_MODEL_CATALOG.map((entry) => ({
				...entry,
				allowed: true,
				selectable: true,
				checks: [],
				deniedBy: null,
			})),
			selections: [],
			routing: {
				slot: "chat",
				modelRef: "cloudflare/auto",
				selectedBy: "org_default",
				detail: "Fixture",
				allowed: true,
				selectable: true,
				deniedBy: null,
			},
			wiredProviders: ["azure-openai", "cloudflare"],
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<OrganizationModelFallbackForm
					organizationId="fictional-org"
					initialPolicy={null}
				/>
			</QueryClientProvider>,
		);
		expect(html).toContain("Using the platform default");
		expect(html).toContain("Maximum switches per model operation");
		expect(html).toContain("Every switch is recorded on the run");
		expect(html).toContain(
			"Fixed-model and residency requirements still apply",
		);
		expect(html).toContain("fallback 1");
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
});

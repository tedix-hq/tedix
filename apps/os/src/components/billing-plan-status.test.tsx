import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { handleLocalRpc } from "../../dev/local-fixtures";
import { BillingPlanStatus } from "./billing-plan-status";

const { createPortal } = vi.hoisted(() => ({ createPortal: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@/lib/api", () => ({ osApi: { billing: { createPortal } } }));

function overview(
	customer: string | null,
	status: BillingOverview["snapshot"]["status"] = "active",
) {
	const value = (
		handleLocalRpc("/api/rpc/billing/getOverview", "POST", { json: {} })!
			.body as { json: BillingOverview }
	).json;
	value.snapshot.status = status;
	value.snapshot.stripeCustomerId = customer;
	return value;
}
function render(value: BillingOverview) {
	const client = new QueryClient();
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<BillingPlanStatus overview={value} />
		</QueryClientProvider>,
	);
	client.clear();
	return html;
}

describe("BillingPlanStatus", () => {
	it("shows the current plan and the billing portal for a loaded subscription", () => {
		const html = render(overview("customer-fictional"));
		expect(html).toContain("Current plan");
		expect(html).toContain("Growth");
		expect(html).toContain("Active");
		expect(html).toContain("Manage or upgrade plan");
	});
	it("offers plan selection when no billing customer exists", () => {
		const html = render(overview(null, "trial"));
		expect(html).toContain('href="/admin/billing?section=subscription"');
		expect(html).toContain("Choose a plan");
		expect(html).not.toContain("Manage or upgrade plan");
	});
	it("shows payment recovery in plain English", () => {
		const html = render(overview("customer-fictional", "past_due"));
		expect(html).toContain("Past due");
		expect(html).toContain("Payment needs attention");
	});
	it("keeps a failed portal request visible and allows another attempt", async () => {
		createPortal.mockRejectedValueOnce(new Error("Billing portal unavailable"));
		const container = document.createElement("div");
		const root = createRoot(container);
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<BillingPlanStatus overview={overview("customer-fictional")} />
					</QueryClientProvider>,
				),
			);
			await act(async () => {
				container.querySelector("button")!.click();
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
			expect(createPortal).toHaveBeenCalledWith({
				returnUrl: `${window.location.origin}/admin/billing?section=usage`,
			});
			expect(container.textContent).toContain("Billing portal unavailable");
			expect(container.querySelector("button")?.disabled).toBe(false);
		} finally {
			await act(async () => root.unmount());
			client.clear();
		}
	});
});

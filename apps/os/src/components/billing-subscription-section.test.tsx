import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { handleLocalRpc } from "../../dev/local-fixtures";
import { SubscriptionSection } from "./billing-subscription-section";

const { createPortal } = vi.hoisted(() => ({ createPortal: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@/lib/api", () => ({
	osApi: {
		billing: {
			createPortal,
			listPlans: vi.fn().mockResolvedValue([]),
			getPaymentDetails: vi
				.fn()
				.mockResolvedValue({ email: null, method: null }),
		},
	},
}));

function overview(): BillingOverview {
	const value = (
		handleLocalRpc("/api/rpc/billing/getOverview", "POST", { json: {} })!
			.body as { json: BillingOverview }
	).json;
	return { ...value, account: { ...value.account, hasStripeCustomer: true } };
}

describe("the current billing plan", () => {
	it("shows an internal credit override without a catalog price or payment details", async () => {
		const value = overview();
		value.account = {
			...value.account,
			hasStripeCustomer: false,
			hasIncludedCreditsOverride: true,
			hasPaidPlan: false,
		};
		value.plan = { ...value.plan, priceMicros: 1_000_000_000 };
		const container = document.createElement("div");
		const root = createRoot(container);
		const client = new QueryClient();
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<SubscriptionSection overview={value} />
					</QueryClientProvider>,
				),
			);
			expect(container.textContent).toContain("Internal account");
			expect(container.textContent).toContain("Credits are set by Tedix");
			expect(container.textContent).not.toContain("€");
			expect(container.textContent).not.toContain("Payment method");
		} finally {
			await act(async () => root.unmount());
			client.clear();
		}
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
						<SubscriptionSection overview={overview()} />
					</QueryClientProvider>,
				),
			);
			await act(async () => {
				[...container.querySelectorAll("button")]
					.find((button) => button.textContent === "Manage in portal")!
					.click();
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
			expect(createPortal).toHaveBeenCalledWith({
				returnUrl: `${window.location.origin}/admin/billing?tab=plan`,
			});
			expect(container.textContent).toContain("Billing portal unavailable");
			expect(container.querySelector("button")?.disabled).toBe(false);
		} finally {
			await act(async () => root.unmount());
			client.clear();
		}
	});
});

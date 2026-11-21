import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import { handleLocalRpc } from "../../dev/local-fixtures";
import { AdminBillingPage } from "./admin-billing-page";
import { ComputePage } from "./compute-page";

const authority = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority } }),
}));

const overview = () =>
	structuredClone(
		(
			handleLocalRpc("/api/rpc/billing/getOverview", "POST", { json: {} })!
				.body as { json: BillingOverview }
		).json,
	);

function render(permissions: string[], value = overview()) {
	const client = new QueryClient();
	authority.permissions = permissions;
	client.setQueryData(billingOverviewQueryOptions().queryKey, value);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ComputePage tab="members" onTabChange={() => {}} />
			<AdminBillingPage
				section="overview"
				onSectionChange={() => {}}
				onClearCheckout={() => {}}
			/>
		</QueryClientProvider>,
	);
	client.clear();
	return new DOMParser().parseFromString(html, "text/html").body;
}

describe("Usage and Billing access", () => {
	it("hides cached usage and billing figures when the account has no billing permissions", () => {
		const body = render([]);
		expect(body.textContent).toContain("You don’t have access to usage");
		expect(body.textContent).toContain(
			"Only organization owners can manage billing",
		);
		expect(body.querySelector("[role=meter]")).toBeNull();
		expect(body.querySelector("table")).toBeNull();
	});

	it("shows shares and short identity labels to billing readers, withholding exact figures and the Billing link", () => {
		const value = overview();
		const userId = "abcdef01-0000-4000-8000-000000000001";
		value.credits.members = [
			{ userId, name: userId, usedCredits: 1234, monthlyCapCredits: 2000 },
			{
				userId: "unused-fixture",
				name: "Unused member",
				usedCredits: 0,
				monthlyCapCredits: null,
			},
		];
		const body = render(["billing:read"], value);
		expect(body.textContent).toContain("Agent identity · abcdef01");
		expect(body.textContent).toContain("38% of cap left");
		expect(body.textContent).not.toContain(userId);
		expect(body.textContent).not.toContain("1,234");
		expect(body.textContent).not.toContain("Unused member");
		expect(body.querySelector('a[href="/admin/billing"]')).toBeNull();
	});
});

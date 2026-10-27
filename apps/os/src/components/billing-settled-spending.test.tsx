import type { BillingInferenceSpending } from "@tedix/api-contract/schemas/billing-spending";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { osQuery } from "@/lib/os-query-options";
import { BillingSettledSpending } from "./billing-settled-spending";

const options = () =>
	osQuery.billing.getInferenceSpending.queryOptions({ input: { limit: 100 } });
const data: BillingInferenceSpending = {
	from: "2026-10-01T00:00:00.000Z",
	to: "2026-10-31T00:00:00.000Z",
	hasMore: false,
	rows: [
		{
			id: "receipt-fictional",
			runId: "run-fictional",
			traceId: null,
			provider: "fictional",
			model: "fictional-model",
			occurredAt: "2026-10-02T00:00:00.000Z",
			creditAppliedMicros: 1_000_000,
			customerChargeMicros: 500_000,
			currency: "eur",
			creditValueMicros: 10_000,
			rateVersionId: "price-fictional",
		},
	],
};
function render(client: QueryClient) {
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<BillingSettledSpending />
		</QueryClientProvider>,
	);
}
function client() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryOnMount: false, staleTime: Infinity },
		},
	});
}

describe("BillingSettledSpending", () => {
	it("renders loaded customer charges in credits and EUR with a run link", () => {
		const queryClient = client();
		queryClient.setQueryData(options().queryKey, data);
		const html = render(queryClient);
		expect(html).toContain("150 credits");
		expect(html).toContain("€1.5");
		expect(html).toContain('href="/work/runs/run-fictional"');
		expect(html).toContain("Recorded price versions");
		queryClient.clear();
	});
	it("explains an empty receipt window without claiming zero spending", () => {
		const queryClient = client();
		queryClient.setQueryData(options().queryKey, { ...data, rows: [] });
		const html = render(queryClient);
		expect(html).toContain("No settled monetary inference receipts");
		expect(html).toContain("Unsettled");
		expect(html).not.toContain("€0");
		queryClient.clear();
	});
	it("keeps read errors distinct from an empty window", async () => {
		const queryClient = client();
		await queryClient
			.fetchQuery({
				...options(),
				queryFn: () => Promise.reject(new Error("Unavailable")),
			})
			.catch(() => {});
		const html = render(queryClient);
		expect(html).toContain("Credit charges could not be loaded");
		expect(html).toContain("This does not mean zero");
		expect(html).not.toContain("No settled monetary inference receipts");
		queryClient.clear();
	});
	it("labels a pending read without showing an amount", () => {
		const queryClient = client();
		expect(render(queryClient)).toContain(
			'aria-label="Loading settled credit charges"',
		);
		queryClient.clear();
	});
});

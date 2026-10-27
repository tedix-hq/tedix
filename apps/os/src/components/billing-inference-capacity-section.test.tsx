import {
	BillingOverviewSchema,
	type BillingOverview,
} from "@tedix/api-contract/schemas/billing";
import { runtimeInferenceDenialMessage } from "@tedix/api-contract/schemas/runtime-entitlements";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { handleLocalRpc } from "../../dev/local-fixtures";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import { BillingInferenceCapacitySection } from "./billing-inference-capacity-section";
import { BillingCreditWallet } from "./billing-credit-wallet";

const reasons =
	BillingOverviewSchema.shape.inferenceCapacity.shape.blockingReason.unwrap()
		.options;

describe("billing denial consistency", () => {
	it.each(reasons)(
		"both billing panels show the same reason for %s",
		(code) => {
			const overview = (
				handleLocalRpc("/api/rpc/billing/getOverview", "POST", { json: {} })!
					.body as { json: BillingOverview }
			).json;
			overview.inferenceCapacity.available = false;
			overview.inferenceCapacity.blockingReason = code;
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false, staleTime: Infinity } },
			});
			client.setQueryData(billingOverviewQueryOptions().queryKey, overview);
			try {
				const html = renderToStaticMarkup(
					<QueryClientProvider client={client}>
						<BillingCreditWallet overview={overview} />
						<BillingInferenceCapacitySection />
					</QueryClientProvider>,
				);
				const doc = new DOMParser().parseFromString(html, "text/html");
				const alerts = [...doc.querySelectorAll('[role="alert"]')];
				expect(alerts).toHaveLength(2);
				for (const alert of alerts) {
					expect(alert.textContent).toContain(
						runtimeInferenceDenialMessage(code),
					);
				}
			} finally {
				client.clear();
			}
		},
	);
});

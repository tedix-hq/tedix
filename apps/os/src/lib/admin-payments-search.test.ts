import { describe, expect, it } from "vite-plus/test";
import {
	paymentsEventsInput,
	paymentsSummaryInput,
	type AdminPaymentsSearch,
} from "./admin-payments-search";

describe("payment spend-summary window", () => {
	it("changes summary input while retaining the complete bounded event request", () => {
		const search: AdminPaymentsSearch = {
			hours: 24,
			status: "settled",
			app: "storefront",
			tool: "market_report",
		};
		const longer = { ...search, hours: 2160 } as const;
		expect(paymentsEventsInput(search)).toEqual(paymentsEventsInput(longer));
		expect(paymentsEventsInput(search)).toEqual({
			limit: 100,
			status: "settled",
			appSlug: "storefront",
			toolId: "market_report",
		});
		expect(paymentsSummaryInput(search).lastHours).toBe(24);
		expect(paymentsSummaryInput(longer).lastHours).toBe(2160);
	});
});

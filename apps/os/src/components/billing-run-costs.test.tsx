import type { BillingLedgerOutput } from "@tedix/api-contract/contracts/org-usage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { osQuery } from "@/lib/os-query-options";
import { BillingRunCosts } from "./billing-run-costs";

vi.mock("@/lib/api", () => ({
	osApi: {
		orgUsage: {
			getBillingLedger: () => Promise.reject(new Error("Unavailable")),
		},
	},
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("./billing-settled-spending", () => ({
	BillingSettledSpending: () => <div>Settled charges</div>,
}));
const options = () =>
	osQuery.orgUsage.getBillingLedger.queryOptions({
		input: {
			organizationId: "org-fictional",
			period: "30d",
			includeUnattributed: true,
			limit: 200,
		},
	});
const data = (rows: BillingLedgerOutput["rows"]): BillingLedgerOutput =>
	({
		rows,
		pagination: {
			returnedRows: rows.length,
			totalRows: rows.length,
			hasMore: false,
		},
	}) as BillingLedgerOutput;
const row = {
	id: "cost-fictional",
	runId: "run-fictional",
	snapshotAt: "2026-10-02T00:00:00.000Z",
	provider: "fictional",
	dataQuality: "ok",
	estimatedCostUsd: 1.25,
	costBasis: "governed_estimate",
	totalTokens: 100,
} as BillingLedgerOutput["rows"][number];
async function inspect(
	value: BillingLedgerOutput | Error,
	check: (container: HTMLDivElement) => void,
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryOnMount: false, staleTime: Infinity },
		},
	});
	if (value instanceof Error)
		await client
			.fetchQuery({ ...options(), queryFn: () => Promise.reject(value) })
			.catch(() => {});
	else client.setQueryData(options().queryKey, value);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<BillingRunCosts organizationId="org-fictional" />
				</QueryClientProvider>,
			),
		);
		expect(container.textContent).not.toContain("Settled charges");
		await act(async () => {
			container.querySelector("button")!.click();
		});
		// Expanding enables the query; an errored entry without data refetches.
		await vi.waitFor(() =>
			expect(
				container.querySelector('[aria-label="Loading recorded costs"]'),
			).toBeNull(),
		);
		expect(
			container.querySelector("button")?.getAttribute("aria-expanded"),
		).toBe("true");
		check(container);
		await act(async () => {
			container.querySelector("button")!.click();
		});
		expect(container.textContent).not.toContain("Settled charges");
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
}

describe("BillingRunCosts", () => {
	it("expands loaded costs with a run link and attribution limits", async () => {
		await inspect(data([row]), (container) => {
			expect(container.textContent).toContain("$1.25");
			expect(
				container.querySelector('a[href="/work/runs/run-fictional"]'),
			).not.toBeNull();
			expect(container.textContent).toContain(
				"separate from customer credit charges",
			);
			expect(container.textContent).toContain(
				"Run attribution can still be incomplete",
			);
		});
	});
	it("shows an empty ledger without fabricating a zero cost", async () => {
		await inspect(data([]), (container) => {
			expect(container.textContent).toContain(
				"No model cost records in this window",
			);
			expect(container.textContent).not.toContain("$0");
		});
	});
	it("shows read failure separately from an empty ledger", async () => {
		await inspect(new Error("Unavailable"), (container) => {
			expect(container.textContent).toContain(
				"Recorded costs could not be read",
			);
			expect(container.textContent).toContain(
				"This does not mean zero spending",
			);
			expect(container.textContent).not.toContain("No model cost records");
		});
	});
});

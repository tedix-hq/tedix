import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
	allowed: true,
	rows: [
		{
			accountId: "test",
			service: "Dynamic Workers",
			day: "2026-11-20",
			costMicros: 7_000_000,
			consumedQuantity: 250,
			consumedUnit: "requests",
			fetchedAt: "2026-11-22T02:00:00Z",
		},
		{
			accountId: "test",
			service: "Dynamic Workers",
			day: "2026-11-21",
			costMicros: 74_000_000,
			consumedQuantity: 1000,
			consumedUnit: "requests",
			fetchedAt: "2026-11-22T02:00:00Z",
		},
		{
			accountId: "test",
			service: "D1 rows written",
			day: "2026-11-20",
			costMicros: 2_000_000,
			consumedQuantity: 15,
			consumedUnit: "rows",
			fetchedAt: "2026-11-22T02:00:00Z",
		},
	],
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: {
			authority: {
				permissions: state.allowed ? ["platform:admin"] : ["billing:manage"],
			},
		},
	}),
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		billing: { getCloudflareCosts: { queryOptions: (args: unknown) => args } },
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: { rows: state.rows },
		isPending: false,
		isError: false,
	}),
}));
import { CloudflarePlatformCosts } from "./cloudflare-platform-costs";

it("shows month totals, selected daily costs, unavailable days, and consumed units", () => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-22T08:00:00Z"));
	try {
		state.allowed = true;
		const html = renderToStaticMarkup(<CloudflarePlatformCosts />);
		expect(html).toContain("$81.00");
		expect(html).toContain("$74.00");
		expect(html).toContain("Unavailable");
		expect(html).toContain("requests");
		expect(html).toContain("Daily trend and consumed usage");
	} finally {
		vi.restoreAllMocks();
	}
});
it("does not render account-wide costs for an organization billing owner", () => {
	state.allowed = false;
	expect(renderToStaticMarkup(<CloudflarePlatformCosts />)).toBe("");
});

import { describe, expect, it } from "vite-plus/test";
import { WORK_ITEM_TOOLS } from "./aggregate-tedis-work-items";

describe("dispatcher health aggregate tools", () => {
	it("uses verb-first names and exact organization-scoped RPC endpoints", () => {
		const byName = new Map(WORK_ITEM_TOOLS.map((tool) => [tool.name, tool]));
		expect(byName.get("report_dispatcher_health")).toMatchObject({
			remoteName: "report_dispatcher_health",
			rpcEndpoint: "dispatcherHealth/report",
			includeTediIdParam: false,
		});
		expect(byName.get("list_dispatcher_health")).toMatchObject({
			remoteName: "list_dispatcher_health",
			rpcEndpoint: "dispatcherHealth/list",
			includeTediIdParam: false,
		});
		expect(
			byName.get("report_dispatcher_health")?.inputSchema.properties,
		).not.toHaveProperty("organizationId");
	});
});

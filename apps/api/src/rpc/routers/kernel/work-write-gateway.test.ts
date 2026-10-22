import { describe, expect, it } from "vite-plus/test";
import { workWriteGateway } from "./work-write-gateway";
import type { KernelRouteDecision } from "./route-schema";
const route = (capability = "work_items.create", appSlug = "tenant-provider") =>
	({
		routeKind: "propose_tool_write",
		toolIntent: { capability, appSlug },
	}) as KernelRouteDecision;
const gateway = {
	slug: "tenant-unified",
	name: "Workspace gateway",
	codeMode: true as const,
	capabilities: ["work_items.create"],
};
describe("Work gateway grounding", () => {
	it("uses the only advertised gateway rather than the selected resource's app", () => {
		expect(
			workWriteGateway(route(), [
				gateway,
				{ slug: "tenant-provider", name: "Resource" },
			]),
		).toBe(gateway.slug);
	});
	it("refuses unadvertised or ambiguous gateways", () => {
		expect(
			workWriteGateway(route(), [{ ...gateway, capabilities: [] }]),
		).toBeNull();
		expect(
			workWriteGateway(route(), [gateway, { ...gateway, slug: "other" }]),
		).toBeNull();
	});
	it("preserves a grounded gateway and unrelated external writes", () => {
		expect(
			workWriteGateway(route("work_items.create", gateway.slug), [
				gateway,
				{ ...gateway, slug: "other" },
			]),
		).toBe(gateway.slug);
		expect(
			workWriteGateway(route("globex.invoices.create"), [gateway]),
		).toBeNull();
		expect(
			workWriteGateway(route("notion.pages.create"), [gateway]),
		).toBeNull();
	});
});

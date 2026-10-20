import { Hono } from "hono";
import { registerCorsAndLimits } from "./http/cors-and-limits";
import { describe, expect, it } from "vite-plus/test";
import {
	bindMcpServicePrincipal,
	correlatedServiceRequest,
	getServiceBindingPrincipal,
} from "./service-principal";

describe("service principal across request correlation", () => {
	it("preserves the configured principal on the trace middleware clone", () => {
		const original = new Request("https://api.test/rpc/tedis/get");
		bindMcpServicePrincipal(original);
		const { request } = correlatedServiceRequest(original);
		expect(request).not.toBe(original);
		expect(getServiceBindingPrincipal(request)).toBe("mcp-edge");
	});
	it("does not promote caller-supplied principal headers", () => {
		const original = new Request("https://api.test/rpc/tedis/get", {
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": "system",
				"X-Tedix-Service-Principal": "mcp-edge",
			},
		});
		expect(
			getServiceBindingPrincipal(correlatedServiceRequest(original).request),
		).toBeUndefined();
	});
});

it.each([true, false])(
	"preserves only configured authority through the actual HTTP middleware: %s",
	async (configured) => {
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		registerCorsAndLimits(app);
		app.get("/principal-proof", (c) =>
			c.text(getServiceBindingPrincipal(c.req.raw) ?? "absent"),
		);
		const request = new Request("https://api.test/principal-proof", {
			headers: { "X-Tedix-Service-Principal": "mcp-edge" },
		});
		if (configured) bindMcpServicePrincipal(request);
		const response = await app.fetch(request, {
			API_URL: "https://api.test",
		} as CloudflareEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(configured ? "mcp-edge" : "absent");
	},
);

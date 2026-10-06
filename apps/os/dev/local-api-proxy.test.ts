import { LOCAL_DEMO_TOKEN } from "@tedix/auth/local-demo";
import { describe, expect, test } from "vite-plus/test";
import { localApiProxyOptions } from "./local-api-proxy";

describe("local API proxy", () => {
	test("is absent from the fixture-only developer lane", () => {
		expect(localApiProxyOptions(undefined)).toBeUndefined();
	});

	test("proxies same-origin OS calls to the isolated API with local identity", () => {
		const options = localApiProxyOptions("http://localhost:8790");
		expect(options).toMatchObject({
			target: "http://localhost:8790",
			changeOrigin: true,
			headers: { authorization: `Bearer ${LOCAL_DEMO_TOKEN}` },
		});
		expect(options?.rewrite?.("/api/rpc/osWorkspaces/workspaces/list")).toBe(
			"/rpc/osWorkspaces/workspaces/list",
		);
	});

	test.each([
		"https://localhost:8790",
		"http://api.tedix.dev",
		"http://user:password@localhost:8790",
		"http://localhost:8790/rpc",
	])("refuses to transmit the local identity to %s", (target) => {
		expect(() => localApiProxyOptions(target)).toThrow(
			"must be an HTTP loopback origin",
		);
	});
});

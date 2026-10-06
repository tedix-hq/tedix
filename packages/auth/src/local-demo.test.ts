import { describe, expect, test } from "vite-plus/test";
import {
	createLocalDemoUserPayload,
	isLocalDemoRequest,
	isLoopbackHostname,
	LOCAL_DEMO_PROJECT_ID,
	LOCAL_DEMO_TOKEN,
	resolveLocalDemoUser,
} from "./local-demo";

describe("local demo identity", () => {
	test("accepts the exact demo token only on an isolated loopback runtime", () => {
		expect(
			resolveLocalDemoUser({
				environment: "development",
				projectId: LOCAL_DEMO_PROJECT_ID,
				token: LOCAL_DEMO_TOKEN,
				url: "http://localhost:8787/rpc/organizations/getMyOrganization",
			}),
		).toMatchObject({ sub: "local-demo-owner", roles: ["owner"] });
		expect(
			resolveLocalDemoUser({
				environment: "development",
				projectId: LOCAL_DEMO_PROJECT_ID,
				token: LOCAL_DEMO_TOKEN,
				url: "http://internal-worker/rpc",
				hostname: "localhost",
			}),
		).toMatchObject({ sub: "local-demo-owner" });
		expect(
			resolveLocalDemoUser({
				environment: "development",
				projectId: LOCAL_DEMO_PROJECT_ID,
				token: LOCAL_DEMO_TOKEN,
				url: "http://internal-worker/rpc",
				enabled: true,
			}),
		).toMatchObject({ sub: "local-demo-owner" });

		for (const rejected of [
			{
				environment: "production",
				projectId: LOCAL_DEMO_PROJECT_ID,
				token: LOCAL_DEMO_TOKEN,
				url: "http://localhost:8787/rpc",
			},
			{
				environment: "development",
				projectId: "P-production",
				token: LOCAL_DEMO_TOKEN,
				url: "http://localhost:8787/rpc",
			},
			{
				environment: "development",
				projectId: LOCAL_DEMO_PROJECT_ID,
				token: LOCAL_DEMO_TOKEN,
				url: "https://api.example.com/rpc",
			},
			{
				environment: "development",
				projectId: LOCAL_DEMO_PROJECT_ID,
				token: "not-the-demo-token",
				url: "http://127.0.0.1:8787/rpc",
			},
		]) {
			expect(resolveLocalDemoUser(rejected)).toBeNull();
		}
	});

	test("recognizes only loopback hostnames", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("my-os.localhost")).toBe(true);
		expect(isLoopbackHostname("nested.my-os.localhost")).toBe(true);
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("localhost.example.com")).toBe(false);
		expect(
			isLocalDemoRequest({
				environment: "development",
				projectId: LOCAL_DEMO_PROJECT_ID,
				url: "invalid",
			}),
		).toBe(false);
	});

	test("creates a human-shaped short-lived payload", () => {
		const payload = createLocalDemoUserPayload(1_000_000);
		expect(payload.email).toBe("owner@localhost.invalid");
		expect(payload.dct).toBe("personal_local-demo-owner");
		expect(payload.iat).toBe(1_000);
		expect(payload.exp).toBe(1_000 + 86_400);
	});
});

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveProductLoginIntent } from "./product-login-routing";
import { isDescopeFlowContinuation } from "@/shared/session-status";

const INTENT = "request_1234567890abcdefghij";

afterEach(() => vi.unstubAllGlobals());

describe("central product login routing", () => {
	it("uses the installation auth host only on its exact OS login origin", () => {
		vi.stubGlobal("__OS_URL__", "https://os.acme.example");
		vi.stubGlobal("__SESSION_BROKER_URL__", "https://auth.acme.example");
		expect(
			resolveProductLoginIntent(
				`https://os.acme.example/login?intent=${INTENT}`,
			),
		).toMatchObject({
			authorizeUrl: `https://auth.acme.example/tedix/session/authorize?intent=${INTENT}`,
		});
		expect(
			resolveProductLoginIntent(`https://os.tedix.dev/login?intent=${INTENT}`),
		).toBeNull();
	});
	it("returns only the fixed auth-host authorize URL", () => {
		expect(
			resolveProductLoginIntent(
				`https://os.tedix.dev/login?intent=${INTENT}&surface=cms&return_to=https://evil.example`,
			),
		).toEqual({
			authorizeUrl: `https://auth.tedix.dev/tedix/session/authorize?intent=${INTENT}`,
			intentId: INTENT,
			skipOrganizationPreparation: false,
		});
	});

	it("recognizes only the broker's outbound presentation hint", () => {
		expect(
			resolveProductLoginIntent(
				`https://os.tedix.dev/login?intent=${INTENT}&outbound=1`,
			),
		).toMatchObject({
			intentId: INTENT,
			skipOrganizationPreparation: true,
		});
	});

	it.each([
		"not a URL",
		"https://os.tedix.dev/login",
		"https://os.tedix.dev/login?intent=https://evil.example",
		"https://os.tedix.dev/login?intent=short",
	])("rejects invalid request %s", (url) => {
		expect(resolveProductLoginIntent(url)).toBeNull();
	});

	it("recognizes a magic-link flow continuation without an intent", () => {
		expect(
			isDescopeFlowContinuation(
				"https://os.tedix.dev/login?descope-login-flow=sign-up-or-in%7C%23%7C3IPY_24.end",
			),
		).toBe(true);
		expect(isDescopeFlowContinuation("https://os.tedix.dev/login")).toBe(false);
		expect(isDescopeFlowContinuation("not a URL")).toBe(false);
	});
});

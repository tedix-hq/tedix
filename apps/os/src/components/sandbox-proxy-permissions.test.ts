import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
import { describe, expect, it } from "vite-plus/test";
import proxySource from "../../public/sandbox_proxy.html?raw";

describe("MCP Apps sandbox proxy permission policy", () => {
	it("pins the proxy mapping to the official MCP Apps allow-attribute mapping", () => {
		expect(
			buildAllowAttribute({
				camera: {},
				microphone: {},
				geolocation: {},
				clipboardWrite: {},
			}),
		).toBe("camera; microphone; geolocation; clipboard-write");
		expect(proxySource).toContain('camera: "camera"');
		expect(proxySource).toContain('microphone: "microphone"');
		expect(proxySource).toContain('geolocation: "geolocation"');
		expect(proxySource).toContain('clipboardWrite: "clipboard-write"');
	});

	it("applies only validated requests to the opaque guest iframe", () => {
		expect(proxySource).toContain(
			'new URLSearchParams(location.search).get("permissions")',
		);
		expect(proxySource).toMatch(
			/Object\.prototype\.hasOwnProperty\.call\(\s*PERMISSION_FEATURES,\s*key,?\s*\)/,
		);
		expect(proxySource).toContain('frame.setAttribute("allow", allow)');
		expect(proxySource).toContain(
			'var GUEST_SANDBOX = "allow-scripts allow-forms"',
		);
	});
});

import { describe, expect, it } from "vite-plus/test";
import { installationOrigins, resolveCorsOrigin } from "./cors-origins";

const installEnv = {
	OS_URL: "https://tedix-os.example-install.workers.dev",
	MCP_UI_URL: "https://tedix-widget.example-install.workers.dev",
	MCP_URL: "https://tedix-mcp.example-install.workers.dev",
	TEDI_DEV_BASE_URL: "https://tedix-tedi.example-install.workers.dev",
	CORS_ALLOWED_ORIGINS:
		"https://preview.example-install.workers.dev, https://ops.customer.example",
};

describe("resolveCorsOrigin", () => {
	it("allows first-party production origins", () => {
		expect(resolveCorsOrigin("https://os.tedix.dev", {})).toBe(
			"https://os.tedix.dev",
		);
	});

	it("rejects an unlisted origin", () => {
		expect(resolveCorsOrigin("http://localhost:3002", {})).toBeUndefined();
	});

	it("allows the installation's configured surface origins", () => {
		expect(
			resolveCorsOrigin(
				"https://tedix-os.example-install.workers.dev",
				installEnv,
			),
		).toBe("https://tedix-os.example-install.workers.dev");
	});

	it("allows origins from the CORS_ALLOWED_ORIGINS csv", () => {
		expect(
			resolveCorsOrigin(
				"https://preview.example-install.workers.dev",
				installEnv,
			),
		).toBe("https://preview.example-install.workers.dev");
		expect(resolveCorsOrigin("https://ops.customer.example", installEnv)).toBe(
			"https://ops.customer.example",
		);
	});

	it("allows Tedix OS tenant origins but only over https and only that branch", () => {
		expect(resolveCorsOrigin("https://acme.os.tedix.dev", {})).toBe(
			"https://acme.os.tedix.dev",
		);
		expect(
			resolveCorsOrigin("https://acme-s-workspace-1a2b3c.os.tedix.dev", {}),
		).toBe("https://acme-s-workspace-1a2b3c.os.tedix.dev");
		expect(resolveCorsOrigin("http://acme.os.tedix.dev", {})).toBeUndefined();
		expect(
			resolveCorsOrigin("https://evil-os.tedix.dev.attacker.com", {}),
		).toBeUndefined();
		expect(resolveCorsOrigin("https://foo.cms.tedix.dev", {})).toBeUndefined();
	});

	it("still allows *.tedix.tech dev tunnels but not the apex", () => {
		expect(resolveCorsOrigin("https://anything.tedix.tech", {})).toBe(
			"https://anything.tedix.tech",
		);
		expect(resolveCorsOrigin("https://tedix.tech", {})).toBeUndefined();
	});

	it("denies unknown origins even with install config present", () => {
		expect(
			resolveCorsOrigin("https://evil.example", installEnv),
		).toBeUndefined();
		expect(resolveCorsOrigin("not-a-url", installEnv)).toBeUndefined();
	});

	it("ignores malformed configured URLs instead of throwing", () => {
		expect(
			installationOrigins({
				OS_URL: "nope",
				CORS_ALLOWED_ORIGINS: " , also-not-a-url ,https://ok.example",
			}),
		).toEqual(new Set(["https://ok.example"]));
	});
});

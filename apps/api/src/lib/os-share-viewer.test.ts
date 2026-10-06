import { describe, expect, it } from "vite-plus/test";
import {
	handleOsShareViewer,
	handleOsShareViewerScript,
	handleOsShareViewerStyles,
} from "./os-share-viewer";

describe("OS share viewer", () => {
	it("serves a branded shell with a locked-down CSP and no token slot", async () => {
		const response = handleOsShareViewer();
		const html = await response.text();
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(html).toContain("Shared with Tedix");
		expect(html).toContain("Governed share");
		expect(html).not.toContain("{{token}}");
	});

	it("redeems the fragment in memory, removes it, and never stores it", async () => {
		const script = await handleOsShareViewerScript().text();
		expect(script).toContain("location.hash");
		expect(script).toContain("history.replaceState");
		expect(script).toContain('fetch("/os-shared/redeem"');
		expect(script).toContain('fetch("/os-shared/session"');
		expect(script).toContain("window.setInterval");
		expect(script).not.toContain("localStorage");
		expect(script).not.toContain("sessionStorage");
	});

	it("serves self-contained responsive viewer styles", async () => {
		const response = handleOsShareViewerStyles();
		expect(response.headers.get("content-type")).toContain("text/css");
		expect(await response.text()).toContain("aspect-ratio:16/9");
	});
});

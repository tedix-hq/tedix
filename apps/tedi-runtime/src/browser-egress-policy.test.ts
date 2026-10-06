import assert from "node:assert/strict";
import {
	browserEgressDecision,
	browserToolEgressDecision,
	hasBrowserHostnameRestrictions,
} from "./browser-egress-policy";

const org = {
	allowedHostnames: ["*.example.com", "docs.cloudflare.com"],
	deniedHostnames: ["admin.example.com"],
};
const tedi = {
	allowedHostnames: ["research.example.com", "docs.cloudflare.com"],
	deniedHostnames: [],
};

function exerciseBrowserEgressPolicy(): void {
	assert.equal(hasBrowserHostnameRestrictions([undefined]), false);
	assert.equal(hasBrowserHostnameRestrictions([org]), true);
	assert.deepEqual(
		browserEgressDecision("https://research.example.com/a", [org, tedi]),
		{ decision: "allow", hostname: "research.example.com" },
	);
	assert.equal(
		browserEgressDecision("https://admin.example.com", [org, tedi]).decision,
		"deny",
	);
	assert.equal(
		browserEgressDecision("https://other.example.com", [org, tedi]).decision,
		"deny",
	);
	assert.equal(
		browserEgressDecision("https://example.com", [org]).decision,
		"deny",
	);
	assert.equal(
		browserEgressDecision("file:///etc/passwd", [org]).decision,
		"deny",
	);
	assert.deepEqual(
		browserToolEgressDecision("browser_execute", { code: "..." }, [org]),
		{ decision: "deny", hostname: null, reason: "uninspectable_cdp" },
	);
	assert.deepEqual(
		browserToolEgressDecision("browser_markdown", { html: "<p>local</p>" }, [
			org,
		]),
		{ decision: "deny", hostname: null, reason: "uninspectable_html" },
	);
	assert.equal(
		browserToolEgressDecision(
			"browser_markdown",
			{ url: "https://docs.cloudflare.com" },
			[org, tedi],
		)?.decision,
		"allow",
	);
	assert.equal(
		browserToolEgressDecision("browser_execute", { code: "..." }, [undefined]),
		null,
	);
}

if (process.env.VITEST === "true") {
	const { it } = await import("vite-plus/test");
	it("composes organization and tedi browser hostname policy", () => {
		exerciseBrowserEgressPolicy();
	});
} else {
	exerciseBrowserEgressPolicy();
}

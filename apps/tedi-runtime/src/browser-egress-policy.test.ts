import assert from "node:assert/strict";
import {
	browserEgressDecision,
	browserToolEgressDecision,
	hasBrowserHostnameRestrictions,
	persistentBrowserEgress,
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

function exercisePersistentBrowserEgress(): void {
	assert.deepEqual(persistentBrowserEgress([undefined, undefined]), {
		enforceable: true,
	});
	// Org and tedi allowlists intersect; the org deny rule falls outside it.
	assert.deepEqual(persistentBrowserEgress([org, tedi]), {
		enforceable: true,
		allowedDomains: ["docs.cloudflare.com", "research.example.com"],
	});
	// The deny rule overlaps the org's own wildcard, so CDP stays refused.
	assert.deepEqual(persistentBrowserEgress([org]), {
		enforceable: false,
		reason: "uninspectable_cdp",
	});
	assert.deepEqual(
		persistentBrowserEgress([
			{ allowedHostnames: [], deniedHostnames: ["evil.test"] },
		]),
		{ enforceable: false, reason: "uninspectable_cdp" },
	);
	assert.deepEqual(
		persistentBrowserEgress([
			{ allowedHostnames: ["a.test"], deniedHostnames: [] },
			{ allowedHostnames: ["b.test"], deniedHostnames: [] },
		]),
		{ enforceable: false, reason: "hostname_not_allowed" },
	);
	assert.deepEqual(
		persistentBrowserEgress([
			{ allowedHostnames: ["*"], deniedHostnames: [] },
			{ allowedHostnames: ["*.example.com"], deniedHostnames: ["x.org"] },
		]),
		{ enforceable: true, allowedDomains: ["*.example.com"] },
	);
	assert.deepEqual(
		persistentBrowserEgress([
			{ allowedHostnames: ["*.example.com"], deniedHostnames: [] },
			{
				allowedHostnames: ["*.eu.example.com", "example.com"],
				deniedHostnames: [],
			},
		]),
		{ enforceable: true, allowedDomains: ["*.eu.example.com"] },
	);
	assert.deepEqual(
		persistentBrowserEgress([{ allowedHostnames: ["*"], deniedHostnames: [] }]),
		{ enforceable: true },
	);
}

if (process.env.VITEST === "true") {
	const { it } = await import("vite-plus/test");
	it("composes organization and tedi browser hostname policy", () => {
		exerciseBrowserEgressPolicy();
	});
	it("maps hostname policy to persistent browser guardrails", () => {
		exercisePersistentBrowserEgress();
	});
} else {
	exerciseBrowserEgressPolicy();
	exercisePersistentBrowserEgress();
}

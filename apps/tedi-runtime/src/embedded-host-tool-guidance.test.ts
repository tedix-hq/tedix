import assert from "node:assert/strict";
import { embeddedHostToolGuidance } from "./embedded-host-tool-guidance";

const guidance = embeddedHostToolGuidance({
	hostOrganizationId: "1",
	hostTenantArgument: "companyId",
	hostTenantNamespace: "acme_staging",
	portableWebMcpCallables: [
		"acme_staging.add_order_comment",
		"other.orders_list",
	],
	embeddedAssistantCallables: [
		"acme_staging.orders_status_summary",
		"acme_staging.orders_attention",
		"acme_staging.orders_attention",
	],
});

assert.match(guidance.join("\n"), /companyId=1/);
assert.match(
	guidance.join("\n"),
	/acme_staging\.orders_attention, acme_staging\.orders_status_summary/,
);
assert.doesNotMatch(guidance.join("\n"), /other\.orders_list/);
assert.doesNotMatch(guidance.join("\n"), /add_order_comment/);
assert.match(guidance.join("\n"), /call it directly/);
assert.doesNotMatch(guidance.join("\n"), /once with limit=12/);
assert.doesNotMatch(
	guidance.join("\n"),
	/Do not call orders_list|vehicles|workshop/,
);

// One lookup, then an answer. A host call costs seconds and every model
// round between calls costs about as much again, so a chained confirmation is
// ten seconds a person spends watching a panel for nothing.
assert.match(guidance.join("\n"), /call it once, then answer from that result/);
assert.match(
	guidance.join("\n"),
	/Do not chain a second call to confirm, enrich, or cross-check/,
);
// The instruction must not become "never call twice": a first result that does
// not answer the question still has to be followed up.
assert.match(
	guidance.join("\n"),
	/Call again only when the first result genuinely does not contain the answer/,
);

assert.deepEqual(embeddedHostToolGuidance({ hostOrganizationId: "1" }), []);

console.log("embedded host tool guidance passed");

const otherDomain = embeddedHostToolGuidance({
	hostOrganizationId: "tenant-a",
	hostTenantArgument: "accountId",
	hostTenantNamespace: "inventory",
	embeddedAssistantCallables: ["inventory.list_stock"],
}).join("\n");
assert.match(otherDomain, /inventory.list_stock/);
assert.doesNotMatch(otherDomain, /orders|customers|vehicles|workshop|limit=12/);

assert.match(otherDomain, /exact parameter schema is already known/);
assert.match(
	otherDomain,
	/exact admitted parameter schemas supplied with tedix_mcp_call_tool/,
);
assert.match(otherDomain, /Discovery tools are unavailable/);
assert.match(otherDomain, /Never guess argument names/);

import assert from "node:assert/strict";

import {
	getCmsAgentDiscoveryLinkHeader,
	withCmsAgentDiscoveryLinks,
} from "../src/agent-discovery";

assert.equal(
	getCmsAgentDiscoveryLinkHeader({
		publicSiteUrl: "https://www.acme.example",
		publicPathPrefix: null,
	}),
	'<https://www.acme.example/llms.txt>; rel="service-desc"; type="text/plain"',
);

assert.equal(
	getCmsAgentDiscoveryLinkHeader({
		publicSiteUrl: "https://www.globex.example",
		publicPathPrefix: "/guide",
	}),
	'<https://www.globex.example/guide/llms.txt>; rel="service-desc"; type="text/plain"',
);

const redirect = withCmsAgentDiscoveryLinks(
	new Response(null, {
		status: 301,
		headers: { Location: "https://www.acme.example/" },
	}),
	{ publicSiteUrl: "https://www.acme.example", publicPathPrefix: null },
);
assert.equal(redirect.status, 301);
assert.equal(redirect.headers.get("location"), "https://www.acme.example/");
assert.equal(
	redirect.headers.get("link"),
	'<https://www.acme.example/llms.txt>; rel="service-desc"; type="text/plain"',
);

console.log("cms-runtime agent discovery check passed");

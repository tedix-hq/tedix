import assert from "node:assert/strict";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { isAuthenticated } from "../src/auth";

function request(headers: HeadersInit): Request {
	return new Request("https://skill-runtime/internal", { headers });
}

assert.equal(
	await isAuthenticated(
		request({ "X-Service-Binding": "true" }),
		"platform-secret",
	),
	true,
	"private service bindings are trusted",
);

assert.equal(
	await isAuthenticated(
		// Public ingress (the default export) strips the marker.
		stripServiceBindingMarker(
			request({
				"X-Service-Binding": "true",
				"CF-Connecting-IP": "203.0.113.7",
			}),
		),
		"platform-secret",
	),
	false,
	"public requests cannot spoof the service-binding marker",
);

assert.equal(
	await isAuthenticated(
		request({ Authorization: "Bearer platform-secret" }),
		"platform-secret",
	),
	true,
	"the local-development token path accepts an exact timing-safe match",
);

assert.equal(
	await isAuthenticated(
		request({ Authorization: "Bearer wrong" }),
		"platform-secret",
	),
	false,
	"the local-development token path rejects mismatches",
);

console.log("skill-runtime auth tests passed");

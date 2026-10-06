import { TedixHomeClient } from "../src/home-client";

const url = process.env.TEDIX_PROTOCOL_CERT_URL;
const bearer = process.env.TEDIX_PROTOCOL_CERT_BEARER_TOKEN;
const configuredResourceUri = process.env.TEDIX_PROTOCOL_CERT_RESOURCE_URI;

if (!url || !bearer) {
	throw new Error(
		"Set TEDIX_PROTOCOL_CERT_URL and TEDIX_PROTOCOL_CERT_BEARER_TOKEN",
	);
}

const client = new TedixHomeClient({
	headers: { Authorization: `Bearer ${bearer}` },
	url,
});

try {
	const discover = await client.discoverProtocol();
	const runtime = await client.runCode(
		"async () => await codemode.__runtime()",
	);
	const resourceList = (await client.listResources()) as {
		resources?: Array<{ uri?: unknown }>;
	};
	const discoveredResourceUri = resourceList.resources?.find(
		(resource) => typeof resource.uri === "string" && resource.uri.length > 0,
	)?.uri;
	const resourceUri =
		configuredResourceUri ??
		(typeof discoveredResourceUri === "string"
			? discoveredResourceUri
			: undefined);
	if (!resourceUri) {
		throw new Error("Live MCP server did not list a readable resource URI");
	}
	const resource = await client.readResource(resourceUri);
	const taskResult = await client.callTool("home__async_canary", {
		conversationId: `home:cli-protocol-cert:${crypto.randomUUID()}`,
		limit: 1,
	});
	const health = await fetch(new URL("/health", url));
	const healthBody = health.ok
		? ((await health.json()) as { deployedSha?: unknown })
		: {};
	const deployedSha =
		typeof healthBody.deployedSha === "string" ? healthBody.deployedSha : null;
	console.log(
		JSON.stringify({
			ok: true,
			deployedSha,
			discover,
			runtime,
			resource,
			resourceUri,
			task: { passed: true, result: taskResult },
			subscriptionMode: "polling_only_explicit",
		}),
	);
} finally {
	await client.close();
}

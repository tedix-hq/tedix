import assert from "node:assert/strict";
import {
	createPersonalAgentClient,
	generatePersonalAgentSigningKey,
	type PersonalAgentClient,
} from "@tedix/auth/personal-agent-client";
import { createPersonalAgentSessionVerifier } from "@tedix/auth/personal-agent-session";
import {
	createPoppyAgentAiTools,
	POPPY_CALL_TOOL_NAME,
	POPPY_DISCOVER_TOOL_NAME,
} from "./poppy-agent-tools";

const clientId = "https://api.tedix.test/poppy-agent/amber-otter/client.json";
const jwksUri = "https://api.tedix.test/poppy-agent/amber-otter/jwks.json";
const company = "https://company.example";
const mcpUrl = "https://company.example/api/mcp";
const agentUrl = "https://company.example/api/poppy";
const tasksUrl = "https://company.example/api/tasks";

const discoveryDocument = {
	protocol_version: "1.0",
	organization: { name: "Example Company", domain: "company.example" },
	auth: { disabled: true },
	agent: {
		protocols: [
			{
				type: "poppy",
				endpoint: agentUrl,
				description: "Company agent",
			},
		],
	},
	apis: [{ type: "mcp", url: mcpUrl, description: "Shared work" }],
	tasks: { endpoint: tasksUrl },
};

const base = {
	enabled: true,
	db: {} as never,
	masterKey: undefined,
	apiBaseUrl: "https://api.tedix.test",
	tediId: "tedi-1",
	slug: "amber-otter",
};

// Hidden unless the tedi's Poppy identity is enabled.
assert.deepEqual(createPoppyAgentAiTools({ ...base, enabled: undefined }), {});
assert.deepEqual(createPoppyAgentAiTools({ ...base, enabled: false }), {});

const calls: { url: string; method: string; headers: Headers }[] = [];
let client: PersonalAgentClient;
const fetchFn = async (url: string, init?: RequestInit) => {
	if (url === `${company}/.well-known/poppy.json`)
		return Response.json(discoveryDocument);
	if (url === mcpUrl || url === agentUrl || url === tasksUrl) {
		calls.push({
			url,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
		});
		return Response.json({ ok: true });
	}
	return new Response("not found", { status: 404 });
};

const privateJwk = await generatePersonalAgentSigningKey();
client = createPersonalAgentClient({
	clientId,
	jwksUri,
	signingKey: privateJwk,
	clientName: "amber-otter",
	fetchFn,
});

const tools = createPoppyAgentAiTools({
	...base,
	loadClient: async () => client,
});
assert.deepEqual(Object.keys(tools).sort(), [
	POPPY_CALL_TOOL_NAME,
	POPPY_DISCOVER_TOOL_NAME,
]);

type ToolExecute = (
	input: Record<string, unknown>,
	options: { toolCallId: string; messages: [] },
) => Promise<Record<string, unknown>>;
const run = (name: string, input: Record<string, unknown>) =>
	(tools[name]!.execute as unknown as ToolExecute)(input, {
		toolCallId: `call-${name}`,
		messages: [],
	});

// Disabled key material reads as not_configured, not a crash.
const noKey = createPoppyAgentAiTools({
	...base,
	loadClient: async () => null,
});
const noKeyResult = (await (
	noKey[POPPY_DISCOVER_TOOL_NAME]!.execute as unknown as ToolExecute
)({ company: "company.example" }, { toolCallId: "c", messages: [] })) as {
	status: string;
};
assert.equal(noKeyResult.status, "not_configured");

const discovery = (await run(POPPY_DISCOVER_TOOL_NAME, {
	company: "company.example",
})) as {
	status: string;
	protocolVersion: string;
	audience: string;
	endpoints: Record<string, boolean>;
	document: string;
};
assert.equal(discovery.status, "ok");
assert.equal(discovery.protocolVersion, "1.0");
assert.equal(discovery.audience, "https://company.example");
assert.deepEqual(discovery.endpoints, {
	mcp: true,
	conversations: true,
	tasks: true,
});
assert.ok(discovery.document.includes("company.example"));

const mcpCall = (await run(POPPY_CALL_TOOL_NAME, {
	company: "company.example",
	surface: "mcp",
})) as {
	signed: boolean;
	status: number;
	host: string;
	endpoint: string;
	path: string;
	body: string;
};
assert.equal(mcpCall.signed, true);
assert.equal(mcpCall.status, 200);
assert.equal(mcpCall.host, "company.example");
assert.equal(mcpCall.endpoint, "mcp");
assert.equal(mcpCall.path, "/api/mcp");

const conversationsCall = (await run(POPPY_CALL_TOOL_NAME, {
	company: "company.example",
	surface: "conversations",
	text: "Look up the blue widget.",
})) as { status: number; host: string; endpoint: string };
assert.equal(conversationsCall.status, 200);
assert.equal(conversationsCall.endpoint, "conversations");

assert.equal(calls.length, 2);
assert.equal(calls[0]!.url, mcpUrl);
assert.equal(calls[1]!.url, agentUrl);
assert.equal(calls[0]!.headers.get("Poppy-Version"), "1.0");
// A Streamable HTTP MCP door answers 406 without both media types.
assert.equal(
	calls[0]!.headers.get("Accept"),
	"application/json, text/event-stream",
);

// The session the tool sent verifies under the existing Poppy verifier when
// the company resolves the tedi's hosted client metadata and JWKS.
const verifierFetch = async (url: string, init?: RequestInit) => {
	if (url === clientId) return Response.json(await client.clientMetadata());
	if (url === jwksUri) return Response.json(await client.jwks());
	return new Response("not found", { status: 404 });
};
const verify = createPersonalAgentSessionVerifier({
	fetchFn: verifierFetch,
});
for (const call of calls) {
	const token = call.headers.get("Poppy-Session");
	assert.ok(token);
	const session = await verify({
		request: new Request(call.url, {
			method: call.method,
			headers: {
				"Poppy-Version": "1.0",
				"Poppy-Session": token,
			},
		}),
		audience: "https://company.example",
	});
	assert.equal(session.clientId, clientId);
	assert.equal(session.userId, "tedi:amber-otter");
	assert.equal(session.agentId, "tedi:tedi-1");
}

console.log(
	"poppy-agent-tools: gating, discovery, signed calls and verifier acceptance passed",
);

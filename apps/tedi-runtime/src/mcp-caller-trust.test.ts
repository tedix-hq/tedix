/**
 * The runtime honours the gateway's `x-tedix-caller-trust` tier on an MCP
 * turn: `foreign` keeps only the read-only allowlist, reads the "Unverified
 * Sender" addendum, draws the background lane and is never learned from;
 * `tedi` keeps the full surface but cannot steer learning; `member` steers.
 * A Home delegation keeps its own ceiling whatever the tier. A missing header
 * fails closed to `foreign`: every first-party sender stamps the tier.
 */
import assert from "node:assert/strict";
import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import {
	facetWorkflowTurnProbe,
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	memoryStorage,
	nativeToolMarkers,
	tediDo,
} from "../test/tedi-do";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
import {
	callerTrustTierForDirectMcpAuth,
	callerTrustTierForRequest,
	mcpTurnSurfaceTrust,
} from "./mcp-caller-trust";

// --- the tier a request carries ---
assert.equal(
	callerTrustTierForRequest(new Headers()),
	"foreign",
	"a missing tier fails closed",
);
for (const tier of ["member", "tedi", "foreign"] as const) {
	assert.equal(
		callerTrustTierForRequest(new Headers({ [CALLER_TRUST_HEADER]: tier })),
		tier,
	);
}
assert.equal(
	callerTrustTierForRequest(new Headers({ [CALLER_TRUST_HEADER]: "admin" })),
	"foreign",
	"a malformed tier fails closed",
);

// --- a direct (non-gateway) /mcp caller's tier from its authentication ---
assert.equal(callerTrustTierForDirectMcpAuth(undefined), "foreign");
assert.equal(
	callerTrustTierForDirectMcpAuth({
		authenticated: false,
		authMethod: "none",
		scopes: [],
	}),
	"foreign",
);
assert.equal(
	callerTrustTierForDirectMcpAuth({
		authenticated: true,
		authMethod: "jwt",
		tediId: "tedi-1",
		scopes: ["tedi:admin"],
	}),
	"tedi",
);
assert.equal(
	callerTrustTierForDirectMcpAuth({
		authenticated: true,
		authMethod: "jwt",
		tediId: "tedi-1",
		scopes: ["platform:admin"],
	}),
	"member",
);
assert.equal(
	callerTrustTierForDirectMcpAuth({
		authenticated: true,
		authMethod: "api-key",
		scopes: [],
	}),
	"member",
);

// --- surface trust: only a plain foreign turn is untrusted ---
assert.equal(mcpTurnSurfaceTrust({}), "trusted");
assert.equal(mcpTurnSurfaceTrust({ callerTrust: "member" }), "trusted");
assert.equal(mcpTurnSurfaceTrust({ callerTrust: "tedi" }), "trusted");
assert.equal(mcpTurnSurfaceTrust({ callerTrust: "foreign" }), "untrusted");
assert.equal(
	mcpTurnSurfaceTrust({
		callerTrust: "foreign",
		workItemId: "work-1",
		homeRunId: "home-1",
	}),
	"trusted",
	"a Home delegation runs on the delegation ceiling",
);
console.log("PASS: caller trust tier and surface trust");

// --- prepareMcpFacetTurn: untrusted keeps read_skill only + the addendum ---
{
	const probe = mcpFacetTurnProbe({
		mcpRuntime: {
			bindTurn() {},
			getSystemInstructions: () => "MCP",
		},
		platform: { setEpisodeTrace() {} },
		fields: {
			skillReadTool: () => ({ read_skill: { marker: "read_skill" } }),
		},
	});
	const trusted = await probe.prepareMcpFacetTurn(MCP_FACET_TURN_INPUT);
	assert.ok("workspaceAiTools" in trusted.tools);
	assert.ok("read_skill" in trusted.tools);
	assert.doesNotMatch(trusted.system, /Unverified Sender/);

	const untrusted = await probe.prepareMcpFacetTurn({
		...MCP_FACET_TURN_INPUT,
		trust: "untrusted",
	});
	assert.deepEqual(Object.keys(untrusted.tools), ["read_skill"]);
	assert.match(untrusted.system, /## Unverified Sender/);
	assert.match(untrusted.system, /This caller is NOT verified/);
	assert.match(untrusted.system, /^SYSTEM/, "persona stays first");
}
console.log("PASS: prepareMcpFacetTurn trust");

// --- the durable workflow turn maps the tier onto the facet turn ---
async function workflowTurn(input: Record<string, unknown>) {
	const probe = facetWorkflowTurnProbe();
	await probe.run(input);
	const prepared = probe.prepared[0]!;
	const facet = probe.facetInputs[0]!;
	const commit = probe.commits[0]!;
	return { prepared, facet, commit };
}
{
	const foreign = await workflowTurn({
		callerTrust: "foreign",
		learningMode: "normal",
	});
	assert.equal(foreign.prepared.trust, "untrusted");
	assert.equal(foreign.facet.admissionClass, "background");
	assert.equal(foreign.commit.learningMode, "disabled");
	assert.equal(foreign.commit.dailyLog, false);

	const tedi = await workflowTurn({ callerTrust: "tedi" });
	assert.equal(tedi.prepared.trust, "trusted");
	assert.equal(tedi.facet.admissionClass, "operator");
	assert.equal(tedi.commit.learningMode, undefined);
	assert.equal(tedi.commit.dailyLog, undefined);

	const member = await workflowTurn({
		callerTrust: "member",
		learningMode: "disabled",
	});
	assert.equal(member.prepared.trust, "trusted");
	assert.equal(member.facet.admissionClass, "operator");
	assert.equal(member.commit.learningMode, "disabled");
	assert.equal(member.commit.dailyLog, undefined);

	const legacy = await workflowTurn({});
	assert.equal(legacy.prepared.trust, "trusted");
	assert.equal(legacy.facet.admissionClass, "operator");

	const delegated = await workflowTurn({
		callerTrust: "foreign",
		workItemId: "work-1",
		homeRunId: "home-1",
		authorityMode: "shadow",
	});
	assert.equal(delegated.prepared.trust, "trusted");
	assert.equal(delegated.commit.learningMode, undefined);
}
console.log("PASS: workflow turn trust mapping");

// --- /__internal/inject (sync): tier threads, member-only fields strip ---
function injectProbe() {
	const durable: Array<Record<string, unknown>> = [];
	const dispatched: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		env: {},
		name: "isolate-acme",
		state: { tediId: "tedi-1", orgId: "org-1", slug: "acme" },
		ctx: { storage: memoryStorage() },
		sessionRepo: { findTurnByIdempotencyKey: () => null },
		async ensureIdentity() {},
		async schedule() {
			return { id: "watchdog" };
		},
		async runWorkflow(_name: string, params: Record<string, unknown>) {
			dispatched.push(params);
		},
		async getPlatformClient() {
			return { recordRuntimeEvent: async () => {} };
		},
		async runDurableChatTurn(input: Record<string, unknown>) {
			durable.push(input);
			return {
				ok: true,
				run_id: "run-1",
				session_key: "main",
				assistant: null,
			};
		},
		computerWorkspace: () => ({ workspace: {} }),
		...nativeToolMarkers(),
	});
	return { agent, durable, dispatched };
}
async function inject(
	tier: string | null,
	body: Record<string, unknown>,
): Promise<{
	status: number;
	durable: Record<string, unknown> | undefined;
	dispatched: Record<string, unknown> | undefined;
}> {
	const probe = injectProbe();
	const headers = new Headers({ "Content-Type": "application/json" });
	if (tier !== null) headers.set(CALLER_TRUST_HEADER, tier);
	const response = await probe.agent.onRequest(
		new Request("https://do.internal/__internal/inject", {
			method: "POST",
			headers,
			body: JSON.stringify({ client_request_id: "req-1", ...body }),
		}),
	);
	return {
		status: response.status,
		durable: probe.durable[0],
		dispatched: probe.dispatched[0],
	};
}
{
	const steer = { text: "hello", learning_mode: "disabled" };
	const missing = await inject(null, steer);
	assert.equal(missing.status, 200);
	assert.equal(missing.durable?.callerTrust, "foreign", "header-less inject");
	assert.equal(missing.durable?.learningMode, undefined, "steering stripped");

	const member = await inject("member", steer);
	assert.equal(member.durable?.callerTrust, "member");
	assert.equal(member.durable?.learningMode, "disabled");

	const tedi = await inject("tedi", steer);
	assert.equal(tedi.durable?.callerTrust, "tedi");
	assert.equal(tedi.durable?.learningMode, undefined, "learning_mode stripped");

	const foreign = await inject("foreign", steer);
	assert.equal(foreign.durable?.callerTrust, "foreign");
	assert.equal(foreign.durable?.learningMode, undefined);
}
console.log("PASS: sync inject caller trust");

// --- /__internal/inject (async): a foreign caller cannot claim a delegation ---
{
	const delegation = {
		text: "do the work",
		async: true,
		metadata: {
			source: "kernelRuntime.delegate",
			executionSurface: "managed_job",
			workItemId: "work-1",
			homeRunId: "home-1",
		},
	};
	const member = await inject("member", delegation);
	assert.equal(member.status, 202);
	assert.equal(member.dispatched?.workItemId, "work-1");
	assert.equal(member.dispatched?.callerTrust, "member");

	const missing = await inject(null, delegation);
	assert.equal(missing.status, 202);
	assert.equal(missing.dispatched?.workItemId, undefined, "header-less inject");
	assert.equal(missing.dispatched?.homeRunId, undefined);
	assert.equal(missing.dispatched?.callerTrust, "foreign");

	const foreign = await inject("foreign", delegation);
	assert.equal(foreign.status, 202);
	assert.equal(foreign.dispatched?.workItemId, undefined);
	assert.equal(foreign.dispatched?.homeRunId, undefined);
	assert.equal(foreign.dispatched?.callerTrust, "foreign");
}
console.log("PASS: async inject caller trust");

// --- /mcp run_tedi_turn carries the tier into the durable turn ---
{
	const probe = injectProbe();
	const response = await probe.agent.onRequest(
		new Request("https://acme.tedi.tedix.dev/mcp", {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "run_tedi_turn",
				"Mcp-Protocol-Version": "2026-07-28",
				[CALLER_TRUST_HEADER]: "foreign",
				[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
					method: "service",
					principalId: "service-1",
					principalType: "service",
					scopes: ["tedi:admin"],
				}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "run_tedi_turn",
					arguments: {
						session_key: "main",
						text: "hello from mcp",
						client_request_id: "req-2",
					},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": {
							name: "test",
							version: "1",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		}),
	);
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal(probe.durable[0]?.text, "hello from mcp");
	assert.equal(probe.durable[0]?.callerTrust, "foreign");
}
console.log("PASS: mcp run_tedi_turn caller trust");

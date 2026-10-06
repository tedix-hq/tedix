import { describe, expect, it } from "vite-plus/test";
import {
	azureExecutionIdentity,
	ProviderExecutionIdentitySchema,
	providerDeploymentScope,
} from "./provider-execution";
const input = {
	url: "https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource/model/chat/completions?api-version=2025-03-01-preview",
	model: "model",
	accountId: "account",
	gatewayId: "gateway",
	transportKind: "https" as const,
};
describe("provider execution identity", () => {
	it("binds the actual resource, deployment, account and gateway", () => {
		const identity = azureExecutionIdentity(input);
		expect(identity.deployment).toBe("model");
		expect(providerDeploymentScope(identity)).toBe(
			JSON.stringify([
				"azure-openai",
				"account",
				"gateway",
				"https://resource.openai.azure.com",
				"model",
			]),
		);
	});
	it("takes Responses deployment from the sent body selection", () => {
		const identity = azureExecutionIdentity({
			...input,
			url: "https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource/openai/v1/responses",
			model: "custom-deployment",
		});
		expect(identity.deployment).toBe("custom-deployment");
	});
	it.each([
		"https://evil.test/v1/account/gateway/azure-openai/resource/model/chat/completions",
		"http://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource/model/chat/completions",
		"https://user@gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource/model/chat/completions",
		"https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource/a%2Fb/chat/completions",
	])("rejects hostile URL %s", (url) =>
		expect(() => azureExecutionIdentity({ ...input, url })).toThrow(),
	);
	it("rejects missing account and contradictory deployment", () => {
		expect(() =>
			azureExecutionIdentity({ ...input, accountId: undefined }),
		).toThrow();
		expect(() =>
			azureExecutionIdentity({ ...input, model: "other" }),
		).toThrow();
	});
});

const jevDirect = {
	provider: "typesafe",
	requestModel: "jev-1.13.0",
	transportKind: "direct-https",
	apiKind: "typesafe-systemone",
	gatewayAccountId: null,
	gatewayId: null,
	providerOrigin: "https://api.typesafe.ai",
	providerResource: null,
	deployment: null,
};
it("separates direct and Cloudflare Jev accounting scopes", () => {
	const direct = ProviderExecutionIdentitySchema.parse(jevDirect);
	const cloudflare = ProviderExecutionIdentitySchema.parse({
		...jevDirect,
		requestModel: "typesafe/jev",
		transportKind: "cloudflare-ai-https",
		gatewayAccountId: "account",
		gatewayId: "gateway",
		providerOrigin: null,
	});
	expect(providerDeploymentScope(direct)).not.toBe(
		providerDeploymentScope(cloudflare),
	);
});
it.each([
	{ gatewayId: "fake" },
	{ providerOrigin: "https://evil.test" },
	{ requestModel: "jev-latest" },
	{ apiKind: "workers-ai-chat" },
	{ provider: "workers-ai" },
])("rejects contradictory direct Jev identity %j", (change) => {
	expect(
		ProviderExecutionIdentitySchema.safeParse({ ...jevDirect, ...change })
			.success,
	).toBe(false);
});
it("retains mandatory Cloudflare identity for existing providers", () => {
	expect(
		ProviderExecutionIdentitySchema.safeParse({
			...azureExecutionIdentity(input),
			gatewayId: null,
		}).success,
	).toBe(false);
	expect(
		ProviderExecutionIdentitySchema.safeParse({
			...jevDirect,
			requestModel: "typesafe/jev",
			transportKind: "cloudflare-ai-https",
			providerOrigin: null,
		}).success,
	).toBe(false);
});

it("records Auto Router as an adaptive gateway execution, not a concrete provider", () => {
	const identity = ProviderExecutionIdentitySchema.parse({
		provider: "workers-ai",
		requestModel: "cloudflare/auto",
		transportKind: "gateway-https",
		apiKind: "workers-ai-chat",
		gatewayAccountId: "account",
		gatewayId: "gateway",
		providerOrigin: null,
		providerResource: null,
		deployment: null,
	});
	expect(providerDeploymentScope(identity)).toBe(
		JSON.stringify([
			"cloudflare-auto",
			"account",
			"gateway",
			"cloudflare/auto",
		]),
	);
	expect(
		ProviderExecutionIdentitySchema.safeParse({
			...identity,
			deployment: "openai/gpt-5.6-luna",
		}).success,
	).toBe(false);
});

import {
	ProviderExecutionOriginSchema,
	ProviderExecutionPolicySchema,
} from "./provider-execution";
const owner = { orgId: "org", tediId: "tedi", objectId: "a".repeat(64) };
const rootClaim = {
	owner,
	runId: "run",
	sessionKey: "session",
	principalId: "principal",
	inputHash: "b".repeat(64),
	requestHash: "c".repeat(64),
	generation: 2,
};
const root = {
	owner,
	objectName: "root",
	className: "AgentTediDO" as const,
	path: [],
	generation: 2,
	accepted: rootClaim,
};
const selected = {
	owner,
	className: "AgentTediDO" as const,
	identityName: "root",
	facetName: null,
	path: [],
	generation: 2,
	accepted: rootClaim,
};
const acceptedOrigin = {
	kind: "accepted_native" as const,
	root,
	selected,
	operation: null,
	configurationHash: null,
};
it("keeps original accepted root and leaf operation claims distinct", () => {
	expect(ProviderExecutionOriginSchema.parse(acceptedOrigin)).toEqual(
		acceptedOrigin,
	);
	const leafOwner = { ...owner, objectId: "d".repeat(64) };
	const leaf = {
		...selected,
		owner: leafOwner,
		className: "ConversationFacet" as const,
		facetName: "chat",
		identityName: "native-chat",
		path: [{ className: "ConversationFacet", name: "chat" }],
		generation: 1,
		accepted: {
			...rootClaim,
			owner: leafOwner,
			runId: "submission",
			generation: 1,
		},
	};
	expect(
		ProviderExecutionOriginSchema.safeParse({
			...acceptedOrigin,
			selected: leaf,
			operation: {
				parentRunId: "run",
				operationId: "submission",
				sessionKey: "session",
				parentGeneration: 2,
			},
		}).success,
	).toBe(true);
	expect(
		ProviderExecutionOriginSchema.safeParse({
			...acceptedOrigin,
			selected: leaf,
		}).success,
	).toBe(false);
});
it.each([
	{ ...acceptedOrigin, root: { ...root, generation: 3 } },
	{
		...acceptedOrigin,
		selected: { ...selected, owner: { ...owner, tediId: "other" } },
	},
	{ ...acceptedOrigin, selected: { ...selected, identityName: "other" } },
	{
		...acceptedOrigin,
		selected: {
			...selected,
			path: [{ className: "AgentTediDO", name: "root" }],
		},
	},
	{
		...acceptedOrigin,
		operation: {
			parentRunId: "run",
			operationId: "run",
			sessionKey: "session",
			parentGeneration: 2,
		},
	},
	{ ...acceptedOrigin, kind: "kernel" },
	{ ...acceptedOrigin, authority: "finance" },
])("rejects inconsistent or extra asserted identity %#", (o) =>
	expect(ProviderExecutionOriginSchema.safeParse(o).success).toBe(false),
);
it("unselected custody cannot carry a fabricated accepted claim", () => {
	const { accepted: _r, ...r } = root;
	const { accepted: _s, ...s } = selected;
	const o = {
		kind: "unselected_native",
		root: { ...r, generation: 0 },
		selected: { ...s, generation: 0 },
		configurationHash: "f".repeat(64),
	};
	expect(ProviderExecutionOriginSchema.safeParse(o).success).toBe(true);
	expect(
		ProviderExecutionOriginSchema.safeParse({ ...o, accepted: rootClaim })
			.success,
	).toBe(false);
	expect(
		ProviderExecutionOriginSchema.safeParse({
			...o,
			selected: { ...o.selected, accepted: rootClaim },
		}).success,
	).toBe(false);
	expect(
		ProviderExecutionOriginSchema.safeParse({
			...o,
			root: { ...o.root, generation: 1 },
		}).success,
	).toBe(false);
});
it("finite policy fixes a bounded original window without authority labels", () => {
	const p = {
		authorizationId: crypto.randomUUID(),
		authorizationRequestHash: "a".repeat(64),
		revision: 1,
		exposureSetHash: "b".repeat(64),
		authorizedAt: "2026-10-05T00:00:00.000Z",
		sendBefore: "2026-10-05T00:00:30.000Z",
	};
	expect(ProviderExecutionPolicySchema.safeParse(p).success).toBe(true);
	expect(
		ProviderExecutionPolicySchema.safeParse({
			...p,
			sendBefore: p.authorizedAt,
		}).success,
	).toBe(false);
	expect(
		ProviderExecutionPolicySchema.safeParse({ ...p, allow: true }).success,
	).toBe(false);
});

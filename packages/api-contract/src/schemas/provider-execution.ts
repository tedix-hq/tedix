import * as z from "zod";

const identifier = z.string().min(1).max(300);
/** Exact deployment-owned native Auto Router candidate header representation. */
const autoEntry = z
	.string()
	.regex(/^[a-zA-Z0-9@][a-zA-Z0-9@/_.:-]*$/)
	.refine((value) => value === value.trim());
export const AutoRoutingIdentitySchema = z
	.strictObject({
		version: z.literal(1),
		modality: z.enum(["text", "image"]),
		mode: z.enum(["unrestricted", "restricted"]),
		allowedProviders: z.array(autoEntry).min(1).nullable(),
		allowedModels: z.array(autoEntry).min(1).nullable(),
	})
	.superRefine((r, ctx) => {
		if (
			(r.mode === "unrestricted") !==
				(r.allowedProviders === null && r.allowedModels === null) ||
			(r.modality === "image" && r.allowedModels === null)
		)
			ctx.addIssue({
				code: "custom",
				message: "Inconsistent Auto routing restrictions",
			});
	});
export type AutoRoutingIdentity = z.infer<typeof AutoRoutingIdentitySchema>;
/** Parse, clone and freeze every nested routing member before any admission await. */
export function freezeProviderExecutionIdentity(
	value: unknown,
): Readonly<ProviderExecutionIdentity> {
	const identity = ProviderExecutionIdentitySchema.parse(value);
	if (identity.autoRouting) {
		Object.freeze(identity.autoRouting.allowedProviders);
		Object.freeze(identity.autoRouting.allowedModels);
		Object.freeze(identity.autoRouting);
	}
	return Object.freeze(identity);
}
export const ProviderExecutionIdentitySchema = z
	.strictObject({
		provider: z.enum(["azure-openai", "workers-ai", "typesafe"]),
		requestModel: identifier,
		autoRouting: AutoRoutingIdentitySchema.optional(),
		gatewayAccountId: identifier
			.nullable()
			.describe(
				"Null for direct TypeSafe requests, which do not pass through a Cloudflare account.",
			),
		gatewayId: identifier
			.nullable()
			.describe(
				"Null for direct TypeSafe requests, which do not pass through an AI Gateway.",
			),
		transportKind: z.enum([
			"gateway-https",
			"gateway-binding",
			"workers-ai-binding",
			"cloudflare-ai-https",
			"direct-https",
		]),
		apiKind: z.enum([
			"azure-chat",
			"azure-responses",
			"workers-ai-chat",
			"typesafe-systemone",
		]),
		providerResource: identifier
			.nullable()
			.describe("Null for Workers AI; Azure records the native resource name."),
		providerOrigin: z
			.url()
			.nullable()
			.describe(
				"Null for Workers AI; Azure records the exact provider resource origin.",
			),
		deployment: identifier
			.nullable()
			.describe(
				"Null for Workers AI; Azure requires the exact deployment used by the request.",
			),
	})
	.superRefine((value, ctx) => {
		if (
			value.autoRouting &&
			!(
				value.provider === "workers-ai" &&
				value.requestModel === "cloudflare/auto" &&
				value.transportKind === "gateway-https"
			)
		)
			ctx.addIssue({
				code: "custom",
				message: "Auto routing belongs only to native Auto identity",
			});
		if (
			value.transportKind !== "direct-https" &&
			(!value.gatewayAccountId || !value.gatewayId)
		)
			ctx.addIssue({
				code: "custom",
				message: "Cloudflare execution requires account and gateway",
			});
		if (value.provider === "azure-openai") {
			if (
				!value.providerResource ||
				!/^[a-z0-9-]+$/i.test(value.providerResource) ||
				value.providerOrigin !==
					`https://${value.providerResource.toLowerCase()}.openai.azure.com` ||
				value.deployment !== value.requestModel ||
				!(["azure-chat", "azure-responses"] as string[]).includes(
					value.apiKind,
				) ||
				!(["gateway-https", "gateway-binding"] as string[]).includes(
					value.transportKind,
				)
			)
				ctx.addIssue({
					code: "custom",
					message: "Azure execution requires its exact resource and deployment",
				});
		} else if (value.provider === "typesafe") {
			const direct = value.transportKind === "direct-https";
			if (
				value.requestModel !== (direct ? "jev-1.13.0" : "typesafe/jev") ||
				value.apiKind !== "typesafe-systemone" ||
				(!direct && value.transportKind !== "cloudflare-ai-https") ||
				value.providerResource !== null ||
				value.deployment !== null ||
				(direct
					? value.providerOrigin !== "https://api.typesafe.ai" ||
						value.gatewayAccountId !== null ||
						value.gatewayId !== null
					: value.providerOrigin !== null)
			)
				ctx.addIssue({
					code: "custom",
					message: "TypeSafe execution requires its exact native endpoint",
				});
		} else if (
			value.providerResource !== null ||
			value.providerOrigin !== null ||
			value.deployment !== null ||
			value.apiKind !== "workers-ai-chat" ||
			!(
				["gateway-https", "gateway-binding", "workers-ai-binding"] as string[]
			).includes(value.transportKind) ||
			(!value.requestModel.startsWith("@cf/") &&
				!(
					value.requestModel === "cloudflare/auto" &&
					value.transportKind === "gateway-https"
				))
		)
			ctx.addIssue({
				code: "custom",
				message: "Workers AI execution requires its exact account and model",
			});
	});
export type ProviderExecutionIdentity = z.infer<
	typeof ProviderExecutionIdentitySchema
>;

export function providerDeploymentScope(
	identity: ProviderExecutionIdentity,
): string {
	return identity.provider === "azure-openai"
		? JSON.stringify([
				identity.provider,
				identity.gatewayAccountId,
				identity.gatewayId,
				identity.providerOrigin,
				identity.deployment,
			])
		: identity.provider === "typesafe"
			? JSON.stringify([
					identity.provider,
					identity.transportKind,
					identity.providerOrigin,
					identity.gatewayAccountId,
					identity.gatewayId,
				])
			: identity.requestModel === "cloudflare/auto"
				? JSON.stringify([
						"cloudflare-auto",
						identity.gatewayAccountId,
						identity.gatewayId,
						identity.requestModel,
					])
				: JSON.stringify([identity.provider, identity.gatewayAccountId]);
}

/** Parse the final trusted transport URL, never gateway custom metadata. */
export function azureExecutionIdentity(input: {
	url: string;
	model: string;
	accountId: string | undefined;
	gatewayId: string | undefined;
	transportKind: "binding" | "https";
}): ProviderExecutionIdentity {
	const url = new URL(input.url);
	input = {
		...input,
		accountId: input.accountId?.trim(),
		gatewayId: input.gatewayId?.trim(),
	};
	const prefix =
		input.transportKind === "binding"
			? `/ai-gateway/gateways/${input.gatewayId}/azure-openai/`
			: `/v1/${input.accountId}/${input.gatewayId}/azure-openai/`;
	if (
		url.hostname !==
			(input.transportKind === "binding"
				? "workers-binding.ai"
				: "gateway.ai.cloudflare.com") ||
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		!url.pathname.startsWith(prefix)
	)
		throw new Error("Invalid Azure execution URL");
	const tail = url.pathname.slice(prefix.length);
	const chat = /^([a-z0-9-]+)\/([^/%]+)\/chat\/completions$/i.exec(tail);
	const responses = /^([a-z0-9-]+)\/openai\/v1\/responses$/i.exec(tail);
	const resource = (chat?.[1] ?? responses?.[1])?.toLowerCase();
	if (
		!resource ||
		(chat && chat[2] !== input.model) ||
		(responses && url.search)
	)
		throw new Error("Azure execution model/path mismatch");
	return ProviderExecutionIdentitySchema.parse({
		provider: "azure-openai",
		requestModel: input.model,
		gatewayAccountId: input.accountId,
		gatewayId: input.gatewayId,
		transportKind:
			input.transportKind === "binding" ? "gateway-binding" : "gateway-https",
		apiKind: chat ? "azure-chat" : "azure-responses",
		providerResource: resource,
		providerOrigin: `https://${resource}.openai.azure.com`,
		deployment: input.model,
	});
}

/** Extract only the identity columns from a persisted execution row. */
export function readProviderExecutionIdentity(
	value: Omit<
		ProviderExecutionIdentity,
		| "providerResource"
		| "providerOrigin"
		| "deployment"
		| "gatewayAccountId"
		| "gatewayId"
	> &
		Partial<
			Pick<
				ProviderExecutionIdentity,
				| "providerResource"
				| "providerOrigin"
				| "deployment"
				| "gatewayAccountId"
				| "gatewayId"
			>
		> & { policy?: unknown; policyHash?: string | null },
): ProviderExecutionIdentity {
	const {
		provider,
		requestModel,
		gatewayAccountId,
		gatewayId,
		transportKind,
		apiKind,
		providerResource,
		providerOrigin,
		deployment,
	} = value;
	if (
		value.requestModel === "cloudflare/auto" &&
		value.policy == null &&
		!value.autoRouting
	)
		throw Error("Auto identity requires original routing evidence");
	const persisted =
		value.requestModel === "cloudflare/auto" && value.policy != null
			? AutoRouterExecutionPolicySchema.parse(value.policy)
			: null;
	if (persisted && !/^[a-f0-9]{64}$/.test(value.policyHash ?? ""))
		throw Error("Auto routing requires persisted policy hash");
	return ProviderExecutionIdentitySchema.parse({
		provider,
		requestModel,
		...(persisted
			? { autoRouting: persisted.routing }
			: value.autoRouting
				? { autoRouting: value.autoRouting }
				: {}),
		gatewayAccountId: gatewayAccountId ?? null,
		gatewayId: gatewayId ?? null,
		transportKind,
		apiKind,
		providerResource: providerResource ?? null,
		providerOrigin: providerOrigin ?? null,
		deployment: deployment ?? null,
	});
}

// Private asserted provenance. Parsing does not attest a Durable Object or authorize spending.
const originHash = z.string().regex(/^[a-f0-9]{64}$/);
const physicalId = originHash;
const nativeOwner = z.strictObject({
	orgId: identifier,
	tediId: identifier,
	objectId: physicalId,
});
const nativePath = z.array(
	z.strictObject({ className: identifier, name: z.string().min(1).max(512) }),
);
const acceptedNativeTurn = z.strictObject({
	owner: nativeOwner,
	runId: identifier,
	sessionKey: z.string().min(1).max(512),
	principalId: identifier,
	inputHash: originHash,
	requestHash: originHash,
	generation: z.number().int().positive().safe(),
});
const nativeRoot = z.strictObject({
	owner: nativeOwner,
	objectName: z.string().min(1).max(512),
	className: z.literal("AgentTediDO"),
	path: nativePath.length(0),
	generation: z.number().int().nonnegative().safe(),
});
const nativeSelected = z.strictObject({
	owner: nativeOwner,
	className: z.enum([
		"AgentTediDO",
		"ConversationFacet",
		"JudgeSessionFacet",
		"SynthesisSessionFacet",
	]),
	identityName: z.string().min(1).max(1024),
	facetName: z.string().min(1).max(512).nullable(),
	path: nativePath,
	generation: z.number().int().nonnegative().safe(),
});
const facetOperation = z.strictObject({
	parentRunId: identifier,
	operationId: identifier,
	sessionKey: z.string().min(1).max(512),
	parentGeneration: z.number().int().positive().safe(),
});
export const ProviderExecutionOriginSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("accepted_native"),
			root: nativeRoot.extend({ accepted: acceptedNativeTurn }),
			selected: nativeSelected.extend({ accepted: acceptedNativeTurn }),
			operation: facetOperation.nullable(),
			configurationHash: originHash.nullable(),
		}),
		z.strictObject({
			kind: z.literal("unselected_native"),
			root: nativeRoot.extend({ generation: z.literal(0) }),
			selected: nativeSelected.extend({ generation: z.literal(0) }),
			configurationHash: originHash,
		}),
	])
	.superRefine((o, ctx) => {
		const sameOwner = (
			a: z.infer<typeof nativeOwner>,
			b: z.infer<typeof nativeOwner>,
		) =>
			a.orgId === b.orgId && a.tediId === b.tediId && a.objectId === b.objectId;
		const rootOnly = o.selected.className === "AgentTediDO";
		let valid =
			o.root.owner.orgId === o.selected.owner.orgId &&
			o.root.owner.tediId === o.selected.owner.tediId;
		if (rootOnly)
			valid &&=
				sameOwner(o.root.owner, o.selected.owner) &&
				o.selected.path.length === 0 &&
				o.selected.facetName === null &&
				o.selected.identityName === o.root.objectName &&
				o.selected.generation === o.root.generation;
		else
			valid &&=
				o.selected.owner.objectId !== o.root.owner.objectId &&
				o.selected.path.length > 0 &&
				o.selected.path.at(-1)?.className === o.selected.className &&
				o.selected.path.at(-1)?.name === o.selected.facetName;
		if (o.kind === "accepted_native") {
			valid &&=
				sameOwner(o.root.owner, o.root.accepted.owner) &&
				sameOwner(o.selected.owner, o.selected.accepted.owner) &&
				o.root.generation === o.root.accepted.generation &&
				o.selected.generation === o.selected.accepted.generation;
			if (rootOnly)
				valid &&=
					o.operation === null &&
					JSON.stringify(o.root.accepted) ===
						JSON.stringify(o.selected.accepted);
			else
				valid &&=
					o.operation !== null &&
					o.operation.parentRunId === o.root.accepted.runId &&
					o.operation.parentGeneration === o.root.generation &&
					o.operation.operationId === o.selected.accepted.runId &&
					o.operation.sessionKey === o.selected.accepted.sessionKey &&
					o.selected.accepted.sessionKey === o.root.accepted.sessionKey &&
					o.selected.accepted.principalId === o.root.accepted.principalId;
		}
		if (!valid)
			ctx.addIssue({
				code: "custom",
				message: "Inconsistent asserted native custody",
			});
	});
export type ProviderExecutionOrigin = z.infer<
	typeof ProviderExecutionOriginSchema
>;

/** Immutable finite selection and its original window; no renewal on a retry. */
export const FiniteProviderExecutionPolicySchema = z
	.strictObject({
		authorizationId: z.uuid(),
		authorizationRequestHash: originHash,
		revision: z.number().int().positive().safe(),
		exposureSetHash: originHash,
		authorizedAt: z.iso.datetime(),
		sendBefore: z.iso.datetime(),
	})
	.refine((p) => Date.parse(p.sendBefore) > Date.parse(p.authorizedAt), {
		message: "Invalid original send window",
	});
export const AutoRouterExecutionPolicySchema = z.strictObject({
	kind: z.literal("auto_router_v1"),
	routing: AutoRoutingIdentitySchema,
	finite: FiniteProviderExecutionPolicySchema.nullable(),
});
export const ProviderExecutionPolicySchema = z.union([
	FiniteProviderExecutionPolicySchema,
	AutoRouterExecutionPolicySchema,
]);
export type ProviderExecutionPolicy = z.infer<
	typeof ProviderExecutionPolicySchema
>;

// Runtime catalog: regenerate with bun scripts/mcp/generate-aggregate-tedi-catalog.ts.
// Projecting the contracts here exhausted memory when imported after app aggregation.
import { builtinToolPolicyMetadata } from "@tedix/api-contract/utils/approval-policy";
import type { ToolJsonSchema } from "@tedix/api-contract/schemas/tools";
import {
	type AggregateTediEntry,
	MAIN_SESSION_KEY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";
import type { AppTool } from "./server-context";
import snapshot from "./aggregate-tedi-catalog.generated.json";

const {
	full: FULL_TEDI_TOOLS,
	collaboration: COLLABORATION_TOOLS,
	skills: SKILL_WORKFLOW_TOOLS,
	outputs: SKILL_WORKFLOW_OUTPUT_SCHEMAS,
} = snapshot as unknown as {
	full: TediToolSpec[];
	collaboration: TediToolSpec[];
	skills: TediToolSpec[];
	outputs: Record<string, ToolJsonSchema | null>;
};

export type { AggregateTediEntry } from "./aggregate-tedis-shared";

export function buildTediCodeInvocation(
	remoteName: string,
	params: Record<string, unknown>,
): string {
	const accessor = /^[A-Za-z_$][\w$]*$/.test(remoteName)
		? `.${remoteName}`
		: `[${JSON.stringify(remoteName)}]`;
	const invocationParams =
		remoteName === "run_tedi_turn" && !params.client_request_id
			? { ...params, client_request_id: crypto.randomUUID() }
			: params;
	return `async () => await codemode${accessor}(${JSON.stringify(invocationParams)})`;
}

export function getTediMcpServerUrl(
	entry: AggregateTediEntry,
	env: Pick<CloudflareEnv, "MCP_URL">,
): string {
	if (entry.serverUrl) return entry.serverUrl;

	const mcpHost = new URL(env.MCP_URL).hostname;
	const tediHost = mcpHost.startsWith("mcp.")
		? `tedi.${mcpHost.slice("mcp.".length)}`
		: mcpHost.replace(".mcp.", ".tedi.");
	return `https://${entry.slug}.${tediHost}/mcp`;
}

export function sanitizeTediNamespace(entry: AggregateTediEntry): string {
	return (entry.namespace ?? entry.slug).replace(/[^a-zA-Z0-9_]/g, "_");
}

function buildTediTool(
	entry: AggregateTediEntry,
	spec: TediToolSpec,
	env: CloudflareEnv,
): AppTool {
	const namespace = sanitizeTediNamespace(entry);
	const riskPolicy = builtinToolPolicyMetadata(spec.remoteName);
	const isRpcProxy = typeof spec.rpcEndpoint === "string";
	const directMcpTool = spec.directMcpTool === true;
	const allowExplicitTediId =
		spec.allowExplicitTediId ?? !spec.rpcEndpoint?.startsWith("skills/");
	const tediIdDefaultParams =
		isRpcProxy && entry.tediId && spec.tediIdDefaultParams
			? Object.fromEntries(
					spec.tediIdDefaultParams.map((paramName) => [
						paramName,
						entry.tediId,
					]),
				)
			: {};
	const staticParams = {
		...spec.staticParams,
		...(spec.includeTediIdParam === false
			? { __tedixOmitAggregateTediId: true }
			: {}),
		...tediIdDefaultParams,
		...(spec.name === "ask"
			? { session_key: entry.sessionKey ?? MAIN_SESSION_KEY }
			: {}),
		...(isRpcProxy &&
		entry.tediId &&
		spec.includeTediIdParam !== false &&
		!spec.credentialDerivedTediActor
			? { tediId: entry.tediId }
			: {}),
	};
	const widgetRoute = spec.layoutId ? `/r/${spec.layoutId}` : null;
	const outputTemplate = widgetRoute
		? `ui://widgets/apps-sdk/tedix-unified/${widgetRoute.replace(/^\//, "")}.html`
		: null;

	return {
		id: `tedi:${entry.slug}:${spec.name}`,
		toolId: `${namespace}__${spec.name}`,
		title: `${namespace}__${spec.name}`,
		description: spec.description,
		toolTypeId: isRpcProxy ? "rpc" : "mcp",
		inputSchema: spec.inputSchema,
		outputSchema:
			(isRpcProxy && spec.rpcEndpoint
				? SKILL_WORKFLOW_OUTPUT_SCHEMAS[spec.rpcEndpoint]
				: null) ?? null,
		config: isRpcProxy
			? {
					transport: "rpc",
					...(spec.rpcEndpoint ? { endpoint: spec.rpcEndpoint } : {}),
					// Per-spec timeout was only honored on the mcp transport; heavy
					// rpc tools (workflow-improvement proposals validate a full
					// workflow source) died at the silent 15s default.
					...(spec.timeout ? { timeout: spec.timeout } : {}),
					method: "GET",
					allowExplicitTediId,
					allowExplicitAppId: true,
					...(spec.paramMap ? { paramMap: spec.paramMap } : {}),
					...(spec.tediBooleanParams
						? { tediBooleanParams: spec.tediBooleanParams }
						: {}),
					...(spec.voiceSubject ? { _voiceSubject: spec.voiceSubject } : {}),
					...(Object.keys(staticParams).length > 0 ? { staticParams } : {}),
					...(spec.layoutId ? { layoutId: spec.layoutId } : {}),
					...(spec.layoutSpec ? { layoutSpec: spec.layoutSpec } : {}),
					_aggregateNamespace: namespace,
					_aggregateTediSlug: entry.slug,
					...(entry.tediId ? { _aggregateTediId: entry.tediId } : {}),
					...(spec.credentialDerivedTediActor
						? { _credentialDerivedTediActor: true }
						: {}),
					...(entry.organizationId
						? { _aggregateTediOrgId: entry.organizationId }
						: {}),
					_aggregateTediRemoteName: spec.remoteName,
				}
			: {
					transport: "mcp",
					mcpServerUrl: getTediMcpServerUrl(entry, env),
					mcpToolName: directMcpTool ? spec.remoteName : "code",
					...(directMcpTool ? {} : { responsePath: "result" }),
					...(spec.timeout ? { timeout: spec.timeout } : {}),
					...(spec.paramMap ? { paramMap: spec.paramMap } : {}),
					...(Object.keys(staticParams).length > 0 ? { staticParams } : {}),
					...(spec.layoutId ? { layoutId: spec.layoutId } : {}),
					...(spec.layoutSpec ? { layoutSpec: spec.layoutSpec } : {}),
					_aggregateNamespace: namespace,
					_aggregateTediSlug: entry.slug,
					...(entry.tediId ? { _aggregateTediId: entry.tediId } : {}),
					...(entry.organizationId
						? { _aggregateTediOrgId: entry.organizationId }
						: {}),
					...(directMcpTool
						? {}
						: { _aggregateTediRemoteName: spec.remoteName }),
				},
		annotations: spec.annotations ?? null,
		meta: {
			source: "aggregateTedis",
			tediSlug: entry.slug,
			...(riskPolicy ? { "com.tedix/policy": riskPolicy } : {}),
		},
		icons: null,
		executionTaskSupport: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate,
		widgetKey: spec.layoutSpec ? "render" : null,
		widgetRoute,
		widgetAccessible: spec.layoutSpec ? true : null,
		visibility: null,
		widgetDescription: spec.widgetDescription ?? null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: "json-schema-2020-12",
		schemaSource: "mcp",
		schemaSourceRef: spec.remoteName,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
	};
}

export function buildAggregateTediTools(
	entries: AggregateTediEntry[],
	env: CloudflareEnv,
): AppTool[] {
	return entries.flatMap((entry) => {
		const runtimeKind = entry.runtimeKind ?? "agent";
		const specs = entry.selfSkillsOnly
			? SKILL_WORKFLOW_TOOLS
			: entry.surface === "collaboration"
				? COLLABORATION_TOOLS
				: FULL_TEDI_TOOLS;
		const runtimeSpecs = specs.filter(
			(spec) => !spec.runtimeKinds || spec.runtimeKinds.includes(runtimeKind),
		);
		// Managed RPC tools that normally inject the selected tedi must fail
		// closed when D1 hydration did not resolve that identity. Direct calls to
		// the tedi's own MCP host remain correctly identity-bound by that host;
		// explicitly org-scoped RPC specs opt out with includeTediIdParam=false.
		const identitySafeSpecs = entry.tediId
			? runtimeSpecs
			: runtimeSpecs.filter(
					(spec) =>
						(!spec.rpcEndpoint ||
							(spec.includeTediIdParam === false &&
								spec.requiresHydratedTedi !== true)) &&
						!spec.credentialDerivedTediActor,
				);
		return identitySafeSpecs.map((spec) => buildTediTool(entry, spec, env));
	});
}

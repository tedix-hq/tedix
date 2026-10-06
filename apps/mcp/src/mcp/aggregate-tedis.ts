// Aggregate tedi tool catalog. The per-domain spec modules live in the
// sibling aggregate-tedis-*.ts files (mechanical split along domain seams);
// this module remains the stable aggregation point and public surface:
// entry/spec assembly, buildTediTool, and buildAggregateTediTools.
import { BROWSER_TOOLS } from "./aggregate-tedis-browser";
import { CAPABILITY_MAP_TOOLS } from "./aggregate-tedis-capabilities";
import {
	COLLABORATION_TOOLS,
	CONVERSATIONS_LIST_SCHEMA,
	MESSAGING_TOOLS,
} from "./aggregate-tedis-collaboration";
import { EMAIL_TOOLS } from "./aggregate-tedis-email";
import { GOVERNANCE_TOOLS } from "./aggregate-tedis-governance";
import { HARNESS_TOOLS } from "./aggregate-tedis-harness";
import { KERNEL_RUNTIME_TOOLS } from "./aggregate-tedis-kernel-runtime";
import { MEMORY_TOOLS, RATIONALE_MUSCLE_TOOLS } from "./aggregate-tedis-memory";
import { PAYMENT_TOOLS } from "./aggregate-tedis-payments";
import { PROJECT_TOOLS } from "./aggregate-tedis-projects";
import { ROLE_TEMPLATE_TOOLS } from "./aggregate-tedis-role-templates";
import {
	type AggregateTediEntry,
	MAIN_SESSION_KEY,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";
import {
	SKILL_WORKFLOW_OUTPUT_SCHEMAS,
	SKILL_WORKFLOW_TOOLS,
} from "./aggregate-tedis-skill-workflows";
import { WORK_ITEM_TOOLS } from "./aggregate-tedis-work-items";
import { WORKSPACE_TOOLS } from "./aggregate-tedis-workspace";
import { COMPUTER_TOOLS } from "./aggregate-tedis-computer";
import type { AppTool } from "./server-context";

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

const FULL_TEDI_TOOLS: TediToolSpec[] = [
	{
		name: "conversations_list",
		remoteName: "conversations_list",
		description:
			"List cognitive-runtime conversations, including channel-backed and internal agent sessions.",
		inputSchema: CONVERSATIONS_LIST_SCHEMA,
		annotations: READ_ONLY,
	},
	{
		name: "conversation_get",
		remoteName: "conversation_get",
		description: "Get one cognitive-runtime conversation by session key.",
		inputSchema: {
			type: "object",
			properties: { session_key: { type: "string" } },
			required: ["session_key"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	...COLLABORATION_TOOLS.filter(
		(tool) => !["ask", "conversations_list"].includes(tool.name),
	),
	...SKILL_WORKFLOW_TOOLS,
	...CAPABILITY_MAP_TOOLS,
	...GOVERNANCE_TOOLS,
	...PROJECT_TOOLS,
	...ROLE_TEMPLATE_TOOLS,
	...WORKSPACE_TOOLS,
	...MESSAGING_TOOLS,
	...COMPUTER_TOOLS,
	...MEMORY_TOOLS,
	...BROWSER_TOOLS,
	...EMAIL_TOOLS,
	...WORK_ITEM_TOOLS,
	...HARNESS_TOOLS,
	...KERNEL_RUNTIME_TOOLS,
	...RATIONALE_MUSCLE_TOOLS,
	...PAYMENT_TOOLS,
];

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
		meta: { source: "aggregateTedis", tediSlug: entry.slug },
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
		const specs =
			entry.surface === "collaboration" ? COLLABORATION_TOOLS : FULL_TEDI_TOOLS;
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

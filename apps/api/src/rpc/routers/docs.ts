import { implement } from "@orpc/server";
import {
	type DocsBuild,
	type DocsChange,
	type DocsRelease,
	type DocsSite,
	docsContract,
} from "@tedix/api-contract/contracts/docs";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	FORWARDED_AUTH_HEADER,
	withAuth,
} from "../orpc";
import {
	FirstPartyMcpError,
	type FirstPartyMcpFetch,
	requestFirstPartyMcp,
} from "../../lib/first-party-mcp";

const docsOs = implement(docsContract).$context<BaseContext>();
const authedOs = docsOs.use(withAuth);
const docsReadOs = authedOs.use(
	withAuthorization("apps:read", "mcp:content.read"),
);
const docsWriteOs = authedOs.use(
	withAuthorization("apps:update", "mcp:content.write"),
);
const docsAdminOs = authedOs.use(
	withAuthorization("settings:manage", "mcp:content.admin"),
);

const DOCS_POLICY_PRESETS = [
	{
		id: "viewer" as const,
		label: "Viewer",
		description:
			"Read sites, source files, builds, releases, and proposal diffs.",
		scopes: ["mcp:content.read"] as string[],
	},
	{
		id: "editor" as const,
		label: "Editor",
		description:
			"Propose changes and build private previews, without publishing.",
		scopes: ["mcp:content.read", "mcp:content.write"] as string[],
	},
	{
		id: "publisher" as const,
		label: "Publisher",
		description:
			"Commit validated proposals and publish or roll back releases.",
		scopes: [
			"mcp:content.read",
			"mcp:content.write",
			"mcp:content.admin",
		] as string[],
	},
] as const;

type DocsToolResult = {
	isError?: boolean;
	content?: Array<{ type?: string; text?: string }>;
	structuredContent?: unknown;
};

export type DocsDelegatedScope =
	| "mcp:content.read"
	| "mcp:content.write"
	| "mcp:content.admin";

export const DOCS_DELEGATED_SCOPE_BY_TOOL = {
	list_docs_sites: "mcp:content.read",
	get_docs_site: "mcp:content.read",
	list_docs_builds: "mcp:content.read",
	get_docs_preview_link: "mcp:content.read",
	list_docs_changes: "mcp:content.read",
	list_docs_releases: "mcp:content.read",
	get_docs_diff: "mcp:content.read",
	start_docs_build: "mcp:content.write",
	validate_docs_change: "mcp:content.write",
	upsert_docs_site: "mcp:content.admin",
	import_docs_repository: "mcp:content.admin",
	commit_docs_change: "mcp:content.admin",
	publish_docs_build: "mcp:content.admin",
	rollback_docs_build: "mcp:content.admin",
} as const satisfies Record<string, DocsDelegatedScope>;

/**
 * Actor types apps/api can vouch for from its OWN authenticated context. A
 * `service` actor is the unattributed fallback, so it may not stand in for a
 * caller identity.
 */
const ATTRIBUTABLE_ACTOR_TYPES = new Set(["user", "tedi", "external_agent"]);

export function isAttributableDocsActor(
	actorHeaders: Record<string, string>,
): boolean {
	return ATTRIBUTABLE_ACTOR_TYPES.has(actorHeaders["X-Tedix-Actor-Type"] ?? "");
}

export function docsActorHeaders(context: BaseContext): Record<string, string> {
	if (context.externalAgentPrincipalId) {
		return {
			"X-Tedix-Actor-Type": "external_agent",
			"X-Tedix-Actor-Id": context.externalAgentPrincipalId,
			...(context.externalAgentSessionId
				? {
						"X-Tedix-Agent-Session-Id": context.externalAgentSessionId,
					}
				: {}),
		};
	}
	if (context.tediId) {
		return {
			"X-Tedix-Actor-Type": "tedi",
			"X-Tedix-Actor-Id": context.tediId,
		};
	}
	if (context.user?.sub) {
		return {
			"X-Tedix-Actor-Type": "user",
			"X-Tedix-Actor-Id": context.user.sub,
		};
	}
	return {
		"X-Tedix-Actor-Type": "service",
		"X-Tedix-Actor-Id": context.serviceAccount?.clientId ?? "tedix-api",
	};
}

/**
 * One Docs Studio `tools/call` over the Docs binding, through the SDK v2 client
 * pinned to 2026-07-28 (Docs is first-party and modern-only: no probe). Returns
 * the tool's `structuredContent`; a transport failure is a bad gateway (401
 * stays unauthorized), and a tool error is the caller's bad request.
 */
export async function callDocsMcpTool(input: {
	fetch: FirstPartyMcpFetch;
	organizationSlug: string;
	headers: Record<string, string>;
	name: keyof typeof DOCS_DELEGATED_SCOPE_BY_TOOL;
	args: Record<string, unknown>;
}): Promise<unknown> {
	let result: DocsToolResult;
	try {
		result = (await requestFirstPartyMcp(
			{
				url: `https://docs.internal/mcp?org=${encodeURIComponent(input.organizationSlug)}`,
				fetch: input.fetch,
				headers: input.headers,
				clientName: "tedix-api-docs-client",
			},
			"tools/call",
			{ name: input.name, arguments: input.args },
		)) as DocsToolResult;
	} catch (error) {
		if (!(error instanceof FirstPartyMcpError)) throw error;
		if (error.kind === "http") {
			throw createError(
				error.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.BAD_GATEWAY,
				`Docs control request failed: ${error.body ?? error.message}`,
			);
		}
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			error.rpcError?.message ?? error.message,
		);
	}
	if (result.isError) {
		const message = result.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text)
			.filter(Boolean)
			.join("\n");
		throw createError(
			ErrorCodes.BAD_REQUEST,
			message || "Docs operation was rejected",
		);
	}
	return result.structuredContent;
}

/**
 * The caller's own bearer token, read from the slot the calling surface uses.
 *
 * apps/mcp's service-binding path never sets `Authorization` — the binding is
 * itself the trust anchor — and forwards the authenticated caller's JWT as
 * `X-Forwarded-Authorization` alongside `X-Tedix-Caller-Type: mcp-edge-user`
 * (apps/mcp/src/mcp/handler.ts). Direct Tedix OS callers send
 * their JWT as `Authorization`. Reading only the latter made every `docs.*`
 * MCP tool fail closed.
 *
 * The forwarded header wins on purpose: on the upstream-MCP transport
 * `Authorization` carries `PLATFORM_SERVICE_TOKEN`, which must never reach
 * Docs Studio as a caller identity. This is the same split apps/cms and
 * apps/docs already implement.
 */
export function resolveDocsCallerAuthorization(
	headers: Headers,
): string | null {
	const forwarded =
		headers.get(FORWARDED_AUTH_HEADER) ??
		headers.get(FORWARDED_AUTH_HEADER.toLowerCase());
	const candidate = forwarded ?? headers.get("Authorization");
	return candidate?.startsWith("Bearer ") ? candidate : null;
}

async function docsTool<T>(
	context: BaseContext,
	name: keyof typeof DOCS_DELEGATED_SCOPE_BY_TOOL,
	args: Record<string, unknown>,
): Promise<T> {
	const organizationId = context.organizationId;
	if (!organizationId) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Organization context is required",
		);
	}
	const organization = await getOrganizationById(context.db, organizationId);
	if (!organization) {
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	}
	const binding = (context.env as CloudflareEnv & { DOCS?: Fetcher }).DOCS;
	if (!binding || !context.env.PLATFORM_SERVICE_TOKEN) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Docs control service is unavailable",
		);
	}
	const forwardedAuthorization = resolveDocsCallerAuthorization(
		context.headers,
	);
	const actorHeaders = docsActorHeaders(context);
	// A tedi reaches apps/api over the service binding with X-Tedix-Tedi-Id and
	// D1-resolved scopes and NO bearer at all — its Descope roles never live in
	// its JWT — so demanding a token here locked tedis out of Docs entirely.
	// The procedure already ran withAuth + withAuthorization, so what remains to
	// check is that the caller is attributable downstream.
	if (!forwardedAuthorization && !isAttributableDocsActor(actorHeaders)) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			`Docs Studio requires an attributable caller: a bearer token in Authorization or ${FORWARDED_AUTH_HEADER}, or a resolved user, tedi, or external-agent identity`,
		);
	}
	return (await callDocsMcpTool({
		fetch: (url, init) => binding.fetch(url, init),
		organizationSlug: organization.slug,
		name,
		args,
		headers: {
			Authorization: `Bearer ${context.env.PLATFORM_SERVICE_TOKEN}`,
			"X-Tedix-Connection-Label": organization.slug,
			"X-Tedix-Delegated-Scope": DOCS_DELEGATED_SCOPE_BY_TOOL[name],
			...(forwardedAuthorization
				? { [FORWARDED_AUTH_HEADER]: forwardedAuthorization }
				: {}),
			...actorHeaders,
		},
	})) as T;
}

const listSites = docsReadOs.listSites.handler(async ({ context }) => {
	const result = await docsTool<{ sites: DocsSite[] }>(
		context,
		"list_docs_sites",
		{},
	);
	return { ...result, policyPresets: [...DOCS_POLICY_PRESETS] };
});

const getWorkspace = docsReadOs.getWorkspace.handler(
	async ({ input, context }) => {
		const [siteResult, buildsResult, changesResult, releasesResult] =
			await Promise.all([
				docsTool<{ site: DocsSite }>(context, "get_docs_site", input),
				docsTool<{ builds: DocsBuild[] }>(context, "list_docs_builds", input),
				docsTool<{ changes: DocsChange[] }>(
					context,
					"list_docs_changes",
					input,
				),
				docsTool<{ releases: DocsRelease[] }>(
					context,
					"list_docs_releases",
					input,
				),
			]);
		return {
			site: siteResult.site,
			builds: buildsResult.builds,
			changes: changesResult.changes,
			releases: releasesResult.releases,
		};
	},
);

const upsertSite = docsAdminOs.upsertSite.handler(({ input, context }) =>
	docsTool(context, "upsert_docs_site", input),
);
const importRepository = docsAdminOs.importRepository.handler(
	({ input, context }) => docsTool(context, "import_docs_repository", input),
);
const startBuild = docsWriteOs.startBuild.handler(({ input, context }) =>
	docsTool(context, "start_docs_build", input),
);
const getPreviewLink = docsReadOs.getPreviewLink.handler(({ input, context }) =>
	docsTool(context, "get_docs_preview_link", input),
);
const publishBuild = docsAdminOs.publishBuild.handler(({ input, context }) =>
	docsTool(context, "publish_docs_build", input),
);
const rollbackBuild = docsAdminOs.rollbackBuild.handler(({ input, context }) =>
	docsTool(context, "rollback_docs_build", input),
);
const getDiff = docsReadOs.getDiff.handler(({ input, context }) =>
	docsTool(context, "get_docs_diff", input),
);
const validateChange = docsWriteOs.validateChange.handler(
	({ input, context }) => docsTool(context, "validate_docs_change", input),
);
const commitChange = docsAdminOs.commitChange.handler(({ input, context }) =>
	docsTool(context, "commit_docs_change", input),
);

export const docsContractRouter = docsOs.router({
	listSites,
	getWorkspace,
	upsertSite,
	importRepository,
	startBuild,
	getPreviewLink,
	publishBuild,
	rollbackBuild,
	getDiff,
	validateChange,
	commitChange,
});

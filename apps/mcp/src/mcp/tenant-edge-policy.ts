import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sanitizeToolName } from "@cloudflare/codemode";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import type { MultiOrgMcpSelection } from "../auth-helpers";
import type { ResolvedApp } from "../resolution";
import type { ServerContext } from "./server-context";
import { extractCallerIdentity } from "./server-factory";
import {
	resolveTenantProfileCandidate,
	tenantProfileCandidateIsBounded,
} from "./tenant-profile-candidate";
import { resolveHumanPolicyReplay } from "./tenant-human-replay";

/** Admission only; the tool callback and provider transport recheck every gate. */
export async function isTenantPolicyEdgeAdmission(input: {
	request: Request;
	app: ResolvedApp;
	env: CloudflareEnv;
	multiOrgSelection?: MultiOrgMcpSelection | null;
	toolScopes?: Record<string, string[]>;
}): Promise<boolean> {
	try {
		const body = await input.request.clone().json();
		if (
			!isRecord(body) ||
			body.method !== "tools/call" ||
			!isRecord(body.params) ||
			typeof body.params.name !== "string" ||
			!isRecord(body.params.arguments)
		)
			return false;
		const params = body.params;
		const tool = input.app.tools.find((row) => row.toolId === params.name);
		if (!tool || tool.config?.transport !== "mcp") return false;
		const rawName = tool.toolId.includes("__")
			? tool.toolId.split("__").slice(1).join("__")
			: tool.toolId;
		const namespace = resolveMcpToolNamespace(
			tool,
			input.app.metadata?.mcpConfig?.codeModeNamespaces as
				| Record<string, string>
				| undefined,
		);
		if (
			[tool.toolId, rawName, sanitizeToolName(rawName), namespace, "*"].some(
				(key) => input.toolScopes && Object.hasOwn(input.toolScopes, key),
			)
		)
			return false;
		const callerIdentity = extractCallerIdentity(input.request);
		if (!callerIdentity) return false;
		if (input.multiOrgSelection && callerIdentity.authType === "oauth")
			callerIdentity.verifiedMultiOrgOrganizations =
				input.multiOrgSelection.organizations;
		const agent = {
			env: input.env,
			appId: input.app.app.id,
			appSlug: input.app.app.slug,
			app: input.app.app,
			appMetadata: input.app.metadata,
			callerIdentity,
		} as unknown as ServerContext;
		const candidate =
			(await resolveTenantProfileCandidate(
				agent,
				tool,
				params.arguments as Record<string, unknown>,
			)) ??
			(await resolveHumanPolicyReplay(
				agent,
				tool,
				params.arguments as Record<string, unknown>,
				isRecord(params._meta)
					? params._meta["com.tedix/approvalRequestId"]
					: undefined,
			));
		return (
			!!candidate &&
			candidate.effect.disposition !== "deny" &&
			tenantProfileCandidateIsBounded(candidate, tool)
		);
	} catch {
		return false;
	}
}

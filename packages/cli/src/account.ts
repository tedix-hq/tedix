import { normalizeCodeResult } from "./code-result";
import type { TedixHomeClient } from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export interface AvailableWorkspace {
	org: string;
	slug: string;
	name: string;
	/**
	 * The org's unified MCP gateway URL, resolved SERVER-side by
	 * organizations/listAllMine. Null when the org has no provisioned aggregator
	 * gateway. The gateway slug is NOT derivable from the org slug (e.g. org
	 * "acme-s-workspace-1a2b3c" → gateway "acme-unified"), so it is never
	 * guessed client-side.
	 */
	gatewayUrl: string | null;
	/**
	 * The org's Descope tenant id (e.g. "org_tedix", or an auto-generated key
	 * like "T3DUKiQ8…"). This is the ONLY reliable key for matching a stored CLI
	 * login to an org: gateway URL is ambiguous because the shared tedix-unified
	 * gateway backs both the "tedix" org and any bare-login "default" slot, so a
	 * URL match falsely reports a wrong-tenant login as "logged in". Null for
	 * orgs with no Descope tenant (e.g. non-operational duplicates).
	 */
	descopeTenantId: string | null;
}

/**
 * Read organizations/listAllMine through the selected MCP gateway's Code Mode
 * surface. The gateway forwards the human OAuth identity to apps/api; the CLI
 * never opens a second product transport.
 */
export async function listAvailableWorkspaces(opts: {
	client: Pick<TedixHomeClient, "runCode">;
}): Promise<AvailableWorkspace[]> {
	const discovery = normalizeCodeResult(
		await opts.client.runCode(
			'async () => await discover.search({ query: "list_all_mine", limit: 3, includeParameters: true })',
		),
	).value;
	const tool = Array.isArray(discovery)
		? discovery.find(
				(entry) =>
					isRecord(entry) &&
					entry.authorized === true &&
					entry.tool === "list_all_mine" &&
					isRecord(entry.schemaFreshness) &&
					entry.schemaFreshness.sourceRef === "organizations/listAllMine" &&
					typeof entry.callable === "string" &&
					/^[A-Za-z_$][\w$]*\.list_all_mine$/.test(entry.callable),
			)
		: undefined;
	if (!tool) {
		throw new Error(
			"Your gateway does not expose an authorized organization list. Check your connection permissions and selected organizations with tedix auth status.",
		);
	}
	const raw = await opts.client.runCode(
		`async () => { const r = await ${tool.callable}({limit:100}); if (r && typeof r === "object" && (r.ok === false || (typeof r.status === "number" && r.status >= 400))) return r; const rows = Array.isArray(r) ? r : Array.isArray(r && r.data) ? r.data : []; return rows.map(x => ({ organizationId: x.organizationId, organizationSlug: x.organizationSlug, organizationName: x.organizationName, mcpGatewayUrl: x.mcpGatewayUrl, descopeTenantId: x.descopeTenantId })); }`,
	);
	const result = normalizeCodeResult(raw).value;
	if (
		isRecord(result) &&
		(result.ok === false ||
			(typeof result.code === "string" &&
				typeof result.status === "number" &&
				result.status >= 400))
	) {
		throw new Error(
			String(
				result.error ?? result.message ?? "gateway rejected org discovery",
			),
		);
	}
	const rows = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.data)
			? result.data
			: [];

	const workspaces: AvailableWorkspace[] = [];
	for (const entry of rows) {
		if (!isRecord(entry)) continue;
		const org = entry.organizationId;
		const slug = entry.organizationSlug;
		const name = entry.organizationName;
		if (typeof org !== "string" || typeof slug !== "string") {
			console.error(
				"[account] skipping listAllMine row with missing org id/slug:",
				entry,
			);
			continue;
		}
		workspaces.push({
			org,
			slug,
			name: typeof name === "string" && name.length > 0 ? name : slug,
			gatewayUrl:
				typeof entry.mcpGatewayUrl === "string" ? entry.mcpGatewayUrl : null,
			descopeTenantId:
				typeof entry.descopeTenantId === "string"
					? entry.descopeTenantId
					: null,
		});
	}
	return workspaces;
}

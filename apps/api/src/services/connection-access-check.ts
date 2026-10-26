import type { ConnectionAccessCheck } from "@tedix/api-contract/schemas/connections";
import type { OrganizationMetadata } from "@tedix/db/schema/organizations";
import { listConnectionInstances } from "@tedix/db/queries/connection-instances";
import { getConnectionProviderByDescopeAppId } from "@tedix/db/queries/connection-providers";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { guardedFetch } from "@tedix/ssrf-guard";
import type { BaseContext } from "../rpc/orpc";

/**
 * Reads through an organization account first run audit-only: a would-deny is
 * recorded on the receipt and the read is still served. From this instant on,
 * a would-deny refuses the read.
 */
export const OWN_ACCESS_ENFORCED_FROM = "2026-11-02T00:00:00.000Z";

/** Provider categories whose resources carry per-person sharing. */
const DOCUMENT_STORE_CATEGORIES = new Set(["productivity", "storage"]);

/**
 * "Check each person's access" for one organization account: the org admin
 * override when one exists, otherwise on for document stores (a document
 * category, or a provider with a per-person access probe) and off for
 * service accounts.
 */
export function resolveConnectionAccessCheck(
	metadata: OrganizationMetadata | null | undefined,
	connectionInstanceId: string,
	provider: { appId: string; category?: string },
): ConnectionAccessCheck {
	const override = metadata?.connectionAccessChecks?.find(
		(entry) => entry.connectionInstanceId === connectionInstanceId,
	);
	if (override)
		return {
			checkEachPersonsAccess: override.checkEachPersonsAccess,
			source: "admin",
		};
	return {
		checkEachPersonsAccess:
			DOCUMENT_STORE_CATEGORIES.has(provider.category ?? "") ||
			Object.hasOwn(ACCESS_PROBES, provider.appId),
		source: "default",
	};
}

export type OwnAccessOutcome =
	/** The read ran on the reader's own account. */
	| "own_account"
	/** The organization account has the check off. */
	| "not_checked"
	/** The reader's own account opened the resource. */
	| "verified"
	/** The reader has an account, but this provider has no access probe. */
	| "unverified"
	| "no_linked_account"
	| "no_access"
	| "check_failed";

const DENYING_OUTCOMES = new Set<OwnAccessOutcome>([
	"no_linked_account",
	"no_access",
	"check_failed",
]);

export function ownAccessDenies(outcome: OwnAccessOutcome): boolean {
	return DENYING_OUTCOMES.has(outcome);
}

/** One provider read with the reader's own token; true when the resource opened. */
type AccessProbe = (
	token: string,
	resource: OsWorkspaceResourceRow,
	fetchFn?: typeof fetch,
) => Promise<boolean>;

const NOTION_ID =
	/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Notion: pages and databases are both blocks; 403/404 means not shared with this person. */
const notionProbe: AccessProbe = async (token, resource, fetchFn) => {
	if (!NOTION_ID.test(resource.providerResourceId))
		throw new Error("Unrecognised Notion resource id");
	const response = await guardedFetch(
		`https://api.notion.com/v1/blocks/${resource.providerResourceId}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": "2022-06-28",
			},
			signal: AbortSignal.timeout(5_000),
		},
		fetchFn ? { fetchFn } : undefined,
	);
	if (response.ok) return true;
	if (response.status === 403 || response.status === 404) return false;
	throw new Error(`Notion access probe returned ${response.status}`);
};

const ACCESS_PROBES: Record<string, AccessProbe> = { notion: notionProbe };

/**
 * Whether the reader could open the slot's resource with their own linked
 * account. Never throws: a failed probe is reported, and callers fail closed.
 */
export async function checkOwnProviderAccess(
	context: BaseContext,
	actingUserId: string,
	resource: OsWorkspaceResourceRow,
	options: { fetchFn?: typeof fetch } = {},
): Promise<OwnAccessOutcome> {
	const own = (
		await listConnectionInstances(context.db, { userId: actingUserId })
	).find(
		(row) =>
			row.providerId === resource.providerId &&
			row.tokenIds.length > 0 &&
			row.tokenSub,
	);
	if (!own) return "no_linked_account";
	const probe = ACCESS_PROBES[resource.providerId];
	if (!probe) return "unverified";
	try {
		const { fetchNamedConnection } =
			await import("../rpc/routers/connections/policy-resolution");
		const token = await fetchNamedConnection(
			context,
			{ userId: actingUserId },
			resource.providerId,
			own.id,
		);
		if (!token?.accessToken) return "check_failed";
		return (await probe(token.accessToken, resource, options.fetchFn))
			? "verified"
			: "no_access";
	} catch {
		return "check_failed";
	}
}

export interface OwnAccessEvaluation {
	/** null on a personal slot: the read already runs on the reader's own account. */
	setting: ConnectionAccessCheck | null;
	outcome: OwnAccessOutcome;
	mode: "audit" | "enforce";
	wouldDeny: boolean;
	denied: boolean;
	/** True when the read may return data the reader could not open themselves. */
	containsRestrictedData: boolean;
}

/** Evaluates "check each person's access" for one app read of a workspace slot. */
export async function evaluateOwnAccess(
	context: BaseContext,
	actingUserId: string,
	resource: OsWorkspaceResourceRow,
	options: { now?: Date; fetchFn?: typeof fetch } = {},
): Promise<OwnAccessEvaluation> {
	const mode =
		(options.now ?? new Date()).getTime() >=
		Date.parse(OWN_ACCESS_ENFORCED_FROM)
			? "enforce"
			: "audit";
	if (resource.connectionScope === "user")
		return {
			setting: null,
			outcome: "own_account",
			mode,
			wouldDeny: false,
			denied: false,
			containsRestrictedData: false,
		};
	const [organization, provider] = await Promise.all([
		getOrganizationById(context.db, resource.organizationId),
		getConnectionProviderByDescopeAppId(context.db, resource.providerId),
	]);
	const setting = resolveConnectionAccessCheck(
		organization?.metadata,
		resource.connectionInstanceId ?? "",
		{ appId: resource.providerId, category: provider?.category },
	);
	const outcome = setting.checkEachPersonsAccess
		? await checkOwnProviderAccess(context, actingUserId, resource, options)
		: "not_checked";
	const wouldDeny = ownAccessDenies(outcome);
	return {
		setting,
		outcome,
		mode,
		wouldDeny,
		denied: wouldDeny && mode === "enforce",
		containsRestrictedData: outcome !== "verified",
	};
}

/** What the reader is told when an enforced check refuses the read. */
export function ownAccessRefusal(
	providerId: string,
	outcome: OwnAccessOutcome,
): string {
	if (outcome === "no_linked_account")
		return `This organization checks each person's ${providerId} access. Link your own ${providerId} account to read this.`;
	if (outcome === "no_access")
		return `Your own ${providerId} account cannot open this resource, so it is not shown through the organization account.`;
	return `Your own ${providerId} access could not be confirmed, so the read was refused. Try again, or reconnect your ${providerId} account.`;
}

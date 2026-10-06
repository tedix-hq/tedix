/**
 * MCP tool-approval grant query helpers.
 *
 * Isolated MCP-gateway grant layer for `apps/mcp/src/mcp/governance.ts`'s
 * `requireDestructiveToolApproval`. See `../schema/mcp-governance.ts` for the
 * scope model and the explicit "do not converge with the kernel write-proposal
 * approval system" note.
 */

import { OwnedChannelAuthorizationReceiptSchema } from "@tedix/api-contract/schemas/mcp-governance";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type McpToolApprovalGrant,
	type McpToolApprovalGrantKind,
	mcpToolApprovalGrants,
} from "../schema/mcp-governance";
import { projects } from "../schema/projects";
import { tedis } from "../schema/tedis";
import { workAttempts, workEvents, workItems } from "../schema/work-items";

export type { McpToolApprovalGrant, McpToolApprovalGrantKind };

/** Trim + lowercase a scope segment. Keeps matching case-insensitive and
 * whitespace-insensitive without ever doing substring/prefix comparison. */
function normalizeScopeSegment(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Canonical scope-pattern string for a grant row: `{appSlug}:{toolId}`.
 * `toolId` may be the literal `"*"` to mean "every tool in this app", and
 * `appSlug` may be `"*"` (with `toolId` also `"*"`) to mean "every tool in
 * every app". Any other combination of wildcards is rejected — half-open
 * patterns like `"*:list_skills"` (any app, one tool) are deliberately not
 * supported: they would let a grant issued under app A silently satisfy a
 * same-named tool in app B.
 */
export function buildGrantScope(appSlug: string, toolId: string): string {
	const app = normalizeScopeSegment(appSlug);
	const tool = normalizeScopeSegment(toolId);
	if (app === "*" && tool !== "*") {
		throw new Error(
			`Invalid MCP grant scope: "*:${toolId}" is not supported — a global app wildcard must also wildcard the tool ("*:*").`,
		);
	}
	return `${app}:${tool}`;
}

/**
 * The finite, exact-match candidate scopes that could authorize a call to
 * `toolId` in `appSlug`, ordered most-specific first. `findActiveGrant` probes
 * these in order and returns on the first hit — an exact-tool grant always
 * wins over a same-app wildcard, which always wins over the global wildcard.
 *
 * This is EXACT STRING EQUALITY against a small fixed list, never a
 * LIKE/prefix/substring match — a grant for `"appA:tool_x"` can never match a
 * call to `"appA:tool_xy"` or `"appB:tool_x"`.
 */
export function buildGrantScopeCandidates(
	appSlug: string,
	toolId: string,
): string[] {
	return [
		buildGrantScope(appSlug, toolId),
		buildGrantScope(appSlug, "*"),
		buildGrantScope("*", "*"),
	];
}

export interface CreateGrantArgs {
	id?: string;
	organizationId: string;
	subjectId: string;
	/** App slug the scope is issued under. Use `"*"` only with `toolId: "*"`. */
	appSlug: string;
	/** Concrete tool id, or `"*"` for every tool in `appSlug`. */
	toolId: string;
	grantKind: McpToolApprovalGrantKind;
	/** ISO timestamp. Omit/null for a grant that never expires. */
	expiresAt?: string | null;
	reason?: string | null;
}

/**
 * Create a durable grant. This is the ONLY way a grant comes into existence —
 * no code path in this batch issues one automatically. Intended for a future
 * operator-facing RPC/UI (deliberately not built in this batch); today it is
 * callable only from trusted server-side/ops contexts.
 */
export async function createGrant(
	db: DbClient,
	args: CreateGrantArgs,
): Promise<McpToolApprovalGrant> {
	const id = args.id ?? crypto.randomUUID();
	const scope = buildGrantScope(args.appSlug, args.toolId);
	const [created] = await db
		.insert(mcpToolApprovalGrants)
		.values({
			id,
			organizationId: args.organizationId,
			subjectId: args.subjectId,
			toolId: scope,
			grantKind: args.grantKind,
			expiresAt: args.expiresAt ?? null,
			reason: args.reason ?? null,
		})
		.returning();
	if (!created) {
		throw new Error(`Failed to create MCP tool approval grant: ${id}`);
	}
	return created;
}

export interface FindActiveGrantArgs {
	organizationId: string;
	subjectId: string;
	appSlug: string;
	toolId: string;
	grantKind: McpToolApprovalGrantKind;
	/** ISO timestamp to evaluate expiry against. Defaults to `new Date().toISOString()`. */
	nowIso?: string;
}

/**
 * Find an active grant covering `(appSlug, toolId)` for `subjectId` within
 * `organizationId`, of the exact requested `grantKind`. "Active" means:
 *   - org-scoped to `organizationId` (never crosses orgs)
 *   - subject-scoped to `subjectId` (never crosses identities)
 *   - scope-matched via `buildGrantScopeCandidates` exact equality (never a
 *     prefix/substring match)
 *   - `consumedAt IS NULL` (a consumed "once" grant is never active again)
 *   - `expiresAt IS NULL OR expiresAt > now` (an expired grant is never active)
 *
 * Read-only — does not consume anything. Callers that intend to honor an
 * "once" grant MUST separately call `consumeGrant` and only treat the call as
 * approved if that CAS succeeds.
 */
export async function findActiveGrant(
	db: DbClient,
	args: FindActiveGrantArgs,
): Promise<McpToolApprovalGrant | undefined> {
	const now = args.nowIso ?? new Date().toISOString();
	const candidates = buildGrantScopeCandidates(args.appSlug, args.toolId);
	for (const scope of candidates) {
		const rows = await db
			.select()
			.from(mcpToolApprovalGrants)
			.where(
				and(
					eq(mcpToolApprovalGrants.organizationId, args.organizationId),
					eq(mcpToolApprovalGrants.subjectId, args.subjectId),
					eq(mcpToolApprovalGrants.toolId, scope),
					eq(mcpToolApprovalGrants.grantKind, args.grantKind),
					isNull(mcpToolApprovalGrants.consumedAt),
					or(
						isNull(mcpToolApprovalGrants.expiresAt),
						gt(mcpToolApprovalGrants.expiresAt, now),
					),
				),
			)
			.orderBy(mcpToolApprovalGrants.createdAt)
			.limit(1);
		if (rows[0]) return rows[0];
	}
	return undefined;
}

export interface ConsumeGrantArgs {
	grantId: string;
	organizationId: string;
	consumedAtIso?: string;
}

export interface ConsumeGrantResult {
	/** True only for the caller whose CAS actually stamped consumedAt. */
	consumed: boolean;
	grant: McpToolApprovalGrant | undefined;
}

/**
 * Consume a "once" grant exactly once, even under a race: the UPDATE is
 * guarded by `consumed_at IS NULL`, so of any number of concurrent callers
 * racing the same grant row, exactly one UPDATE matches a row and returns it —
 * every other caller's UPDATE matches zero rows and gets `consumed: false`.
 * This is a conditional CAS write, not a read-then-write — SQLite/D1 execute
 * the UPDATE atomically so there is no read-modify-write window to lose.
 *
 * A failed consume (`consumed: false`) must NEVER be treated as approval by
 * callers — it means either the grant was already used, or never existed /
 * belongs to a different org.
 */
export async function consumeGrant(
	db: DbClient,
	args: ConsumeGrantArgs,
): Promise<ConsumeGrantResult> {
	const consumedAt = args.consumedAtIso ?? new Date().toISOString();
	const [updated] = await db
		.update(mcpToolApprovalGrants)
		.set({ consumedAt })
		.where(
			and(
				eq(mcpToolApprovalGrants.id, args.grantId),
				eq(mcpToolApprovalGrants.organizationId, args.organizationId),
				isNull(mcpToolApprovalGrants.consumedAt),
			),
		)
		.returning();
	return { consumed: Boolean(updated), grant: updated };
}

export interface ResolveToolApprovalGrantArgs {
	organizationId: string;
	subjectId: string;
	appSlug: string;
	toolId: string;
	grantKind: McpToolApprovalGrantKind;
	nowIso?: string;
}

export interface ResolveToolApprovalGrantResult {
	approved: boolean;
	grantId: string | null;
}

/**
 * Atomic find-and-(if "once")-consume in one call — the single operation the
 * apps/api service-binding endpoint exposes to apps/mcp so the governance gate
 * resolves in exactly one round trip.
 *
 * - `grantKind: "always"` — an active grant approves every call; never
 *   consumed.
 * - `grantKind: "once"` — an active grant must win its consume CAS to
 *   approve. If the CAS is lost (raced by a concurrent call), this returns
 *   `approved: false` — it does NOT fall back to searching for another
 *   matching grant. The caller (governance.ts) falls through to the normal
 *   elicitation path on `approved: false`.
 */
export async function resolveToolApprovalGrant(
	db: DbClient,
	args: ResolveToolApprovalGrantArgs,
): Promise<ResolveToolApprovalGrantResult> {
	const grant = await findActiveGrant(db, args);
	if (!grant) return { approved: false, grantId: null };

	if (grant.grantKind === "always") {
		return { approved: true, grantId: grant.id };
	}

	// "once" — must win the consume CAS to count as approved.
	const { consumed } = await consumeGrant(db, {
		grantId: grant.id,
		organizationId: args.organizationId,
		consumedAtIso: args.nowIso,
	});
	return consumed
		? { approved: true, grantId: grant.id }
		: { approved: false, grantId: null };
}

export const OWNED_CHANNEL_AUTHORIZATION_EVENT =
	"owned_channel_authorization" as const;
export const OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT =
	"owned_channel_authorization_revoked" as const;
export const OWNED_CHANNEL_AUTHORIZATION_PROOF_KEY =
	"ownedChannelAuthorizationProof" as const;
export const OWNED_CHANNEL_GATEWAY_APP_SLUG = "tedix-unified" as const;
export const OWNED_CHANNEL_PUBLISH_TOOL_ID =
	"cms_landing__content_publish" as const;
/**
 * Exact routes to the current Tedix blog publisher. The edge also gates every
 * content_publish on the tedix connection, including retired cms_tedix, but
 * the resolver authorizes only this allowlist. The aggregate namespace uses an
 * underscore, as emitted by the live gateway.
 */
const OWNED_CHANNEL_PUBLISH_ROUTES: ReadonlyArray<
	readonly [appSlug: string, toolId: string]
> = [
	[OWNED_CHANNEL_GATEWAY_APP_SLUG, OWNED_CHANNEL_PUBLISH_TOOL_ID],
	// Direct landing-tenant CMS routes, also gated by the MCP edge.
	["cms-tedix-landing", "cms__content_publish"],
	["cms-tedix-landing", "content_publish"],
];

/** Does this (appSlug, toolId) pair address the Tedix owned-channel publisher? */
function isOwnedChannelPublishRoute(appSlug: string, toolId: string): boolean {
	const app = normalizeScopeSegment(appSlug);
	const tool = normalizeScopeSegment(toolId);
	return OWNED_CHANNEL_PUBLISH_ROUTES.some(
		([routeApp, routeTool]) =>
			normalizeScopeSegment(routeApp) === app &&
			normalizeScopeSegment(routeTool) === tool,
	);
}
export const OWNED_CHANNEL_MAX_AUTHORIZATION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A non-human authorizer gets a shorter ceiling than a human one. The bound an
 * agent can grant itself should expire well inside the window a human would
 * notice, so an unattended loop that goes wrong stops on its own rather than
 * running for a month.
 */
export const OWNED_CHANNEL_AGENT_MAX_AUTHORIZATION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Principal types that may author an owned-channel authorization receipt.
 * `user` is the human owner/admin path. `external_agent` and `tedi` are the
 * accountable non-human authorizers — each carries a verified identity and an
 * attempt on the item it authorizes. Service principals are deliberately
 * absent: they carry no accountable identity to attribute a publish to.
 *
 * Separation of duties is enforced separately, at the point of use: a `tedi`
 * receipt authored by the tedi that is publishing does not count.
 */
export const OWNED_CHANNEL_AUTHORIZATION_AUTHOR_TYPES = [
	"user",
	"external_agent",
	"tedi",
] as const;

export interface ResolveWorkItemAuthorizationArgs {
	organizationId: string;
	subjectId: string;
	appSlug: string;
	toolId: string;
	args: Record<string, unknown>;
	/** API-internal HMAC key; never accepted from the MCP wire contract. */
	authorizationSigningSecret: string;
	/** Test/diagnostic clock override. The service endpoint always uses now. */
	nowIso?: string;
}

export interface OwnedChannelAuthorizationProofInput {
	commentId: string;
	workItemId: string;
	organizationId: string;
	authorId: string;
	eventType:
		| typeof OWNED_CHANNEL_AUTHORIZATION_EVENT
		| typeof OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT;
	body: string;
	createdAt: string;
}

function authorizationProofPayload(
	input: OwnedChannelAuthorizationProofInput,
): string {
	return JSON.stringify([
		"tedix-owned-channel-authorization-v1",
		input.commentId,
		input.workItemId,
		input.organizationId,
		input.authorId,
		input.eventType,
		input.body,
		input.createdAt,
	]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
	try {
		const padded = value
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(Math.ceil(value.length / 4) * 4, "=");
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function recordFromDbJson(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

async function authorizationProofKey(
	secret: string,
	usage: Array<"sign" | "verify">,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usage,
	);
}

export async function signOwnedChannelAuthorizationProof(
	secret: string,
	input: OwnedChannelAuthorizationProofInput,
): Promise<string> {
	if (!secret)
		throw new Error("Owned-channel authorization signing key missing");
	const signature = await crypto.subtle.sign(
		"HMAC",
		await authorizationProofKey(secret, ["sign"]),
		new TextEncoder().encode(authorizationProofPayload(input)),
	);
	return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyOwnedChannelAuthorizationProof(
	secret: string,
	input: OwnedChannelAuthorizationProofInput,
	metadata: Record<string, unknown> | null,
): Promise<boolean> {
	const proof = metadata?.[OWNED_CHANNEL_AUTHORIZATION_PROOF_KEY];
	if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
	const record = proof as Record<string, unknown>;
	if (record.version !== 1 || typeof record.signature !== "string")
		return false;
	const signature = base64UrlToBytes(record.signature);
	if (!signature || !secret) return false;
	const signatureBytes = new Uint8Array(signature.byteLength);
	signatureBytes.set(signature);
	return crypto.subtle.verify(
		"HMAC",
		await authorizationProofKey(secret, ["verify"]),
		signatureBytes.buffer,
		new TextEncoder().encode(authorizationProofPayload(input)),
	);
}

export interface ResolveWorkItemAuthorizationResult {
	approved: boolean;
	reason: string;
	workItemId: string | null;
	authorizationScopeWorkItemId: string | null;
	authorizationCommentId: string | null;
	attemptId: string | null;
	campaignKey: string | null;
	validUntil: string | null;
}

function denied(
	reason: string,
	workItemId: string | null = null,
): ResolveWorkItemAuthorizationResult {
	return {
		approved: false,
		reason,
		workItemId,
		authorizationScopeWorkItemId: null,
		authorizationCommentId: null,
		attemptId: null,
		campaignKey: null,
		validUntil: null,
	};
}

/**
 * Resolve the bounded owned-channel lane at the actual mutation boundary.
 *
 * This is deliberately not a durable wildcard grant. Every publish call must
 * prove all of the following from canonical D1 state in one service-bound
 * resolution: one active CMO/tedi claim, leaf grain, a server-attributed
 * authorization comment on that leaf or a verified ancestor campaign item,
 * strict receipt scope, and current bounded validity.
 *
 * SEPARATION OF DUTIES is the load-bearing property here, NOT the humanness of
 * the authorizer. The rule used to be "owner/admin user principal only", which
 * bought separation for free — a tedi could never be a user — at the cost of
 * making unattended publishing impossible. An accountable non-human principal
 * (a verified external agent, or a DIFFERENT tedi) now qualifies, and the
 * property is enforced directly instead of inferred: an authorization authored
 * by the very tedi that is publishing is refused below. The reviewer
 * authorizes, the author publishes, and neither can do both.
 *
 * A service principal still cannot author a receipt — it carries no
 * accountable identity — and widening `author_type` does not weaken integrity:
 * the HMAC binds commentId + workItemId + orgId + authorId + eventType + body
 * + createdAt, so a forged row is unusable without the signing key. The
 * `author_type` filter is an authority rule, not the integrity mechanism.
 */
export async function resolveWorkItemAuthorization(
	db: DbClient,
	input: ResolveWorkItemAuthorizationArgs,
): Promise<ResolveWorkItemAuthorizationResult> {
	if (!isOwnedChannelPublishRoute(input.appSlug, input.toolId)) {
		return denied("tool_scope_mismatch");
	}
	if (
		input.args.collection !== "posts" ||
		typeof input.args.id !== "string" ||
		input.args.id.trim().length === 0 ||
		input.args.publishedAt !== undefined ||
		(input.args.locale !== undefined && input.args.locale !== "en")
	) {
		return denied("argument_scope_mismatch");
	}
	const nowIso = input.nowIso ?? new Date().toISOString();

	const activeAttempts = await db
		.select({
			workItemId: sql<string>`${workItems.id}`.as("authorization_work_item_id"),
			parentWorkItemId: workItems.parentWorkItemId,
			projectId: workItems.projectId,
			workKind: workItems.workKind,
			status: workItems.disposition,
			metadata: workItems.metadata,
			attemptId: sql<string>`${workAttempts.id}`.as("authorization_attempt_id"),
		})
		.from(workItems)
		.innerJoin(projects, eq(workItems.projectId, projects.id))
		.innerJoin(
			tedis,
			and(
				eq(workItems.accountableOwnerId, tedis.id),
				eq(tedis.organizationId, input.organizationId),
				eq(tedis.slug, "cmo"),
				eq(tedis.status, "active"),
			),
		)
		.innerJoin(
			workAttempts,
			and(
				eq(workAttempts.workItemId, workItems.id),
				eq(workAttempts.orgId, input.organizationId),
				eq(workAttempts.executorType, "tedi"),
				eq(workAttempts.executorId, input.subjectId),
				inArray(workAttempts.runtimeState, [
					"queued",
					"running",
					"waiting",
					"retrying",
				]),
				or(isNull(workAttempts.expiresAt), gt(workAttempts.expiresAt, nowIso)),
			),
		)
		.where(
			and(
				eq(workItems.orgId, input.organizationId),
				eq(projects.orgId, input.organizationId),
				eq(projects.status, "active"),
				eq(workItems.accountableOwnerId, input.subjectId),
				eq(workItems.accountableOwnerType, "tedi"),
				eq(workItems.accountableOwnerId, input.subjectId),
				eq(workItems.disposition, "accepted"),
				sql`NOT EXISTS (SELECT 1 FROM work_items child WHERE child.org_id = ${input.organizationId} AND child.parent_work_item_id = ${workItems.id})`,
			),
		)
		.orderBy(desc(workItems.acceptedAt))
		.limit(2);

	if (activeAttempts.length === 0) return denied("no_active_tedi_leaf");
	if (activeAttempts.length !== 1) return denied("ambiguous_active_tedi_leaf");
	const activeAttempt = activeAttempts[0];
	if (!activeAttempt) return denied("no_active_tedi_leaf");
	const workItemId = activeAttempt.workItemId;
	if (!workItemId) return denied("no_active_tedi_leaf");
	const attemptId = activeAttempt.attemptId;
	if (!attemptId) return denied("no_active_tedi_attempt", workItemId);

	const authorizationScopes = [
		{
			id: workItemId,
			workKind: activeAttempt.workKind,
			status: activeAttempt.status,
			projectId: activeAttempt.projectId,
			metadata: activeAttempt.metadata,
		},
	];
	let parentWorkItemId = activeAttempt.parentWorkItemId ?? null;
	for (let depth = 0; parentWorkItemId && depth < 5; depth += 1) {
		const [parent] = await db
			.select({
				id: workItems.id,
				parentWorkItemId: workItems.parentWorkItemId,
				workKind: workItems.workKind,
				status: workItems.disposition,
				projectId: workItems.projectId,
				metadata: workItems.metadata,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, input.organizationId),
					eq(workItems.id, parentWorkItemId),
				),
			)
			.limit(1);
		if (
			!parent ||
			authorizationScopes.some((scope) => scope.id === parent.id) ||
			parent.projectId !== activeAttempt.projectId
		) {
			break;
		}
		authorizationScopes.push(parent);
		parentWorkItemId = parent.parentWorkItemId;
	}
	const authorizationScopeIds = authorizationScopes.map((scope) => scope.id);

	const comments = await db
		.select({
			id: workEvents.id,
			workItemId: workEvents.workItemId,
			authorType: workEvents.actorType,
			authorId: workEvents.actorId,
			body: sql<string>`COALESCE(json_extract(${workEvents.payload}, '$.body'), '')`,
			createdAt: workEvents.occurredAt,
			eventType: workEvents.eventType,
			metadata: workEvents.payload,
		})
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, input.organizationId),
				// bound-params: scope walk above caps the chain at 1 leaf + 5 parents
				inArray(workEvents.workItemId, authorizationScopeIds),
				inArray(workEvents.actorType, OWNED_CHANNEL_AUTHORIZATION_AUTHOR_TYPES),
				isNotNull(workEvents.actorId),
				inArray(workEvents.eventType, [
					OWNED_CHANNEL_AUTHORIZATION_EVENT,
					OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
				]),
			),
		)
		.orderBy(desc(workEvents.occurredAt))
		.limit(20);

	const nowMs = Date.parse(nowIso);
	const verifiedComments: typeof comments = [];
	for (const comment of comments) {
		if (!comment.authorId?.trim()) continue;
		// Separation of duties: the publishing tedi may not be the principal
		// that authorized the publish. Enforced here rather than at authorize
		// time, because authorize time does not yet know who will publish.
		if (
			comment.authorType === "tedi" &&
			comment.authorId.trim() === input.subjectId
		) {
			continue;
		}
		if (
			!(await verifyOwnedChannelAuthorizationProof(
				input.authorizationSigningSecret,
				{
					commentId: comment.id,
					workItemId: comment.workItemId,
					organizationId: input.organizationId,
					authorId: comment.authorId,
					eventType: comment.eventType as
						| typeof OWNED_CHANNEL_AUTHORIZATION_EVENT
						| typeof OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
					body: comment.body,
					createdAt: comment.createdAt,
				},
				comment.metadata,
			))
		) {
			continue;
		}
		verifiedComments.push(comment);
	}
	const latestRevocationMs = verifiedComments.reduce((latest, comment) => {
		if (comment.eventType !== OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT) {
			return latest;
		}
		const occurredAt = Date.parse(comment.createdAt);
		return Number.isFinite(occurredAt) ? Math.max(latest, occurredAt) : latest;
	}, Number.NEGATIVE_INFINITY);
	for (const comment of verifiedComments) {
		if (comment.eventType === OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT)
			continue;
		let json: unknown;
		try {
			json = JSON.parse(comment.body);
		} catch {
			continue;
		}
		const parsed = OwnedChannelAuthorizationReceiptSchema.safeParse(json);
		if (!parsed.success) continue;
		if (!parsed.data.contentIds.includes(input.args.id as string)) continue;
		const authorizationScope = authorizationScopes.find(
			(scope) => scope.id === comment.workItemId,
		);
		if (
			!authorizationScope ||
			authorizationScope.status !== "accepted" ||
			![
				"browser",
				"coding",
				"communication",
				"design",
				"document",
				"finance",
				"incident",
				"legal",
				"operations",
				"other",
				"research",
				"stewardship",
			].includes(authorizationScope.workKind)
		) {
			continue;
		}
		const marketingCampaign = authorizationScope.metadata?.marketingCampaign;
		if (
			!marketingCampaign ||
			typeof marketingCampaign !== "object" ||
			Array.isArray(marketingCampaign) ||
			(marketingCampaign as Record<string, unknown>).key !==
				parsed.data.campaignKey
		) {
			continue;
		}

		const createdAtMs = Date.parse(comment.createdAt);
		const validUntilMs = Date.parse(parsed.data.validUntil);
		if (latestRevocationMs >= createdAtMs) {
			return denied("authorization_revoked", workItemId);
		}
		// Defence in depth: re-derive the ceiling from the receipt's own author
		// type rather than trusting the write path to have applied it. A
		// non-human authorizer's grant is refused here too if it outruns the
		// agent window, so a bypassed or older write path cannot leave a
		// long-lived agent grant standing.
		const maxAuthorizationMs =
			comment.authorType === "user"
				? OWNED_CHANNEL_MAX_AUTHORIZATION_MS
				: OWNED_CHANNEL_AGENT_MAX_AUTHORIZATION_MS;
		if (
			!Number.isFinite(createdAtMs) ||
			!Number.isFinite(validUntilMs) ||
			createdAtMs > nowMs ||
			validUntilMs <= nowMs ||
			validUntilMs > createdAtMs + maxAuthorizationMs
		) {
			continue;
		}

		// Linearization point: all state that can invalidate the decision is
		// re-read in one SQLite snapshot. This includes the exact signed receipt,
		// current ancestry/campaign metadata, the one active CMO leaf + attempt,
		// project state, and every same-or-later reserved revocation event.
		// Cryptographic verification happens only over rows returned by this
		// snapshot, so a revocation inserted before the query can never be missed.
		const linearized = (await db.all(sql`
			/* owned-channel-linearization */
			WITH RECURSIVE lineage(id, parent_work_item_id, depth) AS (
				SELECT id, parent_work_item_id, 0
				FROM work_items
				WHERE id = ${workItemId}
					AND org_id = ${input.organizationId}
				UNION ALL
				SELECT parent.id, parent.parent_work_item_id, lineage.depth + 1
				FROM work_items AS parent
				INNER JOIN lineage ON parent.id = lineage.parent_work_item_id
				WHERE parent.org_id = ${input.organizationId}
					AND parent.project_id = ${activeAttempt.projectId}
					AND lineage.depth < 5
			)
			SELECT
				authorization.id AS authorizationId,
				authorization.work_item_id AS authorizationWorkItemId,
				authorization.actor_id AS authorizationAuthorId,
				json_extract(authorization.payload, '$.body') AS authorizationBody,
				authorization.event_type AS authorizationEventType,
				authorization.payload AS authorizationMetadata,
				authorization.occurred_at AS authorizationCreatedAt,
				revocation.id AS revocationId,
				revocation.work_item_id AS revocationWorkItemId,
				revocation.actor_id AS revocationAuthorId,
				json_extract(revocation.payload, '$.body') AS revocationBody,
				revocation.event_type AS revocationEventType,
				revocation.payload AS revocationMetadata,
				revocation.occurred_at AS revocationCreatedAt
			FROM work_items AS leaf
			INNER JOIN projects AS project
				ON project.id = leaf.project_id
				AND project.org_id = ${input.organizationId}
				AND project.status = 'active'
			INNER JOIN tedis AS cmo
				ON cmo.id = leaf.accountable_owner_id
				AND cmo.organization_id = ${input.organizationId}
				AND cmo.slug = 'cmo'
				AND cmo.status = 'active'
			INNER JOIN work_attempts AS attempt
				ON attempt.id = ${attemptId}
				AND attempt.work_item_id = leaf.id
				AND attempt.org_id = ${input.organizationId}
				AND attempt.executor_type = 'tedi'
				AND attempt.executor_id = ${input.subjectId}
				AND attempt.runtime_state IN ('queued', 'running', 'waiting', 'retrying')
				AND (attempt.expires_at IS NULL OR attempt.expires_at > ${nowIso})
			INNER JOIN work_events AS authorization
				ON authorization.id = ${comment.id}
				AND authorization.work_item_id = ${comment.workItemId}
				AND authorization.org_id = ${input.organizationId}
				AND authorization.actor_type = ${comment.authorType}
				AND authorization.actor_id = ${comment.authorId}
				AND authorization.event_type = ${OWNED_CHANNEL_AUTHORIZATION_EVENT}
				AND json_extract(authorization.payload, '$.body') = ${comment.body}
				AND authorization.occurred_at = ${comment.createdAt}
			INNER JOIN lineage AS authorization_lineage
				ON authorization_lineage.id = authorization.work_item_id
			INNER JOIN work_items AS authorization_scope
				ON authorization_scope.id = authorization.work_item_id
				AND authorization_scope.org_id = ${input.organizationId}
				AND authorization_scope.project_id = leaf.project_id
				AND authorization_scope.disposition = 'accepted'
				AND json_extract(
					authorization_scope.metadata,
					'$.marketingCampaign.key'
				) = ${parsed.data.campaignKey}
			LEFT JOIN work_events AS revocation
				ON revocation.org_id = ${input.organizationId}
				AND revocation.work_item_id IN (SELECT id FROM lineage)
				AND revocation.actor_type IN (${sql.join(
					OWNED_CHANNEL_AUTHORIZATION_AUTHOR_TYPES.map(
						(authorType) => sql`${authorType}`,
					),
					sql`, `,
				)})
				AND revocation.actor_id IS NOT NULL
				AND revocation.event_type = ${OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT}
				AND revocation.occurred_at >= authorization.occurred_at
			WHERE leaf.id = ${workItemId}
				AND leaf.org_id = ${input.organizationId}
				AND leaf.accountable_owner_id = ${input.subjectId}
				AND leaf.accountable_owner_type = 'tedi'
				AND leaf.accountable_owner_id = ${input.subjectId}
				AND leaf.disposition = 'accepted'
				AND NOT EXISTS (
					SELECT 1
					FROM work_items AS child
					WHERE child.org_id = ${input.organizationId}
						AND child.parent_work_item_id = leaf.id
						AND child.disposition NOT IN ('completed', 'cancelled')
				)
				AND NOT EXISTS (
					SELECT 1
					FROM work_items AS other_leaf
					INNER JOIN projects AS other_project
						ON other_project.id = other_leaf.project_id
						AND other_project.org_id = ${input.organizationId}
						AND other_project.status = 'active'
					INNER JOIN work_attempts AS other_attempt
						ON other_attempt.work_item_id = other_leaf.id
						AND other_attempt.org_id = ${input.organizationId}
						AND other_attempt.executor_type = 'tedi'
						AND other_attempt.executor_id = ${input.subjectId}
						AND other_attempt.runtime_state IN ('queued', 'running', 'waiting', 'retrying')
						AND (
							other_attempt.expires_at IS NULL
							OR other_attempt.expires_at > ${nowIso}
						)
					WHERE other_leaf.id <> leaf.id
						AND other_leaf.org_id = ${input.organizationId}
						AND other_leaf.accountable_owner_id = ${input.subjectId}
						AND other_leaf.accountable_owner_type = 'tedi'
						AND other_leaf.accountable_owner_id = ${input.subjectId}
						AND other_leaf.disposition = 'accepted'
						AND NOT EXISTS (
							SELECT 1
							FROM work_items AS other_child
							WHERE other_child.org_id = ${input.organizationId}
								AND other_child.parent_work_item_id = other_leaf.id
								AND other_child.disposition NOT IN ('completed', 'cancelled')
						)
				)
		`)) as Array<{
			authorizationId: string;
			authorizationWorkItemId: string;
			authorizationAuthorId: string;
			authorizationBody: string;
			authorizationEventType: string;
			authorizationMetadata: unknown;
			authorizationCreatedAt: string;
			revocationId: string | null;
			revocationWorkItemId: string | null;
			revocationAuthorId: string | null;
			revocationBody: string | null;
			revocationEventType: string | null;
			revocationMetadata: unknown;
			revocationCreatedAt: string | null;
		}>;
		const current = linearized[0];
		if (!current) {
			return denied("attempt_no_longer_active", workItemId);
		}
		const currentAuthorizationValid =
			await verifyOwnedChannelAuthorizationProof(
				input.authorizationSigningSecret,
				{
					commentId: current.authorizationId,
					workItemId: current.authorizationWorkItemId,
					organizationId: input.organizationId,
					authorId: current.authorizationAuthorId,
					eventType: OWNED_CHANNEL_AUTHORIZATION_EVENT,
					body: current.authorizationBody,
					createdAt: current.authorizationCreatedAt,
				},
				recordFromDbJson(current.authorizationMetadata),
			);
		if (!currentAuthorizationValid) {
			return denied("authorization_changed", workItemId);
		}
		for (const row of linearized) {
			if (
				!row.revocationId ||
				!row.revocationWorkItemId ||
				!row.revocationAuthorId ||
				!row.revocationBody ||
				!row.revocationCreatedAt
			) {
				continue;
			}
			const validRevocation = await verifyOwnedChannelAuthorizationProof(
				input.authorizationSigningSecret,
				{
					commentId: row.revocationId,
					workItemId: row.revocationWorkItemId,
					organizationId: input.organizationId,
					authorId: row.revocationAuthorId,
					eventType: OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT,
					body: row.revocationBody,
					createdAt: row.revocationCreatedAt,
				},
				recordFromDbJson(row.revocationMetadata),
			);
			if (validRevocation) {
				return denied("authorization_revoked", workItemId);
			}
		}

		return {
			approved: true,
			reason: "active_user_receipt",
			workItemId,
			authorizationScopeWorkItemId: comment.workItemId,
			authorizationCommentId: comment.id,
			attemptId,
			campaignKey: parsed.data.campaignKey,
			validUntil: parsed.data.validUntil,
		};
	}

	// The "_user_" in this reason (and in "active_user_receipt" above) is
	// historical: an authorization may now be authored by an accountable agent
	// too. The strings are kept verbatim because they are stable diagnostic
	// identifiers that show up in logs and denial telemetry.
	return denied("no_current_user_authorization", workItemId);
}

/** Persist the signed receipt in the same ledger the publish boundary reads. */
export async function recordOwnedChannelAuthorizationEvent(
	db: DbClient,
	input: {
		id: string;
		orgId: string;
		workItemId: string;
		actorId: string;
		eventType:
			| typeof OWNED_CHANNEL_AUTHORIZATION_EVENT
			| typeof OWNED_CHANNEL_AUTHORIZATION_REVOKED_EVENT;
		body: string;
		signature: string;
		occurredAt: string;
	},
) {
	const [event] = await db
		.insert(workEvents)
		.values({
			id: input.id,
			orgId: input.orgId,
			workItemId: input.workItemId,
			actorType: "user",
			actorId: input.actorId,
			eventType: input.eventType,
			occurredAt: input.occurredAt,
			payload: {
				body: input.body,
				[OWNED_CHANNEL_AUTHORIZATION_PROOF_KEY]: {
					version: 1,
					signature: input.signature,
				},
			},
		})
		.returning();
	if (!event)
		throw new Error("Owned-channel authorization event was not recorded");
	return event;
}

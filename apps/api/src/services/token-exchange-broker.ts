/**
 * Internal token exchange broker and verifier for the tedi → MCP → API hop
 * (pilot). Off unless the Worker variable TOKEN_EXCHANGE_PILOT is "on"; with
 * it off nothing is issued and a forwarded token is ignored, so the existing
 * service-binding path stays exactly as it was.
 *
 * Issuing: the MCP edge, over its own service binding, asks for a token for
 * one API procedure and the scopes that procedure's tool needs. The broker
 * keeps the originating subject (the acting member when one is forwarded and
 * still active, otherwise the tedi) in `sub`, nests the tedi and the MCP edge
 * in `act`, narrows to the requested scopes the tedi holds, and records a
 * lineage row plus an audit row with the actor chain.
 *
 * Verifying: a forwarded token must verify, belong to this organization and
 * tedi, name this exact procedure, and consume its unrevoked lineage row
 * (one call per token). The caller's scopes are then narrowed to the token's,
 * and the MCP tool pre-authorization no longer bypasses the scope gate.
 */
import {
	actorChain,
	exchangeToken,
	TokenExchangeError,
	verifyExchangedToken,
	type ExchangedTokenClaims,
} from "@tedix/auth/token-exchange";
import { TOKEN_EXCHANGE_API_AUDIENCE } from "@tedix/api-contract/schemas/token-exchange";
import {
	buildInsertAuditEventStatement,
	insertAuditEvent,
} from "@tedix/db/queries/audit";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	buildInsertTokenExchangeGrantStatement,
	consumeTokenExchangeGrant,
} from "@tedix/db/queries/token-exchange";
import {
	delegatedMachineScopes,
	hasScope,
} from "@tedix/mcp-shared/auth/scopes";
import type { BaseContext } from "../rpc/context";

export const MCP_EDGE_ACTOR = "service:mcp";
/** One delegated call; well inside the module's five-minute ceiling. */
const EXCHANGED_TOKEN_LIFETIME_SECONDS = 60;

export function tokenExchangePilotEnabled(env: CloudflareEnv): boolean {
	return (
		(env as CloudflareEnv & { TOKEN_EXCHANGE_PILOT?: string })
			.TOKEN_EXCHANGE_PILOT === "on"
	);
}

/** A signing secret derived for this purpose only from the master key. */
export async function tokenExchangeSecret(env: CloudflareEnv): Promise<string> {
	if (!env.SECRETS_MASTER_KEY)
		throw new Error("Token exchange signing secret is unavailable");
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.SECRETS_MASTER_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode("tedix:token-exchange:v1"),
	);
	return [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** The API side is off; the MCP edge then sends no token instead of failing. */
export class TokenExchangeDisabled extends Error {
	constructor() {
		super("Token exchange is not enabled");
		this.name = "TokenExchangeDisabled";
	}
}

export class TokenExchangeRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenExchangeRefused";
	}
}

function trustedTediCall(context: BaseContext) {
	if (
		context.authType !== "service-binding" ||
		context.serviceBindingPrincipal !== "mcp-edge" ||
		!context.tediId ||
		!context.organizationId ||
		context.organizationId === "system" ||
		context.externalAgentPrincipalId
	)
		return null;
	return { tediId: context.tediId, organizationId: context.organizationId };
}

/** Issue one exchanged token for one procedure; throws TokenExchangeRefused. */
export async function brokerInternalExchange(
	context: BaseContext,
	input: { endpoint: string; scopes: string[] },
) {
	if (!tokenExchangePilotEnabled(context.env))
		throw new TokenExchangeDisabled();
	const caller = trustedTediCall(context);
	if (!caller)
		throw new TokenExchangeRefused(
			"Only the MCP edge may exchange a tedi call",
		);
	if (input.endpoint.startsWith("tokenExchange/"))
		throw new TokenExchangeRefused("Token exchange cannot target itself");
	const tedi = await getTediByIdForOrganization(
		context.db,
		caller.tediId,
		caller.organizationId,
	);
	if (!tedi || tedi.retiredAt !== null)
		throw new TokenExchangeRefused("Tedi is not active in this organization");
	const actingUser = context.descopeUserId;
	const member = actingUser
		? await getMemberByUserId(context.db, caller.organizationId, actingUser)
		: null;
	if (actingUser && member?.status !== "active")
		throw new TokenExchangeRefused("Acting member is not active");
	const tediPrincipal = `tedi:${caller.tediId}`;
	const subject = actingUser ? `user:${actingUser}` : tediPrincipal;
	// The edge forwards a tedi's granular MCP scopes; their machine
	// translations are the same authority (the edge's own fallback delegation).
	const forwarded = context.tediScopes ?? [];
	const held = [...forwarded, ...delegatedMachineScopes(forwarded)];
	const requested = [
		...new Set([...input.scopes, ...delegatedMachineScopes(input.scopes)]),
	].sort();
	// The tedi's delegated scopes are its consent and its entitlement here; the
	// tool's requirement is the policy. Hierarchy follows the API scope gate.
	const heldOf = (scopes: string[]) =>
		scopes.filter((scope) => hasScope(held, scope));
	const secret = await tokenExchangeSecret(context.env);
	let issued: Awaited<ReturnType<typeof exchangeToken>>;
	try {
		issued = await exchangeToken({
			subject: {
				sub: subject,
				organizationId: caller.organizationId,
				scopes: heldOf(requested),
				expiresAt:
					Math.floor(Date.now() / 1000) + EXCHANGED_TOKEN_LIFETIME_SECONDS,
				...(actingUser ? { act: { sub: tediPrincipal } } : {}),
			},
			actor: MCP_EDGE_ACTOR,
			audience: TOKEN_EXCHANGE_API_AUDIENCE,
			allowedAudiences: [TOKEN_EXCHANGE_API_AUDIENCE],
			requestedScopes: requested,
			consentedScopes: heldOf(requested),
			actorEntitlement: heldOf(requested),
			toolPolicyScopes: requested,
			lifetimeSeconds: EXCHANGED_TOKEN_LIFETIME_SECONDS,
			secret,
		});
	} catch (error) {
		if (error instanceof TokenExchangeError)
			throw new TokenExchangeRefused(error.message);
		throw error;
	}
	const chain = actorChain(issued.claims.act);
	// The lineage row and its audit row land together or not at all.
	const grant = buildInsertTokenExchangeGrantStatement(context.db, {
		jti: issued.claims.jti,
		parentJti: null,
		organizationId: caller.organizationId,
		subject,
		actorChain: chain,
		audience: issued.claims.audience,
		endpoint: input.endpoint,
		scopes: issued.claims.scopes,
		issuedAt: issued.claims.issuedAt,
		expiresAt: issued.claims.expiresAt,
	});
	const audit = buildInsertAuditEventStatement(context.db, {
		organizationId: caller.organizationId,
		actorId: caller.tediId,
		actorType: "tedi",
		action: "token_exchange.issued",
		resourceType: "exchanged_token",
		resourceId: issued.claims.jti,
		metadata: {
			subject,
			actorChain: chain,
			audience: issued.claims.audience,
			endpoint: input.endpoint,
			scopes: issued.claims.scopes,
			expiresAt: issued.claims.expiresAt,
		},
	});
	await context.db.batch([grant, audit.statement]);
	return issued;
}

function sameList(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

/**
 * Verify a forwarded exchanged token for this exact procedure call and narrow
 * the caller to it. Returns the claims, or throws TokenExchangeRefused; the
 * caller turns that into 401. Never called with the pilot off.
 */
export async function verifyForwardedExchangedToken(
	context: BaseContext,
	token: string,
	procedure: string,
): Promise<ExchangedTokenClaims & { actorChain: string[] }> {
	const caller = trustedTediCall(context);
	if (!caller) throw new TokenExchangeRefused("Untrusted exchanged token");
	let claims: ExchangedTokenClaims;
	try {
		claims = await verifyExchangedToken(token, {
			secret: await tokenExchangeSecret(context.env),
			audience: TOKEN_EXCHANGE_API_AUDIENCE,
		});
	} catch {
		throw new TokenExchangeRefused("Invalid exchanged token");
	}
	const chain = actorChain(claims.act);
	// The subject must be the member this call still says is acting, or the
	// tedi itself when none is.
	const expectedSubject = context.descopeUserId
		? `user:${context.descopeUserId}`
		: `tedi:${caller.tediId}`;
	if (
		claims.sub !== expectedSubject ||
		claims.organizationId !== caller.organizationId ||
		chain[0] !== MCP_EDGE_ACTOR ||
		!(
			claims.sub === `tedi:${caller.tediId}` ||
			chain[1] === `tedi:${caller.tediId}`
		)
	)
		throw new TokenExchangeRefused("Exchanged token is for another caller");
	const now = Math.floor(Date.now() / 1000);
	const row = await consumeTokenExchangeGrant(context.db, {
		jti: claims.jti,
		organizationId: caller.organizationId,
		endpoint: procedure,
		now,
		at: new Date().toISOString(),
	});
	if (
		!row ||
		row.subject !== claims.sub ||
		!sameList(row.actorChain, chain) ||
		!sameList(row.scopes, claims.scopes)
	)
		throw new TokenExchangeRefused(
			"Exchanged token is revoked, used or for another procedure",
		);
	await insertAuditEvent(context.db, {
		organizationId: caller.organizationId,
		actorId: caller.tediId,
		actorType: "tedi",
		action: "token_exchange.used",
		resourceType: "exchanged_token",
		resourceId: claims.jti,
		metadata: {
			subject: claims.sub,
			actorChain: chain,
			endpoint: procedure,
			scopes: claims.scopes,
		},
	});
	return { ...claims, actorChain: chain };
}

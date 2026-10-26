/**
 * Internal RFC 8693 token exchange (pilot; nothing issues these yet).
 *
 * A broker that has already verified a subject token and an actor token asks
 * for a short-lived token for one internal Tedix audience. The issued token
 * keeps the originating subject in `sub` and records who is acting in a
 * nested `act` claim (RFC 8693 §4.1): the outermost `act` is the current
 * actor, each inner `act` the actor before it. Scopes only ever narrow: every
 * requested scope must be held by the subject, consented, within the actor's
 * entitlement and allowed by tool policy, or the exchange is refused.
 *
 * Tokens are signed with a key derived for this use only and are meant for
 * Tedix's own services. Never forward one to an upstream provider.
 */
import * as jose from "jose";

const ISSUER = "tedix:token-exchange";
const TYPE = "tedix-exchanged+jwt";
export const TOKEN_EXCHANGE_GRANT_TYPE =
	"urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE =
	"urn:ietf:params:oauth:token-type:access_token";
const MAX_LIFETIME_SECONDS = 300;
/** Actors in one chain, current one included. */
export const MAX_ACTOR_CHAIN_DEPTH = 4;
const MAX_SCOPES = 64;

export interface ActorClaim {
	sub: string;
	act?: ActorClaim;
}

export interface ExchangeSubject {
	/** The originating principal; kept as `sub` on every hop. */
	sub: string;
	organizationId: string;
	/** Scopes the verified subject token carries. */
	scopes: readonly string[];
	/** Unix seconds; the exchanged token never outlives the subject token. */
	expiresAt: number;
	/** Present when the subject token was itself exchanged. */
	act?: ActorClaim;
	/** The subject token's jti, kept for lineage. */
	jti?: string;
}

export interface ExchangeRequest {
	subject: ExchangeSubject;
	/** The verified actor making this hop, e.g. `tedi:<id>` or `service:mcp`. */
	actor: string;
	/** One exact internal audience. */
	audience: string;
	/** Internal audiences this broker may issue for. */
	allowedAudiences: readonly string[];
	requestedScopes: readonly string[];
	/** What the subject consented to for this client or delegation. */
	consentedScopes: readonly string[];
	/** What the actor itself may ever do. */
	actorEntitlement: readonly string[];
	/** What the target tool policy allows; omit when no tool policy applies. */
	toolPolicyScopes?: readonly string[];
	lifetimeSeconds?: number;
	secret: string;
	now?: number;
}

export interface ExchangedTokenClaims {
	sub: string;
	organizationId: string;
	act: ActorClaim;
	scopes: string[];
	audience: string;
	jti: string;
	/** The subject token's jti when it had one. */
	parentJti: string | null;
	issuedAt: number;
	expiresAt: number;
}

export class TokenExchangeError extends Error {
	constructor(
		readonly code: "invalid_request" | "invalid_target" | "invalid_scope",
		message: string,
	) {
		super(message);
		this.name = "TokenExchangeError";
	}
}

function key(secret: string): Uint8Array {
	if (!secret) throw new Error("Token exchange signing secret is unavailable");
	return new TextEncoder().encode(`tedix:token-exchange:v1:${secret}`);
}

function principal(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value
	);
}

function scopeList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_SCOPES &&
		new Set(value).size === value.length &&
		value.every(
			(scope) => principal(scope) && scope !== "*" && !scope.endsWith(":*"),
		)
	);
}

/** Actors from the current one back to the first; throws on a malformed chain. */
export function actorChain(act: unknown): string[] {
	const chain: string[] = [];
	let node = act;
	while (node !== undefined) {
		if (
			!node ||
			typeof node !== "object" ||
			Array.isArray(node) ||
			!principal((node as ActorClaim).sub) ||
			Object.keys(node).some((field) => field !== "sub" && field !== "act") ||
			chain.length >= MAX_ACTOR_CHAIN_DEPTH
		)
			throw new TokenExchangeError("invalid_request", "Invalid actor chain");
		chain.push((node as ActorClaim).sub);
		node = (node as ActorClaim).act;
	}
	return chain;
}

export async function exchangeToken(input: ExchangeRequest): Promise<{
	token: string;
	claims: ExchangedTokenClaims;
	response: {
		access_token: string;
		issued_token_type: typeof ACCESS_TOKEN_TYPE;
		token_type: "Bearer";
		expires_in: number;
		scope: string;
	};
}> {
	const now = input.now ?? Math.floor(Date.now() / 1000);
	const { subject } = input;
	if (
		!principal(subject.sub) ||
		!principal(subject.organizationId) ||
		!principal(input.actor) ||
		input.actor === subject.sub ||
		!scopeList(subject.scopes)
	)
		throw new TokenExchangeError("invalid_request", "Invalid subject or actor");
	const prior = subject.act === undefined ? [] : actorChain(subject.act);
	if (prior.length + 1 > MAX_ACTOR_CHAIN_DEPTH)
		throw new TokenExchangeError("invalid_request", "Actor chain is too deep");
	// A principal appears once: a repeat is a delegation loop.
	if (prior.includes(input.actor) || prior.includes(subject.sub))
		throw new TokenExchangeError("invalid_request", "Invalid actor chain");
	if (
		!principal(input.audience) ||
		!input.allowedAudiences.includes(input.audience)
	)
		throw new TokenExchangeError("invalid_target", "Audience is not allowed");
	if (!scopeList(input.requestedScopes) || input.requestedScopes.length === 0)
		throw new TokenExchangeError("invalid_scope", "Invalid requested scopes");
	const limits = [
		subject.scopes,
		input.consentedScopes,
		input.actorEntitlement,
		...(input.toolPolicyScopes ? [input.toolPolicyScopes] : []),
	];
	const denied = input.requestedScopes.filter(
		(scope) => !limits.every((allowed) => allowed.includes(scope)),
	);
	if (denied.length > 0)
		throw new TokenExchangeError(
			"invalid_scope",
			`Scopes exceed what the subject, consent, actor or tool policy allow: ${denied.join(", ")}`,
		);
	const lifetime = Math.min(
		input.lifetimeSeconds ?? MAX_LIFETIME_SECONDS,
		MAX_LIFETIME_SECONDS,
		subject.expiresAt - now,
	);
	if (!Number.isInteger(lifetime) || lifetime <= 0)
		throw new TokenExchangeError("invalid_request", "Subject token expired");

	const act: ActorClaim = {
		sub: input.actor,
		...(subject.act ? { act: subject.act } : {}),
	};
	const claims: ExchangedTokenClaims = {
		sub: subject.sub,
		organizationId: subject.organizationId,
		act,
		scopes: [...input.requestedScopes].sort(),
		audience: input.audience,
		jti: crypto.randomUUID(),
		parentJti: subject.jti ?? null,
		issuedAt: now,
		expiresAt: now + lifetime,
	};
	const token = await new jose.SignJWT({
		organizationId: claims.organizationId,
		act: claims.act,
		scope: claims.scopes.join(" "),
		...(claims.parentJti ? { parentJti: claims.parentJti } : {}),
	})
		.setProtectedHeader({ alg: "HS256", typ: TYPE })
		.setIssuer(ISSUER)
		.setSubject(claims.sub)
		.setAudience(claims.audience)
		.setJti(claims.jti)
		.setIssuedAt(now)
		.setNotBefore(now)
		.setExpirationTime(claims.expiresAt)
		.sign(key(input.secret));
	return {
		token,
		claims,
		response: {
			access_token: token,
			issued_token_type: ACCESS_TOKEN_TYPE,
			token_type: "Bearer",
			expires_in: lifetime,
			scope: claims.scopes.join(" "),
		},
	};
}

export async function verifyExchangedToken(
	token: string,
	options: { secret: string; audience: string; now?: number },
): Promise<ExchangedTokenClaims> {
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const { payload, protectedHeader } = await jose.jwtVerify(
		token,
		key(options.secret),
		{
			issuer: ISSUER,
			audience: options.audience,
			algorithms: ["HS256"],
			currentDate: new Date(now * 1000),
			clockTolerance: 0,
		},
	);
	const scopes =
		typeof payload.scope === "string" ? payload.scope.split(" ") : null;
	if (
		protectedHeader.typ !== TYPE ||
		typeof payload.iat !== "number" ||
		typeof payload.exp !== "number" ||
		payload.iat > now ||
		payload.exp - payload.iat > MAX_LIFETIME_SECONDS ||
		!principal(payload.sub) ||
		!principal(payload.organizationId) ||
		!principal(payload.jti) ||
		payload.aud !== options.audience ||
		!scopeList(scopes) ||
		scopes.length === 0 ||
		(payload.parentJti !== undefined && !principal(payload.parentJti))
	)
		throw new TokenExchangeError("invalid_request", "Invalid exchanged token");
	const chain = actorChain(payload.act);
	if (
		chain.length === 0 ||
		chain.includes(payload.sub) ||
		new Set(chain).size !== chain.length
	)
		throw new TokenExchangeError("invalid_request", "Invalid actor chain");
	return {
		sub: payload.sub,
		organizationId: payload.organizationId,
		act: payload.act as ActorClaim,
		scopes,
		audience: options.audience,
		jti: payload.jti,
		parentJti: (payload.parentJti as string | undefined) ?? null,
		issuedAt: payload.iat,
		expiresAt: payload.exp,
	};
}

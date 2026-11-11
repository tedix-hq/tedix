import {
	exchangeCimdAuthorizationCode,
	uploadOAuthToken,
} from "@tedix/auth/connections";
import {
	openOutboundMcpOAuthState,
	type OutboundMcpOAuthState,
} from "@tedix/auth/oauth-cimd-state";
import {
	TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
	TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI,
} from "@tedix/auth/oauth-client-registration";
import {
	assertAuthorizationResponseIss,
	AuthorizationResponseIssError,
} from "@tedix/auth/oauth-iss";
import type { DbClient } from "@tedix/db/client";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { safeExceptionTopology } from "./lib/safe-log-metadata";

type CallbackEnv = Pick<
	CloudflareEnv,
	| "SECRETS_MASTER_KEY"
	| "DESCOPE_PROJECT_ID"
	| "DESCOPE_MANAGEMENT_KEY"
	| "DESCOPE_BASE_URL"
>;

interface CallbackDependencies {
	openState: typeof openOutboundMcpOAuthState;
	validateIssuer: typeof assertAuthorizationResponseIss;
	exchangeCode: typeof exchangeCimdAuthorizationCode;
	uploadToken: typeof uploadOAuthToken;
	insertAudit: typeof insertAuditEvent;
}

type CimdFailureStage = "issuer_validation" | "token_exchange" | "vault_upload";
type CimdDiagnosticStage = CimdFailureStage | "failure_audit" | "granted_audit";

function logCimdFailure(
	stage: CimdDiagnosticStage,
	error: unknown,
	issuerReason?: "iss_mismatch" | "iss_missing",
): void {
	console.error({
		component: "api.oauth-cimd-callback",
		event: "oauth_cimd_callback_failed",
		stage,
		...(issuerReason && { issuerReason }),
		exception: safeExceptionTopology(error),
	});
}

const defaultDependencies: CallbackDependencies = {
	openState: openOutboundMcpOAuthState,
	validateIssuer: assertAuthorizationResponseIss,
	exchangeCode: exchangeCimdAuthorizationCode,
	uploadToken: uploadOAuthToken,
	insertAudit: insertAuditEvent,
};

async function recordCimdFailure(
	state: OutboundMcpOAuthState,
	stage: CimdFailureStage,
	db: DbClient,
	dependencies: CallbackDependencies,
): Promise<void> {
	try {
		await dependencies.insertAudit(db, {
			organizationId: state.organizationId,
			actorId: state.grantedBy,
			actorType: "user",
			action: "connection.oauth_cimd_failed",
			resourceType: "connection_provider",
			resourceId: state.appId,
			metadata: { stage },
		});
	} catch (error) {
		logCimdFailure("failure_audit", error);
	}
}

async function recordGrantedAudit(
	state: OutboundMcpOAuthState,
	scopeCount: number,
	db: DbClient,
	dependencies: CallbackDependencies,
): Promise<void> {
	try {
		await dependencies.insertAudit(db, {
			organizationId: state.organizationId,
			actorId: state.grantedBy,
			actorType: "user",
			action: "connection.oauth_cimd_granted",
			resourceType: "connection_provider",
			resourceId: state.appId,
			metadata: {
				issuerValidated: true,
				resource: state.resource,
				scopeCount,
				tokenScope: state.userId ? "user" : "tenant",
			},
		});
	} catch (error) {
		// The credential is already in the vault. Do not turn an audit-storage
		// outage into a false failed-connect response that asks the user to retry.
		logCimdFailure("granted_audit", error);
	}
}

/** Query parameters the relay hands to the product callback page. */
export const OUTBOUND_OAUTH_RELAY_PARAMS = {
	state: "cimdState",
	code: "cimdCode",
	iss: "cimdIss",
	error: "cimdError",
} as const;

/**
 * Public provider callback. It stores nothing: it only carries the sealed
 * state and the authorization response to the product page the flow started
 * from. The code is useless there without the verifier sealed in the state,
 * and the grant is stored only when the person who started the flow settles
 * it over their own sign-in (`settleOutboundMcpOAuth`).
 */
export async function handleOutboundMcpOAuthCallback(
	request: Request,
	env: Pick<CallbackEnv, "SECRETS_MASTER_KEY">,
	openState: typeof openOutboundMcpOAuthState = openOutboundMcpOAuthState,
): Promise<Response> {
	const url = new URL(request.url);
	const encodedState = url.searchParams.get("state");
	if (!encodedState)
		return new Response("Missing OAuth state", { status: 400 });

	let state;
	try {
		state = await openState(encodedState, env.SECRETS_MASTER_KEY);
	} catch {
		return new Response("Invalid or expired OAuth state", { status: 400 });
	}

	const target = new URL(state.redirectUrl);
	target.searchParams.set(OUTBOUND_OAUTH_RELAY_PARAMS.state, encodedState);
	for (const name of ["code", "iss", "error"] as const) {
		const value = url.searchParams.get(name);
		if (value)
			target.searchParams.set(OUTBOUND_OAUTH_RELAY_PARAMS[name], value);
	}
	return new Response(null, {
		status: 302,
		headers: {
			Location: target.toString(),
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

export type OutboundOAuthSettlement =
	| { status: "success"; provider: string }
	| { status: "error"; provider: string; reason: string }
	| { status: "rejected"; reason: "state_invalid" | "initiator_mismatch" };

/**
 * Exchange the code and store the grant, for the initiator only. A consent
 * that someone else completed from a forwarded link reaches this under their
 * own sign-in, which does not match the sealed initiator, so their provider
 * account never lands in the initiator's organization.
 */
export async function settleOutboundMcpOAuth(
	input: {
		state: string;
		code?: string | null;
		iss?: string | null;
		error?: string | null;
	},
	caller: { userId: string; organizationId: string },
	env: CallbackEnv,
	db: DbClient,
	dependencies: CallbackDependencies = defaultDependencies,
): Promise<OutboundOAuthSettlement> {
	let state;
	try {
		state = await dependencies.openState(input.state, env.SECRETS_MASTER_KEY);
	} catch {
		return { status: "rejected", reason: "state_invalid" };
	}
	if (
		state.grantedBy !== caller.userId ||
		state.organizationId !== caller.organizationId
	)
		return { status: "rejected", reason: "initiator_mismatch" };

	const failed = (reason: string): OutboundOAuthSettlement => ({
		status: "error",
		provider: state.appId,
		reason,
	});

	try {
		dependencies.validateIssuer({
			expectedIssuer: state.expectedIssuer,
			responseIss: input.iss ?? null,
			issSupported: state.issSupported,
		});
	} catch (error) {
		logCimdFailure(
			"issuer_validation",
			error,
			error instanceof AuthorizationResponseIssError ? error.code : undefined,
		);
		await recordCimdFailure(state, "issuer_validation", db, dependencies);
		return failed("issuer_validation_failed");
	}

	if (input.error) {
		await dependencies.insertAudit(db, {
			organizationId: state.organizationId,
			actorId: state.grantedBy,
			actorType: "user",
			action: "connection.oauth_cimd_denied",
			resourceType: "connection_provider",
			resourceId: state.appId,
			metadata: { upstreamError: input.error },
		});
		return failed("consent_denied");
	}

	if (!input.code) return failed("code_missing");
	let token;
	try {
		token = await dependencies.exchangeCode({
			tokenUrl: state.tokenUrl,
			code: input.code,
			codeVerifier: state.codeVerifier,
			resource: state.resource,
			redirectUri: TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI,
			clientId: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
		});
	} catch (error) {
		logCimdFailure("token_exchange", error);
		await recordCimdFailure(state, "token_exchange", db, dependencies);
		return failed("token_exchange_failed");
	}

	const grantedScopes = token.scopes?.length
		? token.scopes
		: state.scopes.length
			? state.scopes
			: undefined;
	try {
		await dependencies.uploadToken(env, {
			appId: state.appId,
			...(state.userId
				? { userId: state.userId }
				: { tenantId: state.tenantId }),
			accessToken: token.accessToken,
			...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
			...(token.accessTokenExpiry
				? { accessTokenExpiry: token.accessTokenExpiry }
				: {}),
			accessTokenType: token.accessTokenType,
			...(grantedScopes ? { scopes: grantedScopes } : {}),
			...(token.idToken ? { idToken: token.idToken } : {}),
			grantedBy: state.grantedBy,
			verifyRefresh: false,
		});
	} catch (error) {
		logCimdFailure("vault_upload", error);
		await recordCimdFailure(state, "vault_upload", db, dependencies);
		return failed("vault_upload_failed");
	}

	await recordGrantedAudit(state, grantedScopes?.length ?? 0, db, dependencies);
	return { status: "success", provider: state.appId };
}

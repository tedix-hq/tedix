import {
	exchangeCimdAuthorizationCode,
	uploadTenantOAuthToken,
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
	uploadToken: typeof uploadTenantOAuthToken;
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
	uploadToken: uploadTenantOAuthToken,
	insertAudit: insertAuditEvent,
};

function completionRedirect(
	redirectUrl: string,
	params: Record<string, string>,
): Response {
	const target = new URL(redirectUrl);
	for (const [key, value] of Object.entries(params)) {
		target.searchParams.set(key, value);
	}
	return Response.redirect(target.toString(), 302);
}

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
			},
		});
	} catch (error) {
		// The credential is already in the vault. Do not turn an audit-storage
		// outage into a false failed-connect response that asks the user to retry.
		logCimdFailure("granted_audit", error);
	}
}

/** Settle the public CIMD callback without reading browser cookies or sessions. */
export async function handleOutboundMcpOAuthCallback(
	request: Request,
	env: CallbackEnv,
	db: DbClient,
	dependencies: CallbackDependencies = defaultDependencies,
): Promise<Response> {
	const url = new URL(request.url);
	const encodedState = url.searchParams.get("state");
	if (!encodedState)
		return new Response("Missing OAuth state", { status: 400 });

	let state;
	try {
		state = await dependencies.openState(encodedState, env.SECRETS_MASTER_KEY);
	} catch {
		return new Response("Invalid or expired OAuth state", { status: 400 });
	}

	try {
		dependencies.validateIssuer({
			expectedIssuer: state.expectedIssuer,
			responseIss: url.searchParams.get("iss"),
			issSupported: state.issSupported,
		});
	} catch (error) {
		logCimdFailure(
			"issuer_validation",
			error,
			error instanceof AuthorizationResponseIssError ? error.code : undefined,
		);
		await recordCimdFailure(state, "issuer_validation", db, dependencies);
		return completionRedirect(state.redirectUrl, {
			status: "error",
			provider: state.appId,
			reason: "issuer_validation_failed",
		});
	}

	const upstreamError = url.searchParams.get("error");
	if (upstreamError) {
		await dependencies.insertAudit(db, {
			organizationId: state.organizationId,
			actorId: state.grantedBy,
			actorType: "user",
			action: "connection.oauth_cimd_denied",
			resourceType: "connection_provider",
			resourceId: state.appId,
			metadata: { upstreamError },
		});
		return completionRedirect(state.redirectUrl, {
			status: "error",
			provider: state.appId,
			reason: "consent_denied",
		});
	}

	const code = url.searchParams.get("code");
	if (!code) return new Response("Missing authorization code", { status: 400 });
	let token;
	try {
		token = await dependencies.exchangeCode({
			tokenUrl: state.tokenUrl,
			code,
			codeVerifier: state.codeVerifier,
			resource: state.resource,
			redirectUri: TEDIX_OUTBOUND_MCP_OAUTH_REDIRECT_URI,
			clientId: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
		});
	} catch (error) {
		logCimdFailure("token_exchange", error);
		await recordCimdFailure(state, "token_exchange", db, dependencies);
		return completionRedirect(state.redirectUrl, {
			status: "error",
			provider: state.appId,
			reason: "token_exchange_failed",
		});
	}

	const grantedScopes = token.scopes?.length
		? token.scopes
		: state.scopes.length
			? state.scopes
			: undefined;
	try {
		await dependencies.uploadToken(env, {
			appId: state.appId,
			tenantId: state.tenantId,
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
		return completionRedirect(state.redirectUrl, {
			status: "error",
			provider: state.appId,
			reason: "vault_upload_failed",
		});
	}

	await recordGrantedAudit(state, grantedScopes?.length ?? 0, db, dependencies);
	return completionRedirect(state.redirectUrl, {
		status: "success",
		provider: state.appId,
	});
}

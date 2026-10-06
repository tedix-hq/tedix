export const SESSION_BROKER_ORIGIN = "https://auth.tedix.dev";
export const SESSION_BROKER_AUTHORIZE_PATH = "/tedix/session/authorize";
export const SESSION_BROKER_LOGIN_ORIGIN = "https://os.tedix.dev";
export const SESSION_BROKER_LOGIN_PATH = "/login";
// The intent may pause once for an interactive sign-in. Authorization codes
// remain short-lived; the longer opaque intent contains no credential.
export const SESSION_BROKER_INTENT_TTL_SECONDS = 10 * 60;
export const SESSION_BROKER_CODE_TTL_SECONDS = 30;

export const SESSION_BROKER_CALLBACK_PATHS = {
	cms: "/_emdash/api/auth/session-broker/callback",
	cli: "/cli/session-broker/callback",
	docs: "/auth/session-broker/callback",
	os: "/auth/session-broker/callback",
} as const;

/**
 * Product Workers bind only their named RPC entrypoint. The public browser
 * cannot call these entrypoints, and one product cannot claim another surface.
 */
export const SESSION_BROKER_RPC_ENTRYPOINTS = {
	cms: "CmsSessionBroker",
	cli: "CliSessionBroker",
	docs: "DocsSessionBroker",
	os: "OsSessionBroker",
} as const;

export const SESSION_BROKER_NO_STORE_HEADERS = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
} as const;

export type SessionBrokerSurface = keyof typeof SESSION_BROKER_CALLBACK_PATHS;
export type SessionBrokerOperation =
	| "issue_session"
	| "resume_session"
	| "logout"
	| "outbound_connect";

export interface SessionBrokerIntent {
	callbackPath: string;
	expiresAt: number;
	intentId: string;
	issuedAt: number;
	operation: SessionBrokerOperation;
	redirectPath: string;
	stateHash: string;
	surface: SessionBrokerSurface;
	targetOrigin: string;
	/**
	 * Required only for an explicit tenant selection. Resume and logout are
	 * tenantless requests so callers cannot manufacture tenant authority.
	 */
	tenantId: string | null;
	/** A Descope Outbound App ID; present only for an outbound-connect handoff. */
	outboundAppId?: string;
	outboundScopes?: string[];
	/** Authorized personal slot selector; labels are never selectors. */
	outboundExternalIdentifier?: string;
	/** Verified initiating person; the central refresh cookie must match. */
	outboundUserId?: string;
	version: 1;
}

/**
 * Input to the broker's service-binding-only `createIntent` RPC. The caller
 * keeps the raw state in a host-only HttpOnly correlation cookie and sends
 * only its SHA-256 digest to the broker.
 */
export type CreateSessionBrokerIntentInput = Omit<
	SessionBrokerIntent,
	"callbackPath" | "expiresAt" | "intentId" | "issuedAt" | "surface" | "version"
>;

/**
 * Input to the broker's service-binding-only `exchangeCode` RPC. The broker
 * atomically consumes the intent and code after checking every binding.
 */
export interface ExchangeSessionBrokerCodeInput {
	code: string;
	intentId: string;
	stateHash: string;
	targetOrigin: string;
	tenantId: string | null;
}

export interface SessionBrokerAuthorizationCode {
	code: string;
	expiresAt: number;
	intentId: string;
	issuedAt: number;
}

export interface CreateSessionBrokerIntentResult {
	authorizeUrl: string;
	expiresAt: number;
	intentId: string;
}

export interface SessionBrokerRpc {
	createIntent(
		input: CreateSessionBrokerIntentInput,
	): Promise<CreateSessionBrokerIntentResult>;
	exchangeCode(
		input: ExchangeSessionBrokerCodeInput,
	): Promise<SessionBrokerExchangeResult>;
}

export function buildSessionBrokerLoginUrl(
	intentId: string,
	options?: { skipOrganizationPreparation?: boolean; osOrigin?: string },
): string {
	assertOpaqueReference(intentId, "INVALID_INTENT_ID");
	const osOrigin = options?.osOrigin
		? assertCanonicalSessionBrokerOrigin(options.osOrigin)
		: SESSION_BROKER_LOGIN_ORIGIN;
	const url = new URL(SESSION_BROKER_LOGIN_PATH, osOrigin);
	url.searchParams.set("intent", intentId);
	if (options?.skipOrganizationPreparation) {
		// Presentation-only hint for the central sign-in page. The broker still
		// reads and validates the opaque intent before it performs any action.
		url.searchParams.set("outbound", "1");
	}
	return url.toString();
}

export type SessionBrokerAuthorizeError =
	| "invalid_request"
	| "reauth_required"
	| "session_unavailable";

/** Never serialize this result into a browser response or browser script. */
export type SessionBrokerExchangeResult =
	| {
			expiresAt: number;
			kind: "session";
			sessionJwt: string;
			subject: string;
			/**
			 * A resumed project session can be tenantless until the user chooses an
			 * organization. Explicit tenant-selection grants always contain a tenant.
			 */
			tenantId: string | null;
	  }
	| { kind: "logout" };

export interface SessionBrokerAuditEvent {
	code:
		| "intent_created"
		| "rotation_succeeded"
		| "rotation_failed"
		| "code_exchanged"
		| "code_rejected"
		| "logout_succeeded";
	durationMs?: number;
	intentIdHash: string;
	operation: SessionBrokerOperation;
	outcome: "succeeded" | "rejected" | "failed";
	surface: SessionBrokerSurface;
	tenantId: string | null;
	traceId: string;
}

export type SessionBrokerContractErrorCode =
	| "INVALID_CALLBACK_PATH"
	| "INVALID_CODE"
	| "INVALID_CODE_EXPIRY"
	| "INVALID_EXPIRY"
	| "INVALID_INTENT_ID"
	| "INVALID_ISSUED_AT"
	| "INVALID_OPERATION"
	| "INVALID_REDIRECT_PATH"
	| "INVALID_STATE_HASH"
	| "INVALID_SURFACE"
	| "INVALID_TARGET_ORIGIN"
	| "INVALID_TENANT_ID"
	| "INVALID_VERSION";

export class SessionBrokerContractError extends Error {
	constructor(
		message: string,
		public readonly code: SessionBrokerContractErrorCode,
	) {
		super(message);
		this.name = "SessionBrokerContractError";
	}
}

const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const SHA_256_DIGEST_PATTERN = /^sha256-[A-Za-z0-9_-]{43}$/;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isSessionBrokerTenantId(value: string): boolean {
	return TENANT_ID_PATTERN.test(value);
}

function fail(code: SessionBrokerContractErrorCode, message: string): never {
	throw new SessionBrokerContractError(message, code);
}

function isSingleDnsLabel(value: string): boolean {
	return DNS_LABEL_PATTERN.test(value);
}

/** Installation origins are exact hosts, never a wildcard or URL prefix. */
export function assertCanonicalSessionBrokerOrigin(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return fail("INVALID_TARGET_ORIGIN", "Configured origin is not a URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		value !== parsed.origin
	) {
		return fail(
			"INVALID_TARGET_ORIGIN",
			"Configured origin is not canonical HTTPS",
		);
	}
	return parsed.origin;
}

/** The two public hosts are one installation contract, not independent hints. */
export function readSessionBrokerOrigins(vars: {
	DESCOPE_BASE_URL?: string;
	OS_URL?: string;
	SESSION_BROKER_URL?: string;
}): { osOrigin?: string; brokerOrigin: string } {
	if (!vars.OS_URL && !vars.SESSION_BROKER_URL) {
		if (
			vars.DESCOPE_BASE_URL &&
			vars.DESCOPE_BASE_URL !== SESSION_BROKER_ORIGIN
		) {
			return fail(
				"INVALID_TARGET_ORIGIN",
				"Custom Descope host requires installation OS and broker origins",
			);
		}
		return { brokerOrigin: SESSION_BROKER_ORIGIN };
	}
	if (!vars.OS_URL || !vars.SESSION_BROKER_URL) {
		return fail(
			"INVALID_TARGET_ORIGIN",
			"Installation origins must be configured together",
		);
	}
	const osOrigin = assertCanonicalSessionBrokerOrigin(vars.OS_URL);
	const brokerOrigin = assertCanonicalSessionBrokerOrigin(
		vars.SESSION_BROKER_URL,
	);
	if (
		osOrigin === SESSION_BROKER_LOGIN_ORIGIN &&
		brokerOrigin === SESSION_BROKER_ORIGIN &&
		vars.DESCOPE_BASE_URL === SESSION_BROKER_ORIGIN
	) {
		return { brokerOrigin: SESSION_BROKER_ORIGIN };
	}
	if (
		osOrigin === SESSION_BROKER_LOGIN_ORIGIN ||
		brokerOrigin === SESSION_BROKER_ORIGIN
	) {
		return fail(
			"INVALID_TARGET_ORIGIN",
			"An independent installation cannot mix managed Tedix hosts",
		);
	}
	if (vars.DESCOPE_BASE_URL !== brokerOrigin || osOrigin === brokerOrigin) {
		return fail(
			"INVALID_TARGET_ORIGIN",
			"Descope and broker must share one auth host distinct from OS",
		);
	}
	return { osOrigin, brokerOrigin };
}

function isOriginAllowedForSurface(
	surface: SessionBrokerSurface,
	origin: string,
): boolean {
	const hostname = new URL(origin).hostname;
	switch (surface) {
		case "cli":
			return hostname === "os.tedix.dev" || hostname === "os.tedix.tech";
		case "docs": {
			for (const platformDomain of ["tedix.dev", "tedix.tech"] as const) {
				if (
					hostname === `docs.${platformDomain}` ||
					hostname === `docs-internal.${platformDomain}`
				) {
					return true;
				}
				const suffix = `.docs.${platformDomain}`;
				if (
					hostname.endsWith(suffix) &&
					isSingleDnsLabel(hostname.slice(0, -suffix.length))
				) {
					return true;
				}
			}
			return false;
		}
		case "os": {
			for (const platformDomain of ["tedix.dev", "tedix.tech"] as const) {
				if (hostname === `os.${platformDomain}`) return true;
				const suffix = `.os.${platformDomain}`;
				if (
					hostname.endsWith(suffix) &&
					isSingleDnsLabel(hostname.slice(0, -suffix.length))
				) {
					return true;
				}
			}
			return false;
		}
		case "cms": {
			const suffix = ".cms.tedix.dev";
			return (
				hostname.endsWith(suffix) &&
				isSingleDnsLabel(hostname.slice(0, -suffix.length))
			);
		}
	}
}

export function assertSessionBrokerTargetOrigin(
	surface: SessionBrokerSurface,
	value: string,
	installationOsOrigin?: string,
): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return fail("INVALID_TARGET_ORIGIN", "Target origin is not a URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.port ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		value !== parsed.origin ||
		(installationOsOrigin
			? (surface !== "os" && surface !== "cli") ||
				parsed.origin !==
					assertCanonicalSessionBrokerOrigin(installationOsOrigin)
			: !isOriginAllowedForSurface(surface, parsed.origin))
	) {
		return fail(
			"INVALID_TARGET_ORIGIN",
			"Target origin is not allowlisted for this installation",
		);
	}
	return parsed.origin;
}

export function assertSessionBrokerRedirectPath(
	value: string,
	targetOrigin: string,
): string {
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		value.includes("\r") ||
		value.includes("\n")
	) {
		return fail(
			"INVALID_REDIRECT_PATH",
			"Redirect path must be an absolute same-origin path",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(value, targetOrigin);
	} catch {
		return fail("INVALID_REDIRECT_PATH", "Redirect path is invalid");
	}
	if (parsed.origin !== targetOrigin || parsed.hash) {
		return fail(
			"INVALID_REDIRECT_PATH",
			"Redirect path must stay on the target origin and omit fragments",
		);
	}
	return `${parsed.pathname}${parsed.search}`;
}

function assertOpaqueReference(
	value: string,
	code: "INVALID_CODE" | "INVALID_INTENT_ID",
): string {
	if (!OPAQUE_REFERENCE_PATTERN.test(value)) {
		return fail(code, "Opaque reference has an invalid shape");
	}
	return value;
}

export function assertSessionBrokerStateHash(value: string): string {
	if (!SHA_256_DIGEST_PATTERN.test(value)) {
		return fail(
			"INVALID_STATE_HASH",
			"State hash must be a base64url SHA-256 digest",
		);
	}
	return value;
}

export function assertSessionBrokerIntent(
	value: SessionBrokerIntent,
	now = Math.floor(Date.now() / 1000),
	installationOsOrigin?: string,
): SessionBrokerIntent {
	if (value.version !== 1)
		fail("INVALID_VERSION", "Unsupported intent version");
	if (
		!Object.prototype.hasOwnProperty.call(
			SESSION_BROKER_CALLBACK_PATHS,
			value.surface,
		)
	) {
		fail("INVALID_SURFACE", "Unsupported broker surface");
	}
	if (
		value.operation !== "issue_session" &&
		value.operation !== "resume_session" &&
		value.operation !== "logout" &&
		value.operation !== "outbound_connect"
	) {
		fail("INVALID_OPERATION", "Unsupported broker operation");
	}
	assertOpaqueReference(value.intentId, "INVALID_INTENT_ID");
	assertSessionBrokerStateHash(value.stateHash);
	if (value.operation === "issue_session") {
		if (!value.tenantId || !isSessionBrokerTenantId(value.tenantId)) {
			fail("INVALID_TENANT_ID", "Tenant id has an invalid shape");
		}
	} else if (
		value.operation !== "outbound_connect" &&
		value.tenantId !== null
	) {
		fail(
			"INVALID_TENANT_ID",
			"Resume and logout intents must not supply tenant authority",
		);
	}
	if (value.operation === "outbound_connect") {
		if (
			value.outboundScopes !== undefined &&
			(!Array.isArray(value.outboundScopes) ||
				value.outboundScopes.length > 100 ||
				!value.outboundScopes.every(
					(scope) =>
						typeof scope === "string" &&
						scope.length > 0 &&
						scope.length <= 2048,
				))
		)
			fail("INVALID_OPERATION", "Outbound scopes have an invalid shape");
		if (
			value.outboundExternalIdentifier !== undefined &&
			(typeof value.outboundExternalIdentifier !== "string" ||
				!/^tedix_[0-9a-f-]{36}$/.test(value.outboundExternalIdentifier) ||
				typeof value.outboundUserId !== "string" ||
				!value.outboundUserId ||
				value.outboundUserId.length > 200)
		)
			fail(
				"INVALID_OPERATION",
				"Outbound account selector has an invalid shape",
			);
		if (value.tenantId !== null && !isSessionBrokerTenantId(value.tenantId)) {
			fail("INVALID_TENANT_ID", "Tenant id has an invalid shape");
		}
		if (
			typeof value.outboundAppId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.outboundAppId)
		) {
			fail("INVALID_OPERATION", "Outbound app id has an invalid shape");
		}
	} else if (
		value.outboundAppId !== undefined ||
		value.outboundScopes !== undefined ||
		value.outboundExternalIdentifier !== undefined ||
		value.outboundUserId !== undefined
	) {
		fail("INVALID_OPERATION", "Only outbound intents may carry an app id");
	}
	if (!Number.isInteger(value.issuedAt) || value.issuedAt > now + 5) {
		fail("INVALID_ISSUED_AT", "Intent issue time is invalid");
	}
	if (
		!Number.isInteger(value.expiresAt) ||
		value.expiresAt <= now ||
		value.expiresAt - value.issuedAt > SESSION_BROKER_INTENT_TTL_SECONDS
	) {
		fail("INVALID_EXPIRY", "Intent is expired or exceeds its maximum TTL");
	}
	const targetOrigin = assertSessionBrokerTargetOrigin(
		value.surface,
		value.targetOrigin,
		installationOsOrigin,
	);
	if (value.callbackPath !== SESSION_BROKER_CALLBACK_PATHS[value.surface]) {
		fail(
			"INVALID_CALLBACK_PATH",
			"Callback path does not match the surface contract",
		);
	}
	assertSessionBrokerRedirectPath(value.redirectPath, targetOrigin);
	return value;
}

export function assertSessionBrokerAuthorizationCode(
	value: SessionBrokerAuthorizationCode,
	now = Math.floor(Date.now() / 1000),
): SessionBrokerAuthorizationCode {
	assertOpaqueReference(value.code, "INVALID_CODE");
	assertOpaqueReference(value.intentId, "INVALID_INTENT_ID");
	if (!Number.isInteger(value.issuedAt) || value.issuedAt > now + 5) {
		fail("INVALID_ISSUED_AT", "Authorization code issue time is invalid");
	}
	if (
		!Number.isInteger(value.expiresAt) ||
		value.expiresAt <= now ||
		value.expiresAt - value.issuedAt > SESSION_BROKER_CODE_TTL_SECONDS
	) {
		fail(
			"INVALID_CODE_EXPIRY",
			"Authorization code is expired or exceeds its maximum TTL",
		);
	}
	return value;
}

export function assertExchangeSessionBrokerCodeInput(
	value: ExchangeSessionBrokerCodeInput,
	surface: SessionBrokerSurface,
	installationOsOrigin?: string,
): ExchangeSessionBrokerCodeInput {
	assertOpaqueReference(value.code, "INVALID_CODE");
	assertOpaqueReference(value.intentId, "INVALID_INTENT_ID");
	assertSessionBrokerStateHash(value.stateHash);
	assertSessionBrokerTargetOrigin(
		surface,
		value.targetOrigin,
		installationOsOrigin,
	);
	if (value.tenantId !== null && !isSessionBrokerTenantId(value.tenantId)) {
		fail("INVALID_TENANT_ID", "Tenant id has an invalid shape");
	}
	return value;
}

export function buildSessionBrokerAuthorizeUrl(
	intentId: string,
	brokerOrigin = SESSION_BROKER_ORIGIN,
): string {
	assertOpaqueReference(intentId, "INVALID_INTENT_ID");
	const url = new URL(
		SESSION_BROKER_AUTHORIZE_PATH,
		assertCanonicalSessionBrokerOrigin(brokerOrigin),
	);
	url.searchParams.set("intent", intentId);
	return url.toString();
}

export function buildSessionBrokerCallbackUrl(
	intent: SessionBrokerIntent,
	code: string,
	now = Math.floor(Date.now() / 1000),
	installationOsOrigin?: string,
): string {
	assertSessionBrokerIntent(intent, now, installationOsOrigin);
	assertOpaqueReference(code, "INVALID_CODE");
	const url = new URL(intent.callbackPath, intent.targetOrigin);
	url.searchParams.set("intent", intent.intentId);
	url.searchParams.set("code", code);
	return url.toString();
}

export function buildSessionBrokerErrorCallbackUrl(
	intent: SessionBrokerIntent,
	error: SessionBrokerAuthorizeError,
	now = Math.floor(Date.now() / 1000),
	installationOsOrigin?: string,
): string {
	assertSessionBrokerIntent(intent, now, installationOsOrigin);
	const url = new URL(intent.callbackPath, intent.targetOrigin);
	url.searchParams.set("intent", intent.intentId);
	url.searchParams.set("error", error);
	return url.toString();
}

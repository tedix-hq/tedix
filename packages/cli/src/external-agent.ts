import { hostname, userInfo } from "node:os";
import {
	type ExternalAgentSessionExchangeOutput,
	ExternalAgentSessionExchangeOutputSchema,
} from "@tedix/api-contract/contracts/external-agent-identity";
import {
	CAPABILITY_SCOPES,
	PLATFORM_OPERATOR_SCOPE,
} from "@tedix/mcp-shared/auth/scopes";
import { type AvailableWorkspace, listAvailableWorkspaces } from "./account";
import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import type { WorkspaceCredential } from "./credential-store";
import {
	readExternalAgentProfile,
	readExternalAgentCredential,
	writeExternalAgentCredential,
	removeExternalAgentSession,
	type StoredExternalAgentProfile,
	type StoredExternalAgentSession,
	writeExternalAgentProfile,
	writeExternalAgentSession,
	withExternalAgentStartLock,
} from "./external-agent-store";
import { errorText } from "./format";
import { TedixHomeClient } from "./home-client";
import { type AuthResolution, withTimeout } from "./shared";
import { resolveAgentSession } from "./work";
import {
	createFileWorkAttemptStore,
	type WorkAttemptStore,
} from "./work-attempt-store";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { isMultiOrganizationMcpUrl } from "./oauth-provider";
import { resolveOrganizationTarget } from "./organization-target";

type FetchLike = (
	url: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type GatewayClient = Pick<TedixHomeClient, "runCode" | "close"> &
	Partial<Pick<TedixHomeClient, "runCodeWithDestructiveApproval">>;
type GatewayClientFactory = (options: {
	headers: Record<string, string>;
	url: string;
}) => GatewayClient;

interface ExternalAgentSessionTuple {
	externalSessionKey: string;
	harness: string;
	harnessVersion: string;
	modelProvider: string;
	modelId: string;
	modelVersion: string;
}

type SessionExchangeRejectionCode =
	| "credential_issuance_in_progress"
	| "credential_binding_mismatch"
	| "immutable_session_conflict"
	| "principal_inactive"
	| "principal_not_found"
	| "session_ended";

class ExternalAgentSessionExchangeError extends Error {
	constructor(
		readonly code: SessionExchangeRejectionCode | undefined,
		message: string,
	) {
		super(message);
		this.name = "ExternalAgentSessionExchangeError";
	}
}

interface StartExternalAgentOptions {
	workspace: string;
	organization?: string;
	workspaceCredential?: WorkspaceCredential;
	mcpUrl: string;
	oauthBearer?: string;
	agentKey?: string;
	displayName?: string;
	harness?: string;
	harnessVersion?: string;
	modelProvider?: string;
	modelId?: string;
	modelVersion?: string;
	scopes?: string[];
	fetch?: FetchLike;
	/** Overall credential-exchange deadline, including retries and response body. */
	sessionExchangeTimeoutMs?: number;
	listWorkspaces?: () => Promise<AvailableWorkspace[]>;
	createClient?: GatewayClientFactory;
	/** Receives non-fatal notices, such as an ignored --agent-key. Defaults to stderr. */
	notice?: (message: string) => void;
}

/**
 * A profile's principal is shared by every harness session on this machine, so
 * it is named for the machine and user. Naming it after the first agent that
 * bootstrapped it made every later Claude or Codex session look borrowed.
 */
export function defaultLocalPrincipal(
	user: string = safeUsername(),
	host: string = hostname(),
): { key: string; displayName: string } {
	const part = (value: string) =>
		value
			.toLowerCase()
			.replace(/\.local$/, "")
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "");
	const key = ["local", part(user), part(host)]
		.filter(Boolean)
		.join("-")
		.slice(0, 120)
		.replace(/-+$/, "");
	return {
		key,
		displayName: `Local coding agents (${user || "user"}@${host || "machine"})`,
	};
}

function safeUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "";
	}
}

interface SessionExchangeOptions {
	fetch?: FetchLike;
	sessionExchangeTimeoutMs?: number;
}

const EXTERNAL_AGENT_AIH_SCOPES = new Set<string>([
	...CAPABILITY_SCOPES,
	"connections.execute",
	"connections.admin",
	PLATFORM_OPERATOR_SCOPE,
]);

function resolveExternalAgentBootstrapScopes(requestedScopes: string[]): {
	apiKeyScopes: string[];
	aihScopes: string[];
} {
	const requested = [...new Set(requestedScopes)];
	const unsupported = requested.filter(
		(scope) =>
			!scope.startsWith("work:") && !EXTERNAL_AGENT_AIH_SCOPES.has(scope),
	);
	if (unsupported.length > 0) {
		throw new Error(
			`Unsupported external-agent scope${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
		);
	}
	return {
		apiKeyScopes: [
			"work:read",
			"work:write",
			...requested.filter((scope) => scope.startsWith("work:")),
		],
		aihScopes: requested.filter((scope) =>
			EXTERNAL_AGENT_AIH_SCOPES.has(scope),
		),
	};
}

function requiredString(
	value: unknown,
	label: string,
	context: string,
): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${context} returned no ${label}`);
	}
	return value;
}

function createGatewayClient(
	options: { headers: Record<string, string>; url: string },
	factory?: GatewayClientFactory,
): GatewayClient {
	return factory?.(options) ?? new TedixHomeClient(options);
}

function gatewayCode(namespace: string, tool: string, input: unknown): string {
	return `async () => await ${namespace}.${tool}(${JSON.stringify(input)})`;
}

async function callGatewayTool<T>(
	client: GatewayClient,
	namespace: string,
	tool: string,
	input: unknown,
	destructiveReason?: string,
): Promise<T> {
	const approvedInput =
		destructiveReason && isRecord(input)
			? {
					...input,
					confirmDestructive: true,
					reason: destructiveReason,
				}
			: input;
	const source = gatewayCode(namespace, tool, approvedInput);
	const normalized = normalizeCodeResult(
		destructiveReason && client.runCodeWithDestructiveApproval
			? await client.runCodeWithDestructiveApproval(source, destructiveReason)
			: await client.runCode(source),
	);
	if (normalized.truncated) {
		throw new Error(truncationErrorMessage(normalized));
	}
	if (
		isRecord(normalized.value) &&
		(normalized.value.ok === false ||
			(typeof normalized.value.status === "number" &&
				normalized.value.status >= 400))
	) {
		throw new Error(
			String(
				normalized.value.error ??
					normalized.value.message ??
					`${namespace}.${tool} was rejected`,
			),
		);
	}
	return normalized.value as T;
}

function resolveSessionTuple(input: {
	harness?: string;
	harnessVersion?: string;
	modelProvider?: string;
	modelId?: string;
	modelVersion?: string;
}): ExternalAgentSessionTuple {
	const detected = resolveExplicitAgentSession();
	const harness = input.harness?.trim() || detected.harness;
	const harnessVersion =
		input.harnessVersion?.trim() ||
		process.env.TEDIX_AGENT_HARNESS_VERSION?.trim();
	const modelProvider =
		input.modelProvider?.trim() ||
		process.env.TEDIX_AGENT_MODEL_PROVIDER?.trim();
	const modelId =
		input.modelId?.trim() || process.env.TEDIX_AGENT_MODEL_ID?.trim();
	const modelVersion =
		input.modelVersion?.trim() || process.env.TEDIX_AGENT_MODEL_VERSION?.trim();
	const missing = [
		["--agent-harness-version", harnessVersion],
		["--model-provider", modelProvider],
		["--model-id", modelId],
		["--model-version", modelVersion],
	]
		.filter(([, value]) => !value)
		.map(([flag]) => flag);
	if (missing.length) {
		throw new Error(
			`External-agent credit requires immutable harness/model versions. Missing: ${missing.join(", ")}.`,
		);
	}
	const explicitSession = process.env.TEDIX_AGENT_SESSION?.trim();
	const externalSessionKey =
		explicitSession && !explicitSession.includes(":")
			? `${harness}:${explicitSession}`
			: detected.session;
	return {
		externalSessionKey,
		harness,
		harnessVersion: harnessVersion as string,
		modelProvider: modelProvider as string,
		modelId: modelId as string,
		modelVersion: modelVersion as string,
	};
}

function resolveExplicitAgentSession(): NonNullable<
	ReturnType<typeof resolveAgentSession>
> & { derived: false } {
	const detected = resolveAgentSession();
	if (!detected || detected.derived) {
		throw new Error(
			"External-agent credit requires an explicit Agent-Session. Set TEDIX_AGENT_SESSION (or a native Codex/Claude/Cursor session id) before `tedix agent start`.",
		);
	}
	return { ...detected, derived: false };
}

async function resolveOrganization(options: {
	workspace: string;
	organization?: string;
	workspaceCredential: WorkspaceCredential;
	mcpUrl: string;
	client: Pick<GatewayClient, "runCode">;
	listWorkspaces?: () => Promise<AvailableWorkspace[]>;
}): Promise<{ id: string; mcpUrl: string }> {
	const organizations = options.listWorkspaces
		? await options.listWorkspaces()
		: await listAvailableWorkspaces({
				client: options.client as TedixHomeClient,
			});
	const tenant = options.workspaceCredential.org;
	const matches = organizations.filter((org) => {
		if (options.organization)
			return (
				org.org === options.organization ||
				org.slug === options.organization ||
				org.descopeTenantId === options.organization
			);
		if (tenant) return org.descopeTenantId === tenant;
		return org.slug === options.workspace || org.gatewayUrl === options.mcpUrl;
	});
	if (matches.length !== 1) {
		throw new Error(
			`Could not resolve workspace "${options.workspace}" to exactly one organization; run \`tedix orgs\` and re-login to the intended workspace.`,
		);
	}
	const match = matches[0]!;
	return { id: match.org, mcpUrl: match.gatewayUrl ?? options.mcpUrl };
}

function storedSession(
	exchange: ExternalAgentSessionExchangeOutput,
): StoredExternalAgentSession {
	return {
		id: exchange.session.id,
		externalSessionKey: exchange.session.externalSessionKey,
		harness: exchange.session.harness,
		harnessVersion: exchange.session.harnessVersion,
		modelProvider: exchange.session.modelProvider,
		modelId: exchange.session.modelId,
		modelVersion: exchange.session.modelVersion,
		startedAt: exchange.session.startedAt,
	};
}

async function exchangeSession(
	profile: StoredExternalAgentProfile,
	tuple: ExternalAgentSessionTuple,
	options: SessionExchangeOptions,
): Promise<ExternalAgentSessionExchangeOutput> {
	const timeoutMs = options.sessionExchangeTimeoutMs ?? 30_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			"Session exchange timeout must be a positive finite duration",
		);
	}
	const controller = new AbortController();
	try {
		return await withTimeout(
			exchangeSessionRequest(profile, tuple, options, controller.signal),
			timeoutMs,
			"External-agent credential exchange timed out. The local session is unchanged; server-side issuance may still finish. Retry shortly with the same session.",
		);
	} finally {
		controller.abort();
	}
}

async function exchangeSessionRequest(
	profile: StoredExternalAgentProfile,
	tuple: ExternalAgentSessionTuple,
	options: SessionExchangeOptions,
	signal: AbortSignal,
): Promise<ExternalAgentSessionExchangeOutput> {
	const endpoint = new URL("/external-agents/session", profile.mcpUrl);
	const request: RequestInit = {
		signal,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": profile.rawApiKey,
		},
		body: JSON.stringify({
			organizationId: profile.organizationId,
			principalId: profile.principalId,
			...tuple,
			metadata: { source: "tedix-cli" },
			scopes: profile.scopes,
			mcpServerUrl: profile.mcpUrl,
			clientName: `tedix-cli ${profile.key} ${tuple.harness}`,
		}),
	};
	const fetcher = options.fetch ?? fetch;
	let response: Response;
	let payload: unknown;
	let busyRetries = 0;
	let serverRetries = 0;
	for (;;) {
		// A network failure is ambiguous and is not retried.
		signal.throwIfAborted();
		response = await fetcher(endpoint, request);
		payload = await response.json().catch(() => undefined);
		signal.throwIfAborted();
		if (
			response.status === 409 &&
			isRecord(payload) &&
			payload.code === "credential_issuance_in_progress"
		) {
			// This exact rejection happens before issuance acquires its lock. Keep
			// retrying the identical idempotent session tuple until the existing
			// overall exchange deadline aborts the controller; a fixed retry count
			// failed healthy concurrent clients whenever issuance took >1.75s.
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(250 * 2 ** busyRetries, 2_000)),
			);
			busyRetries += 1;
			continue;
		}
		// Preserve the existing single retry for compensated server failures.
		if (response.status >= 500 && serverRetries < 1) {
			serverRetries += 1;
			await new Promise((resolve) => setTimeout(resolve, 250));
			continue;
		}
		break;
	}

	if (!response.ok) {
		const code =
			isRecord(payload) &&
			typeof payload.code === "string" &&
			[
				"credential_issuance_in_progress",
				"credential_binding_mismatch",
				"immutable_session_conflict",
				"principal_inactive",
				"principal_not_found",
				"session_ended",
			].includes(payload.code)
				? (payload.code as SessionExchangeRejectionCode)
				: undefined;
		throw new ExternalAgentSessionExchangeError(
			code,
			code === "credential_binding_mismatch" && response.status === 403
				? "Stored external-agent credential does not match the registered principal. Run `tedix agent status` and have an owner inspect the principal credential binding before retrying. The local session is unchanged."
				: isRecord(payload) && typeof payload.error === "string"
					? payload.error
					: `External-agent session exchange failed (${response.status})`,
		);
	}
	return ExternalAgentSessionExchangeOutputSchema.parse(payload);
}

function endedSessionRecoveryMessage(
	session: Pick<StoredExternalAgentSession, "externalSessionKey" | "harness">,
	staleLocalSessionRemoved: boolean,
): string {
	return [
		`External Agent-Session "${session.externalSessionKey}" has ended and cannot be reopened.`,
		...(staleLocalSessionRemoved
			? ["The stale local session was removed."]
			: []),
		"Start a fresh immutable session before retrying:",
		`  export TEDIX_AGENT_SESSION="${session.harness}:$(uuidgen | tr 'A-Z' 'a-z')"`,
		"  tedix agent start --agent-harness-version <version> --model-provider <provider> --model-id <id> --model-version <version>",
		"  export TEDIX_EXTERNAL_AGENT=<principal-key>",
	].join("\n");
}

async function exchangeStoredSession(
	workspace: string,
	profile: StoredExternalAgentProfile,
	stored: StoredExternalAgentSession,
	options: { fetch?: FetchLike },
): Promise<ExternalAgentSessionExchangeOutput> {
	try {
		return await exchangeSession(
			profile,
			{
				externalSessionKey: stored.externalSessionKey,
				harness: stored.harness,
				harnessVersion: stored.harnessVersion,
				modelProvider: stored.modelProvider,
				modelId: stored.modelId,
				modelVersion: stored.modelVersion,
			},
			options,
		);
	} catch (error) {
		if (
			error instanceof ExternalAgentSessionExchangeError &&
			error.code === "session_ended"
		) {
			removeExternalAgentSession(workspace, stored.externalSessionKey);
			throw new Error(endedSessionRecoveryMessage(stored, true), {
				cause: error,
			});
		}
		throw error;
	}
}

export async function startExternalAgentSession(
	options: StartExternalAgentOptions,
): Promise<{
	profile: StoredExternalAgentProfile;
	session: StoredExternalAgentSession;
}> {
	const tuple = resolveSessionTuple(options);
	return withExternalAgentStartLock(options.workspace, () =>
		startExternalAgentSessionLocked(options, tuple),
	);
}

async function startExternalAgentSessionLocked(
	options: StartExternalAgentOptions,
	tuple: ExternalAgentSessionTuple,
): Promise<{
	profile: StoredExternalAgentProfile;
	session: StoredExternalAgentSession;
}> {
	let profile = readExternalAgentProfile(options.workspace);
	if (profile && isMultiOrganizationMcpUrl(options.mcpUrl)) {
		const target = options.oauthBearer
			? resolveOrganizationTarget({
					url: options.mcpUrl,
					command: "agent",
					workspace: options.workspace,
					organization: options.organization,
					accessToken: options.oauthBearer,
				}).organization
			: (options.organization ?? process.env.TEDIX_ORGANIZATION?.trim());
		if (target && target !== profile.organizationId) {
			if (!options.oauthBearer || !options.workspaceCredential) {
				throw new Error(
					`This external-agent profile belongs to organization ${profile.organizationId}. Use --organization ${profile.organizationId}, or choose the profile for your intended organization.`,
				);
			}
			const ownerClient = createGatewayClient(
				{
					headers: {
						Authorization: `Bearer ${options.oauthBearer}`,
						"X-Tedix-Organization": target,
					},
					url: options.mcpUrl,
				},
				options.createClient,
			);
			try {
				const organization = await resolveOrganization({
					workspace: options.workspace,
					workspaceCredential: options.workspaceCredential,
					mcpUrl: options.mcpUrl,
					organization: target,
					client: ownerClient,
					listWorkspaces: options.listWorkspaces,
				});
				if (organization.id !== profile.organizationId) {
					throw new Error(
						`This external-agent profile belongs to organization ${profile.organizationId}, not ${organization.id}. Choose the profile for your intended organization.`,
					);
				}
			} finally {
				await ownerClient.close();
			}
		}
	}
	// Every harness session on a profile shares its principal and still gets its
	// own Agent-Session, so a different --agent-key is not a reason to fail.
	if (profile && options.agentKey && profile.key !== options.agentKey.trim()) {
		(options.notice ?? ((message) => console.error(message)))(
			`Notice: workspace "${options.workspace}" already uses external-agent principal "${profile.key}"; --agent-key "${options.agentKey.trim()}" was ignored. This run still gets its own Agent-Session.`,
		);
	}
	// Scopes are fixed when the principal is bootstrapped: the block below seeds
	// both the org API key and the AIH capability envelope, and neither is
	// re-issued for an existing profile. Silently ignoring --agent-scopes here
	// would hand an operator a confident "Started ..." line and LESS privilege
	// than they asked for — the exact failure a least-privilege system cannot
	// afford. Fail loudly instead, and say how to actually change the grant.
	if (profile && options.scopes) {
		const requested = [...new Set(options.scopes)].sort();
		const granted = [...new Set(profile.scopes ?? [])].sort();
		if (requested.join(",") !== granted.join(",")) {
			throw new Error(
				`External-agent principal "${profile.key}" already exists with scopes [${granted.join(", ")}]; ` +
					`--agent-scopes [${requested.join(", ")}] cannot be applied to an existing principal. ` +
					"Scopes are granted when the principal is bootstrapped. Rotate the principal, or change the scopes on its API key.",
			);
		}
	}
	if (!profile) {
		const local = defaultLocalPrincipal();
		const agentKey = options.agentKey?.trim() || local.key;
		const displayName = options.displayName?.trim() || local.displayName;
		if (!/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(agentKey)) {
			throw new Error(
				"--agent-key must be 1-120 letters, digits, underscores, or hyphens.",
			);
		}
		if (!options.oauthBearer || !options.workspaceCredential) {
			throw new Error(
				"A signed-in owner is required for first-time external-agent bootstrap.",
			);
		}
		const target = isMultiOrganizationMcpUrl(options.mcpUrl)
			? resolveOrganizationTarget({
					url: options.mcpUrl,
					command: "agent",
					workspace: options.workspace,
					organization: options.organization,
					accessToken: options.oauthBearer,
				})
			: { headers: {}, organization: undefined };
		const ownerClient = createGatewayClient(
			{
				headers: {
					Authorization: `Bearer ${options.oauthBearer}`,
					...target.headers,
				},
				url: options.mcpUrl,
			},
			options.createClient,
		);
		try {
			const organization = await resolveOrganization({
				workspace: options.workspace,
				organization: target.organization,
				workspaceCredential: options.workspaceCredential,
				mcpUrl: options.mcpUrl,
				client: ownerClient,
				listWorkspaces: options.listWorkspaces,
			});
			// API execution authority and MCP tool capabilities are different planes.
			// The binding key may operate the external-agent session and Work attempt;
			// it never receives platform authority. The issued AIH credential carries
			// the independently selected, resource-bound MCP capabilities.
			const requestedScopes = [...new Set(options.scopes ?? [])];
			const requested = resolveExternalAgentBootstrapScopes(requestedScopes);
			const scopes =
				requested.aihScopes.length > 0
					? requested.aihScopes
					: [...CAPABILITY_SCOPES, "connections.execute"];
			const apiKeyScopes = requested.apiKeyScopes;
			const createdKey = await callGatewayTool<Record<string, unknown>>(
				ownerClient,
				"organizations",
				"create_api_key",
				{
					organizationId: organization.id,
					name: `External agent ${agentKey}`,
					description:
						"Dedicated credential binding for gateway-verified external-agent sessions",
					scopes: [...new Set(apiKeyScopes)],
					environment: "live",
				},
			);
			const rawApiKey = requiredString(
				createdKey.rawKey,
				"raw API key",
				"create_api_key",
			);
			const apiKey = isRecord(createdKey.apiKey) ? createdKey.apiKey : null;
			const apiKeyId = requiredString(
				apiKey?.id,
				"API key id",
				"create_api_key",
			);
			let principal: Record<string, unknown>;
			try {
				principal = await callGatewayTool<Record<string, unknown>>(
					ownerClient,
					"external",
					"create_external_agent_principal",
					{
						organizationId: organization.id,
						key: agentKey,
						displayName,
						credentialBindingType: "api_key",
						credentialBindingId: apiKeyId,
						metadata: { provisionedBy: "tedix-cli" },
					},
				);
			} catch (error) {
				await callGatewayTool(
					ownerClient,
					"organizations",
					"revoke_api_key",
					{
						organizationId: organization.id,
						keyId: apiKeyId,
						reason: "External-agent principal bootstrap failed",
					},
					"Compensate a failed external-agent principal bootstrap",
				).catch(() => undefined);
				throw error;
			}
			profile = {
				organizationId: organization.id,
				principalId: requiredString(
					principal.id,
					"principal id",
					"create_external_agent_principal",
				),
				key: agentKey,
				displayName,
				apiKeyId,
				rawApiKey,
				scopes,
				mcpUrl: organization.mcpUrl,
				createdAt: new Date().toISOString(),
				sessions: {},
			};
			writeExternalAgentProfile(options.workspace, profile);
		} finally {
			await ownerClient.close();
		}
	}
	let exchange: ExternalAgentSessionExchangeOutput;
	try {
		exchange = await exchangeSession(profile, tuple, options);
	} catch (error) {
		if (
			error instanceof ExternalAgentSessionExchangeError &&
			error.code === "session_ended"
		) {
			const hadStoredSession = Boolean(
				profile.sessions[tuple.externalSessionKey],
			);
			removeExternalAgentSession(options.workspace, tuple.externalSessionKey);
			throw new Error(
				endedSessionRecoveryMessage(
					{
						externalSessionKey: tuple.externalSessionKey,
						harness: tuple.harness,
					},
					hadStoredSession,
				),
				{ cause: error },
			);
		}
		throw error;
	}
	const session = storedSession(exchange);
	profile = writeExternalAgentSession(options.workspace, profile, session);
	// Keep the just-issued credential ACTIVE — do not revoke it here. It stays
	// live so the session's first real operation reuses this exact Descope MCP
	// client (server-side reuse) instead of minting a fresh one. Session
	// teardown revokes it via end_external_agent_session; an abandoned session
	// falls to the external-agent-mcp-client-reaper once its token expires.
	return { profile, session };
}

export function externalAgentStatus(
	workspace: string,
): Record<string, unknown> {
	const profile = readExternalAgentProfile(workspace);
	if (!profile) return { configured: false, workspace };
	const current = resolveAgentSession();
	const session = current
		? findStoredSession(profile, current.session)
		: undefined;
	return {
		configured: true,
		workspace,
		principalId: profile.principalId,
		key: profile.key,
		displayName: profile.displayName,
		organizationId: profile.organizationId,
		mcpUrl: profile.mcpUrl,
		scopes: profile.scopes,
		currentSession: session ?? null,
		sessionCount: Object.keys(profile.sessions).length,
		credentialStored: true,
	};
}

function findStoredSession(
	profile: StoredExternalAgentProfile,
	resolvedSessionKey: string,
): StoredExternalAgentSession | undefined {
	const exact = profile.sessions[resolvedSessionKey];
	if (exact) return exact;
	const explicit = process.env.TEDIX_AGENT_SESSION?.trim();
	if (!explicit || explicit.includes(":")) return undefined;
	const matches = Object.values(profile.sessions).filter(
		(session) => session.externalSessionKey.split(":").at(-1) === explicit,
	);
	if (matches.length > 1) {
		throw new Error(
			`Agent-Session "${explicit}" is ambiguous across stored harnesses. Set TEDIX_AGENT_SESSION to the full <harness>:<id> key.`,
		);
	}
	return matches[0];
}

function currentSessionContext(workspace: string): {
	profile: StoredExternalAgentProfile;
	session: StoredExternalAgentSession;
} {
	const profile = readExternalAgentProfile(workspace);
	if (!profile) throw new Error("No external-agent profile is configured.");
	const current = resolveExplicitAgentSession();
	const session = findStoredSession(profile, current.session);
	if (!session) {
		throw new Error(`Agent-Session "${current.session}" has not been started.`);
	}
	return { profile, session };
}

export async function resolveExternalAgentAuth(options: {
	workspace: string;
	organization?: string;
	selector: string;
	fetch?: FetchLike;
	/** Overall credential-exchange deadline, including retries and response body. */
	sessionExchangeTimeoutMs?: number;
	createClient?: GatewayClientFactory;
}): Promise<AuthResolution> {
	const { profile, session: stored } = currentSessionContext(options.workspace);
	if (options.organization && options.organization !== profile.organizationId) {
		throw new Error(
			`This external-agent profile belongs to organization ${profile.organizationId}. Use --organization ${profile.organizationId}, or choose the profile for your intended organization.`,
		);
	}
	const selector = options.selector.trim();
	if (!/^(1|true)$/i.test(selector) && selector !== profile.key) {
		throw new Error(
			`TEDIX_EXTERNAL_AGENT selects "${selector}", but this workspace is bound to "${profile.key}".`,
		);
	}
	const cached = readExternalAgentCredential(
		options.workspace,
		profile,
		stored,
	);
	if (cached)
		return {
			headers: { "X-API-Key": cached },
			mcpUrl: profile.mcpUrl,
			source: `external-agent:${profile.key}:${stored.id}`,
		};
	const exchangeStartedAt = Date.now();
	const exchange = await exchangeStoredSession(
		options.workspace,
		profile,
		stored,
		options,
	);
	const session = storedSession(exchange);
	// Cache conservatively from request start, never from delayed response receipt.
	// The gateway still checks live principal/session authority on every call.
	if (
		session.id === stored.id &&
		exchange.credential.mcpServerUrl === profile.mcpUrl
	) {
		writeExternalAgentCredential(
			options.workspace,
			profile,
			stored,
			exchange.credential.accessToken,
			exchangeStartedAt +
				Math.min(exchange.credential.expiresIn * 1000, 300_000) -
				60_000,
		);
	}

	// No `cleanup` revoke: the credential stays active after use so the next
	// operation reuses THIS Descope MCP client (server-side reuse) instead of
	// minting a fresh one on every call — the source of the TPA over-minting.
	// Revocation happens only at session teardown (end_external_agent_session)
	// or via the external-agent-mcp-client-reaper for abandoned sessions.
	return {
		headers: { "X-API-Key": exchange.credential.accessToken },
		mcpUrl: profile.mcpUrl,
		source: `external-agent:${profile.key}:${session.id}`,
	};
}

async function withExternalAgentClient<T>(
	workspace: string,
	options: { fetch?: FetchLike; createClient?: GatewayClientFactory },
	action: (context: {
		client: GatewayClient;
		profile: StoredExternalAgentProfile;
		session: StoredExternalAgentSession;
	}) => Promise<T>,
): Promise<T> {
	// External-agent credentials are NOT revoked per operation — they persist so
	// the next call reuses the same Descope MCP client (server-side reuse).
	// Session teardown (end_external_agent_session) does the revocation.
	const { profile } = currentSessionContext(workspace);
	const auth = await resolveExternalAgentAuth({
		workspace,
		selector: profile.key,
		...options,
	});
	const client = createGatewayClient(
		{ headers: auth.headers, url: profile.mcpUrl },
		options.createClient,
	);
	const session = currentSessionContext(workspace).session;
	try {
		return await action({ client, profile, session });
	} finally {
		await client.close();
	}
}

export async function checkpointExternalAgentKnowledge(options: {
	workspace: string;
	idempotencyKey: string;
	workItemId: string;
	summary: string;
	evidenceRefs?: string[];
	artifactRef?: string;
	fetch?: FetchLike;
	/** Overall credential-exchange deadline, including retries and response body. */
	sessionExchangeTimeoutMs?: number;
	createClient?: GatewayClientFactory;
}): Promise<Record<string, unknown>> {
	return withExternalAgentClient(
		options.workspace,
		options,
		({ client, profile, session }) =>
			callGatewayTool(
				client,
				"external",
				"record_external_agent_knowledge_checkpoint",
				{
					organizationId: profile.organizationId,
					principalId: profile.principalId,
					sessionId: session.id,
					idempotencyKey: options.idempotencyKey,
					workItemId: options.workItemId,
					summary: options.summary,
					evidenceRefs: options.evidenceRefs ?? [],
					...(options.artifactRef ? { artifactRef: options.artifactRef } : {}),
				},
			),
	);
}

export async function finishExternalAgentSession(options: {
	workspace: string;
	idempotencyKey?: string;
	workItemId?: string;
	noHandoffReason?: string;
	zeroWorkReason?: string;
	fetch?: FetchLike;
	/** Overall credential-exchange deadline, including retries and response body. */
	sessionExchangeTimeoutMs?: number;
	createClient?: GatewayClientFactory;
	attemptStore?: WorkAttemptStore;
}): Promise<StoredExternalAgentSession> {
	if (options.noHandoffReason && options.zeroWorkReason) {
		throw new Error(
			"External Agent-Session finish accepts one knowledge disposition.",
		);
	}
	if (options.zeroWorkReason && options.workItemId) {
		throw new Error("Zero-work finish must not reference a Work Item.");
	}
	if (
		options.noHandoffReason &&
		(!options.idempotencyKey || !options.workItemId)
	) {
		throw new Error(
			"Explicit no-handoff finish requires a work item id and --idempotency-key.",
		);
	}
	if (options.zeroWorkReason && !options.idempotencyKey) {
		throw new Error("Zero-work finish requires --idempotency-key.");
	}
	let ended = false;
	const attemptStore = options.attemptStore ?? createFileWorkAttemptStore();
	const session = await withExternalAgentClient(
		options.workspace,
		options,
		async ({ client, profile, session }) => {
			if (options.noHandoffReason) {
				await callGatewayTool(
					client,
					"external",
					"record_external_agent_knowledge_disposition",
					{
						organizationId: profile.organizationId,
						principalId: profile.principalId,
						sessionId: session.id,
						type: "no_handoff",
						idempotencyKey: options.idempotencyKey,
						workItemId: options.workItemId,
						reason: options.noHandoffReason,
					},
				);
			}
			let settleError: unknown;
			if (options.workItemId) {
				const attemptKey = {
					workspace: options.workspace,
					actor: "credential",
					agentSession: session.externalSessionKey,
					workItemId: options.workItemId,
				};
				const attemptId = attemptStore.get(attemptKey);
				if (attemptId) {
					try {
						await callGatewayTool(client, "work", "settle_work_item_attempt", {
							id: options.workItemId,
							attemptId,
							outcome: "cancelled",
							summary:
								"External Agent-Session ended with an unfinished attempt.",
						});
						attemptStore.remove(attemptKey, attemptId);
					} catch (error) {
						settleError = error;
					}
				}
			}
			try {
				await callGatewayTool(
					client,
					"external",
					"end_external_agent_session",
					{
						organizationId: profile.organizationId,
						principalId: profile.principalId,
						sessionId: session.id,
						...(options.zeroWorkReason
							? {
									zeroWorkDisposition: {
										idempotencyKey: options.idempotencyKey,
										reason: options.zeroWorkReason,
									},
								}
							: {}),
					},
					"End the current external Agent-Session",
				);
			} catch (endError) {
				if (settleError) {
					throw new Error(
						`Could not settle the Work Item attempt (${errorText(settleError)}) or end the external Agent-Session (${errorText(endError)}).`,
					);
				}
				throw endError;
			}
			ended = true;
			return session;
		},
	);
	if (ended)
		removeExternalAgentSession(options.workspace, session.externalSessionKey);
	return session;
}

/**
 * Renames this profile's principal for the people reading the board. The key
 * is immutable: commit provenance and every stored session refer to it.
 */
export async function renameExternalAgentPrincipal(options: {
	workspace: string;
	oauthBearer: string;
	/** Gateway the owner's login belongs to; a Connect token is not valid elsewhere. */
	mcpUrl?: string;
	organization?: string;
	displayName?: string;
	createClient?: GatewayClientFactory;
}): Promise<{ key: string; displayName: string; previous: string }> {
	const profile = readExternalAgentProfile(options.workspace);
	if (!profile) throw new Error("No external-agent profile is configured.");
	const displayName =
		options.displayName?.trim() || defaultLocalPrincipal().displayName;
	const url = options.mcpUrl ?? profile.mcpUrl;
	const target = isMultiOrganizationMcpUrl(url)
		? resolveOrganizationTarget({
				url,
				command: "agent",
				workspace: options.workspace,
				organization: options.organization,
				accessToken: options.oauthBearer,
			})
		: { headers: {} };
	const client = createGatewayClient(
		{
			headers: {
				Authorization: `Bearer ${options.oauthBearer}`,
				...target.headers,
			},
			url,
		},
		options.createClient,
	);
	try {
		const renamed = await callGatewayTool<Record<string, unknown>>(
			client,
			"external",
			"rename_external_agent_principal",
			{
				organizationId: profile.organizationId,
				principalId: profile.principalId,
				displayName,
			},
		);
		const stored = requiredString(
			renamed.displayName,
			"display name",
			"rename_external_agent_principal",
		);
		writeExternalAgentProfile(options.workspace, {
			...profile,
			displayName: stored,
		});
		return {
			key: profile.key,
			displayName: stored,
			previous: profile.displayName,
		};
	} finally {
		await client.close();
	}
}

export async function listStaleExternalAgentKnowledgeSessions(options: {
	workspace: string;
	oauthBearer: string;
	staleBefore: string;
	limit?: number;
	createClient?: GatewayClientFactory;
}): Promise<Record<string, unknown>[]> {
	const profile = readExternalAgentProfile(options.workspace);
	if (!profile) throw new Error("No external-agent profile is configured.");
	const client = createGatewayClient(
		{
			headers: { Authorization: `Bearer ${options.oauthBearer}` },
			url: profile.mcpUrl,
		},
		options.createClient,
	);
	try {
		return await callGatewayTool(
			client,
			"external",
			"list_stale_external_agent_knowledge_sessions",
			{
				organizationId: profile.organizationId,
				staleBefore: options.staleBefore,
				limit: options.limit ?? 100,
			},
		);
	} finally {
		await client.close();
	}
}

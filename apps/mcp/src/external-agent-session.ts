import {
	callRpc,
	RpcCallError,
	serviceBindingFetch,
} from "@tedix/api-client/internal";
import {
	EXTERNAL_AGENT_SESSION_EXCHANGE_CALLER,
	EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER,
	ExternalAgentSessionExchangeInputSchema,
	ExternalAgentSessionExchangeOutputSchema,
} from "@tedix/api-contract/contracts/external-agent-identity";

const RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"Content-Type": "application/json",
} as const;

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: RESPONSE_HEADERS,
	});
}

type SessionExchangeRejectionCode =
	| "session_backend_unavailable"
	| "credential_issuance_in_progress"
	| "credential_binding_mismatch"
	| "immutable_session_conflict"
	| "principal_inactive"
	| "principal_not_found"
	| "session_ended";

function sessionExchangeRejectionCode(
	error: RpcCallError,
): SessionExchangeRejectionCode | undefined {
	if (error.status === 503) return "session_backend_unavailable";
	if (
		error.status === 403 &&
		(error.path === "externalAgentIdentity/openSession" ||
			error.path === "externalAgentIdentity/issueMcpCredential")
	) {
		let message = error.detail;
		try {
			const parsed: unknown = JSON.parse(error.detail);
			if (parsed && typeof parsed === "object" && "message" in parsed) {
				message = typeof parsed.message === "string" ? parsed.message : "";
			}
		} catch {
			// Plain RPC error messages are also supported; no detail is returned.
		}
		if (
			message ===
			"Authenticated credential is not bound to this external-agent principal"
		) {
			return "credential_binding_mismatch";
		}
	}
	const detail = error.detail.toLowerCase();
	if (
		error.status === 409 &&
		error.path === "externalAgentIdentity/issueMcpCredential" &&
		detail.includes(
			"mcp credential issuance is already in progress for this session and resource",
		)
	) {
		return "credential_issuance_in_progress";
	}

	if (detail.includes("has ended and cannot be reopened")) {
		return "session_ended";
	}
	if (
		detail.includes("already bound to a different principal, harness, or model")
	) {
		return "immutable_session_conflict";
	}
	if (detail.includes("external-agent principal not found")) {
		return "principal_not_found";
	}
	if (detail.includes("external-agent principal is")) {
		return "principal_inactive";
	}
	return undefined;
}

export async function handleExternalAgentSessionExchange(
	request: Request,
	env: Pick<CloudflareEnv, "API_SERVICE">,
): Promise<Response> {
	if (request.method !== "POST") {
		return jsonResponse({ error: "Method not allowed" }, 405);
	}
	if (!env.API_SERVICE) {
		return jsonResponse({ error: "Session exchange unavailable" }, 503);
	}
	const rawApiKey = request.headers.get("X-API-Key")?.trim();
	const authorization = request.headers.get("Authorization")?.trim();
	const subjectToken = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: undefined;
	if ((rawApiKey?.startsWith("sk_") ? 1 : 0) + (subjectToken ? 1 : 0) !== 1) {
		return jsonResponse(
			{ error: "Exactly one X-API-Key or Bearer workload token is required" },
			401,
		);
	}

	let input: unknown;
	try {
		input = await request.json();
	} catch {
		return jsonResponse({ error: "Invalid JSON body" }, 400);
	}
	const parsed = ExternalAgentSessionExchangeInputSchema.safeParse(input);
	if (!parsed.success) {
		return jsonResponse({ error: "Invalid session exchange request" }, 400);
	}

	const baseHeaders = { "X-Service-Binding": "true" };
	try {
		const sessionInput = {
			organizationId: parsed.data.organizationId,
			principalId: parsed.data.principalId,
			externalSessionKey: parsed.data.externalSessionKey,
			harness: parsed.data.harness,
			harnessVersion: parsed.data.harnessVersion,
			modelProvider: parsed.data.modelProvider,
			modelId: parsed.data.modelId,
			modelVersion: parsed.data.modelVersion,
			metadata: parsed.data.metadata,
		};
		let session: unknown;
		let issueHeaders: Record<string, string>;
		if (subjectToken) {
			const authorizationResult = (await callRpc(
				"externalAgentIdentity/authorizeWorkloadSession",
				{ ...sessionInput, subjectToken, scopes: parsed.data.scopes },
				{
					apiUrl: "https://api",
					fetch: serviceBindingFetch(env.API_SERVICE),
					headers: {
						...baseHeaders,
						"X-Tedix-Caller-Type": EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER,
					},
				},
			)) as { session: unknown; grantToken: string };
			session = authorizationResult.session;
			issueHeaders = {
				...baseHeaders,
				"X-Tedix-Caller-Type": EXTERNAL_AGENT_WORKLOAD_EXCHANGE_CALLER,
				"X-Tedix-External-Agent-Workload-Grant": authorizationResult.grantToken,
			};
		} else {
			issueHeaders = {
				...baseHeaders,
				"X-API-Key": rawApiKey!,
				"X-Tedix-Caller-Type": EXTERNAL_AGENT_SESSION_EXCHANGE_CALLER,
			};
			session = await callRpc(
				"externalAgentIdentity/openSession",
				sessionInput,
				{
					apiUrl: "https://api",
					fetch: serviceBindingFetch(env.API_SERVICE),
					headers: issueHeaders,
				},
			);
		}
		const credential = await callRpc(
			"externalAgentIdentity/issueMcpCredential",
			{
				organizationId: parsed.data.organizationId,
				principalId: parsed.data.principalId,
				sessionId: (session as { id: string }).id,
				scopes: parsed.data.scopes,
				mcpServerUrl: parsed.data.mcpServerUrl,
				clientName: parsed.data.clientName,
			},
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: issueHeaders,
			},
		);
		const output = ExternalAgentSessionExchangeOutputSchema.parse({
			session,
			credential,
		});
		return jsonResponse(output, 201);
	} catch (error) {
		const status = error instanceof RpcCallError ? error.status : 502;
		const code =
			error instanceof RpcCallError
				? sessionExchangeRejectionCode(error)
				: undefined;
		return jsonResponse(
			{
				error:
					code === "credential_binding_mismatch"
						? "External-agent credential does not match the registered principal"
						: code === "session_backend_unavailable"
							? "Session backend unavailable; retry shortly with the same session"
							: code === "credential_issuance_in_progress"
								? "Credential issuance is busy; retry shortly"
								: status >= 500
									? "Session exchange failed"
									: "Session exchange rejected",
				...(code ? { code } : {}),
			},
			status,
		);
	}
}

import { isPlainRecord } from "./handler-log-redaction";
import {
	ExternalRequestInputError,
	expandExternalBodyTemplate,
	setHeaderIfMissing,
	buildMultipartBody,
	buildUrlEncodedBody,
	fileParamsFromConfig,
	stringParamsFromConfig,
	applyMcpCustomHeaders,
	consumeNamedParams,
	textExternalRequestBody,
	parseExternalResponse,
} from "./handler-external-request";
import { readToolConfigExtension } from "./tool-config-extensions";
import { type ToolConfig } from "@tedix/api-contract/schemas/tools";
import { getByPath } from "./handlers/path-utils";
import { validateUrl } from "@tedix/ssrf-guard";
import {
	resolveEmbeddedHostDelegation,
	redactDelegationResponse,
} from "./embedded-host-delegation";
import { buildQueryString } from "./utils/query-params";
import { applyWorkflowExecutionHeaders } from "./workflow-execution-headers";
import {
	buildCredentialErrorData,
	buildCredentialErrorMessage,
	buildCredentialRecovery,
	fetchConnectionToken,
	fetchOrgConnectionToken,
	getClientCredentialsCacheKey,
	resolveClientCredentialsToken,
	selectedConnectionInstanceId,
} from "./handler-connection-credentials";
import type { ToolExecutionContext, RpcToolResult } from "./handler";

/** Only allow safe path characters in endpoint — no traversal, query strings, or fragments.
 * Allows : for path params (e.g., monitors/:id) which are interpolated before the request. */
const SAFE_ENDPOINT_RE = /^[a-zA-Z0-9_\-/.:]+$/;

/** Validate external URL — prevents SSRF against internal services */
function validateExternalUrl(baseUrl: string, isDev: boolean): string | null {
	// In dev, also allow tedix-owned hosts (e.g. retail-bench.tedix.tech) so
	// external tools can reach our own tunnel'd dev services; prod stays locked
	// (allowInternalHosts is false unless isDev). Private/loopback IPs always blocked.
	return validateUrl(baseUrl, { allowHttp: isDev, allowInternalHosts: isDev });
}

function attachExternalSourceProvenance(
	data: unknown,
	requestUrl: string,
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
): unknown {
	const declared = config.sourceProvenance;
	if (!declared) return data;

	const provenance = {
		provider: declared.provider ?? new URL(requestUrl).hostname,
		sourceUrl: requestUrl,
		...(declared.documentationUrl
			? { documentationUrl: declared.documentationUrl }
			: {}),
		queriedAt: new Date().toISOString(),
		appId: ctx.app.id,
		appSlug: ctx.app.slug,
		organizationId:
			ctx.callerIdentity?.organizationId ?? ctx.app.organizationId ?? null,
		tediId: ctx.callerIdentity?.tediId ?? null,
		userId: ctx.callerIdentity?.userId ?? null,
		toolId: ctx.toolId,
		traceId: ctx.traceId ?? null,
		executionId: ctx.executionId ?? ctx.requestId,
		...(declared.rateBudget ? { rateBudget: declared.rateBudget } : {}),
	};

	if (data && typeof data === "object" && !Array.isArray(data)) {
		return {
			...(data as Record<string, unknown>),
			_tedixProvenance: provenance,
		};
	}
	return { data, _tedixProvenance: provenance };
}

export async function executeExternalTransport(
	input: Record<string, unknown>,
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
	endpoint: string,
	credentials: {
		fetchConnectionToken: typeof fetchConnectionToken;
		fetchOrgConnectionToken: typeof fetchOrgConnectionToken;
	},
): Promise<RpcToolResult> {
	const isDev = ctx.env.ENVIRONMENT === "development";
	const timeout = config.timeout ?? 15000;

	if (!config.baseUrl) {
		return {
			data: { error: "No baseUrl configured for external transport" },
			status: 400,
		};
	}

	// Validate endpoint characters — external endpoints hit third-party APIs
	// so we restrict to safe path characters only
	const endpointTemplate = endpoint.replace(
		/\{[a-zA-Z_][\w-]*\}/g,
		"path_parameter",
	);
	if (endpoint !== "" && !SAFE_ENDPOINT_RE.test(endpointTemplate)) {
		return {
			data: { error: "Invalid endpoint path characters" },
			status: 400,
		};
	}

	// SSRF protection
	const urlError = validateExternalUrl(config.baseUrl, isDev);
	if (urlError) {
		return {
			data: { error: `Invalid external URL: ${urlError}` },
			status: 400,
		};
	}

	let delegation: Awaited<ReturnType<typeof resolveEmbeddedHostDelegation>>;
	try {
		delegation = await resolveEmbeddedHostDelegation(ctx, config);
	} catch {
		return {
			data: { error: "Embedded host delegation denied" },
			status: 403,
		};
	}

	// Build params
	const params: Record<string, unknown> = { ...config.staticParams };
	if (config.paramMap) {
		for (const [inputKey, targetKey] of Object.entries(config.paramMap)) {
			const value = input[inputKey];
			if (value !== undefined) params[targetKey] = value;
		}
	} else {
		Object.assign(params, input);
	}

	// Signed host constraints and other runtime-only inputs belong to Tedix
	// policy, not the provider's REST contract. Remove them before any path,
	// header, query, or body projection can forward them.
	for (const name of stringParamsFromConfig(config, "runtimeOnlyParams")) {
		delete params[name];
	}

	// OpenAPI uses {parameter-name}; hand-authored tools also use :paramName.
	// Consumed path params are removed from the params object so they don't appear in query string or body
	let resolvedEndpoint = endpoint;
	const pathParamRe = /\{([a-zA-Z_][\w-]*)\}|:([a-zA-Z_]\w*)/g;
	for (const m of endpoint.matchAll(pathParamRe)) {
		const paramName = (m[1] ?? m[2]) as string;
		const value = params[paramName];
		if (value !== undefined && value !== null) {
			const caseRule = config.pathParamCase?.[paramName];
			const pathValue =
				caseRule === "lower"
					? String(value).toLowerCase()
					: caseRule === "upper"
						? String(value).toUpperCase()
						: String(value);
			resolvedEndpoint = resolvedEndpoint.replace(
				m[0],
				encodeURIComponent(pathValue),
			);
			delete params[paramName];
		} else if (m[1]) {
			return {
				data: { error: `Missing REST path parameter: ${paramName}` },
				status: 400,
			};
		}
	}
	endpoint = resolvedEndpoint;

	// NOTE: Do not call enforceContextParams() here. External transport sends
	// params directly to third-party REST APIs (Neo4j, accounting APIs, etc.) which
	// may reject or misroute on unknown fields like appId/tediId.
	// Cross-scope security is handled by the auth layer (connection tokens are
	// org-scoped via callerIdentity) — same rationale as MCP transport.

	// Build headers, then let the request body encoder set Content-Type.
	const headers: Record<string, string> = {};
	let delegatedTransportToken: string | undefined;

	if (delegation) {
		const credentialResult = await credentials.fetchOrgConnectionToken(
			{
				...ctx,
				// The API has verified this exact source/installation/callable.
				// Carry only its bounded credential-read capability and worker
				// provenance, never the caller's broader scopes or human identity.
				callerIdentity: {
					...ctx.callerIdentity!,
					authType: "service",
					scopes: ["connections.execute"],
					userId: undefined,
					kernel: false,
				},
			},
			delegation.connectionProviderId,
			delegation.providerOrganizationId,
			"tenant",
			delegation.connectionScopes,
		);
		if (!credentialResult.token)
			return {
				data: { error: buildCredentialErrorMessage(credentialResult) },
				status: 401,
			};
		delegatedTransportToken = credentialResult.token;
	} else if (config.auth) {
		if (config.auth.type === "connection" && config.auth.connectionId) {
			// _aggregateConnectionLabel is a legacy routing hint for stored
			// aggregator metadata. New apps should use project-specific outbound
			// app IDs in auth.connectionId.
			const effectiveLabel =
				(readToolConfigExtension(config, "_aggregateConnectionLabel") as
					| string
					| undefined) ?? ctx.connectionLabel;
			const credentialResult = await credentials.fetchConnectionToken(
				ctx,
				config.auth.connectionId,
				config.auth.credentialScope ?? config.auth.scope,
				config.auth.scopes,
				effectiveLabel,
				config.auth.credentialPreference,
				params,
			);
			if (!credentialResult.token) {
				return {
					data: buildCredentialErrorData(credentialResult, {
						preference: config.auth.credentialPreference,
						providerId: config.auth.connectionId,
						connectionInstanceId: selectedConnectionInstanceId(ctx),
						scope: config.auth.credentialScope ?? config.auth.scope,
						scopes: config.auth.scopes,
					}),
					status: 401,
					connectionRecovery: buildCredentialRecovery(credentialResult, {
						providerId: config.auth.connectionId,
						connectionInstanceId: selectedConnectionInstanceId(ctx),
						scope: config.auth.credentialScope ?? config.auth.scope ?? "tenant",
						scopes: config.auth.scopes,
					}),
				};
			}

			let token = credentialResult.token;

			// OAuth2 client credentials exchange: stored credential is base64(client_id:client_secret),
			// exchange it for a bearer token via the provider's token endpoint.
			if (config.auth.clientCredentials?.tokenUrl) {
				const ccCacheKey = getClientCredentialsCacheKey(
					ctx.callerIdentity?.tediId ??
						ctx.callerIdentity?.organizationId ??
						"",
					config.auth.connectionId,
					config.auth.clientCredentials.tokenUrl,
					effectiveLabel,
				);
				const result = await resolveClientCredentialsToken(
					credentialResult.token,
					config.auth.clientCredentials.tokenUrl,
					config.auth.clientCredentials.grantType ?? "client_credentials",
					ccCacheKey,
					isDev,
				);
				if (!result.token) {
					return {
						data: {
							error: result.error ?? "Client credentials exchange failed",
						},
						status: 401,
					};
				}
				token = result.token;
			}

			const headerName = config.auth.header ?? "Authorization";
			const template = config.auth.template ?? "Bearer {token}";
			const finalToken =
				config.auth.encoding === "base64" ? btoa(token) : token;
			headers[headerName] = template.replace("{token}", finalToken);
		} else if (config.auth.type === "header" && config.auth.value) {
			const headerName = config.auth.header ?? "Authorization";
			headers[headerName] = config.auth.value;
		}
	}

	// Merge static headers — support {paramName} placeholders resolved from input
	if (config.staticHeaders) {
		for (const [name, value] of Object.entries(config.staticHeaders)) {
			const resolved = value.replace(/\{(\w+)\}/g, (_, key: string) => {
				const v = params[key];
				if (v !== undefined && v !== null) {
					delete params[key]; // consume like path params
					return String(v);
				}
				return "";
			});
			if (resolved) headers[name] = resolved;
		}
	}

	const headerParams = consumeNamedParams(
		params,
		stringParamsFromConfig(config, "headerParams"),
	);
	for (const [name, value] of Object.entries(headerParams)) {
		headers[name] = String(value);
	}
	// Tedix-private x-mcp-header: config-declared custom headers (external).
	applyMcpCustomHeaders(headers, config, params);
	// A provider header is exclusively derived from verified private metadata.
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === "x-tedix-host-delegation") delete headers[name];
	}
	if (delegation) {
		headers["X-Tedix-Host-Delegation"] = delegation.token;
		headers[delegation.authHeader] = delegation.authTemplate.replace(
			"{token}",
			delegatedTransportToken!,
		);
	}
	applyWorkflowExecutionHeaders(headers, ctx.callerIdentity, {
		includeTedixProvenance: false,
	});
	const explicitQueryParams = consumeNamedParams(
		params,
		stringParamsFromConfig(config, "queryParams"),
	);

	const method = config.method ?? "POST";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	// Gmail RFC 5322 encoding transform — supports send, reply, reply_all, forward.
	// For reply/reply_all/forward: auto-resolves To, Subject, threadId, In-Reply-To,
	// and References by fetching the original message when params.messageId is set.
	if (config.bodyEncoding === "gmail-rfc2822") {
		const isDraft = Boolean(params.draft);
		const isHtml = Boolean(params.html);
		const inputMessageId = params.messageId ? String(params.messageId) : null;
		const authHeader = headers.Authorization ?? "";

		// Mutable reply metadata — overridden from original message lookup when messageId present
		let toAddr = String(params.to ?? "");
		let ccAddr = params.cc ? String(params.cc) : null;
		const fromAddr = params.from ? String(params.from) : null;
		let subject = String(params.subject ?? "");
		let inReplyTo: string | null = null;
		let references: string | null = null;
		let threadId = params.threadId ? String(params.threadId) : null;

		if (inputMessageId) {
			// Fetch original message metadata to auto-populate reply headers
			try {
				const metadataResp = await globalThis.fetch(
					`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(inputMessageId)}?format=metadata&metadataHeaders=From,To,Cc,Subject,Message-ID,References,Reply-To`,
					{
						headers: { Authorization: authHeader },
						signal: controller.signal,
					},
				);
				if (metadataResp.ok) {
					const msgData = (await metadataResp.json()) as {
						threadId?: string;
						payload?: { headers?: Array<{ name: string; value: string }> };
					};
					// Normalize headers to lowercase map
					const hdrs: Record<string, string> = {};
					for (const h of msgData.payload?.headers ?? []) {
						hdrs[h.name.toLowerCase()] = h.value;
					}

					// Thread ID
					if (!threadId && msgData.threadId) threadId = msgData.threadId;

					// Reply target: prefer Reply-To, fall back to From
					if (!toAddr) toAddr = hdrs["reply-to"] ?? hdrs.from ?? "";

					// Subject: add Re: prefix if not already present
					if (!subject && hdrs.subject) {
						const orig = hdrs.subject;
						subject = /^re:\s/i.test(orig) ? orig : `Re: ${orig}`;
					}

					// In-Reply-To + References chain
					const origMsgId = hdrs["message-id"] ?? "";
					if (origMsgId) {
						inReplyTo = origMsgId;
						const origRefs = hdrs.references ?? "";
						references = origRefs ? `${origRefs} ${origMsgId}` : origMsgId;
					}

					// gmail_reply_all: include original To + Cc in recipient list
					if (ctx.toolId === "gmail_reply_all") {
						const origTo = hdrs.to ?? "";
						const origCc = hdrs.cc ?? "";
						const combined = [toAddr, origTo, origCc, ccAddr]
							.filter(Boolean)
							.join(", ");
						// Deduplicate by lowercased address
						const seen = new Set<string>();
						const deduped = combined.split(/,\s*/).filter((addr) => {
							const norm = addr.trim().toLowerCase();
							if (!norm || seen.has(norm)) return false;
							seen.add(norm);
							return true;
						});
						toAddr = deduped.join(", ");
						ccAddr = null; // merged into To
					}
				}
			} catch {
				// Non-fatal: proceed with whatever caller-supplied values we have
			}
		}

		const body = String(params.body ?? "");
		const bcc = params.bcc ? String(params.bcc) : null;

		const lines: string[] = [
			...(fromAddr ? [`From: ${fromAddr}`] : []),
			`To: ${toAddr}`,
			`Subject: ${subject}`,
			`MIME-Version: 1.0`,
			`Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
		];
		if (ccAddr) lines.push(`Cc: ${ccAddr}`);
		if (bcc) lines.push(`Bcc: ${bcc}`);
		if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
		if (references) lines.push(`References: ${references}`);
		lines.push("", body);

		const raw = btoa(unescape(encodeURIComponent(lines.join("\r\n"))))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

		let gmailUrl: string;
		let gmailBody: string;
		if (method === "PUT" && endpoint.includes("/drafts/")) {
			gmailUrl = `${config.baseUrl}/${endpoint}`;
			gmailBody = JSON.stringify({
				message: { raw, ...(threadId ? { threadId } : {}) },
			});
		} else if (isDraft) {
			gmailUrl = `${config.baseUrl}/gmail/v1/users/me/drafts`;
			gmailBody = JSON.stringify({
				message: { raw, ...(threadId ? { threadId } : {}) },
			});
		} else {
			gmailUrl = `${config.baseUrl}/gmail/v1/users/me/messages/send`;
			gmailBody = JSON.stringify({ raw, ...(threadId ? { threadId } : {}) });
		}

		const resp = await globalThis.fetch(gmailUrl, {
			method:
				method === "PUT" && endpoint.includes("/drafts/") ? "PUT" : "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: gmailBody,
			signal: controller.signal,
		});
		clearTimeout(timer);
		const respData = await resp.json().catch(() => ({}));
		const providerMessageId =
			ctx.toolId === "gmail_send" &&
			!isDraft &&
			resp.ok &&
			respData !== null &&
			typeof respData === "object" &&
			!Array.isArray(respData) &&
			typeof (respData as Record<string, unknown>).id === "string" &&
			/^[A-Za-z0-9_-]{1,128}$/.test(
				(respData as Record<string, unknown>).id as string,
			)
				? ((respData as Record<string, unknown>).id as string)
				: null;
		return {
			data: respData,
			status: resp.status,
			...(providerMessageId
				? { providerConfirmation: `gmail-message:${providerMessageId}` }
				: {}),
		};
	}

	// Gmail draft send — POSTs {id} in body alongside path param.
	// The drafts.send endpoint requires Content-Type: application/json
	// with {"id": draftId} in the body; pure path-param POST returns 404.
	if (config.bodyEncoding === "gmail-draft-send") {
		// Gmail drafts.send: POST to /gmail/v1/users/me/drafts/send with {"id": draftId} body.
		// The Discovery spec has no path param — id goes in body only.
		const draftId = String(params.id ?? "");
		if (!draftId) {
			return {
				data: { error: "Missing required parameter: id" },
				status: 400,
			};
		}
		const sendUrl = `${config.baseUrl}/gmail/v1/users/me/drafts/send`;
		const sendResp = await globalThis.fetch(sendUrl, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ id: draftId }),
			signal: controller.signal,
		});
		clearTimeout(timer);
		const sendStatus = sendResp.status;
		const sendContentType = sendResp.headers.get("content-type") ?? "";
		let sendData: unknown;
		if (sendContentType.includes("application/json")) {
			sendData = await sendResp.json().catch(() => ({}));
		} else {
			// Return status + raw text snippet for debugging non-JSON responses
			const text = await sendResp.text().catch(() => "");
			sendData = {
				error: `HTTP ${sendStatus}`,
				contentType: sendContentType,
				snippet: text.slice(0, 300),
			};
		}
		return { data: sendData, status: sendStatus };
	}

	try {
		let url: string;
		let fetchInit: RequestInit;

		if (method === "GET") {
			const queryString = buildQueryString(
				{
					...explicitQueryParams,
					...params,
				},
				config.queryArrayFormats,
			);
			url = `${config.baseUrl}/${endpoint}${queryString ? `?${queryString}` : ""}`;
			fetchInit = { method, headers, signal: controller.signal };
		} else {
			const requestBodyParam =
				typeof config.requestBodyParam === "string"
					? config.requestBodyParam
					: null;
			if (config.requestBodyTemplate !== undefined) {
				if (!requestBodyParam) {
					throw new ExternalRequestInputError(
						"requestBodyTemplate requires requestBodyParam",
					);
				}
				if (params[requestBodyParam] !== undefined) {
					throw new ExternalRequestInputError(
						`Input must not override fixed request body: ${requestBodyParam}`,
					);
				}
				params[requestBodyParam] = expandExternalBodyTemplate(
					config.requestBodyTemplate,
					params,
				);
				for (const name of config.requestBodyTemplateParams ?? []) {
					delete params[name];
				}
			}
			const bodyParams =
				requestBodyParam && Object.hasOwn(params, requestBodyParam)
					? params[requestBodyParam]
					: params;
			if (requestBodyParam) {
				delete params[requestBodyParam];
			}
			const queryString = buildQueryString(
				{
					...explicitQueryParams,
					...(requestBodyParam ? params : {}),
				},
				config.queryArrayFormats,
			);
			url = `${config.baseUrl}/${endpoint}${queryString ? `?${queryString}` : ""}`;
			const requestContentType =
				config.requestContentType ?? "application/json";
			let body: BodyInit;
			if (requestContentType === "multipart/form-data") {
				body = await buildMultipartBody(
					isPlainRecord(bodyParams) ? bodyParams : params,
					fileParamsFromConfig(config),
				);
			} else if (requestContentType === "application/x-www-form-urlencoded") {
				body = buildUrlEncodedBody(
					isPlainRecord(bodyParams) ? bodyParams : params,
				);
				setHeaderIfMissing(
					headers,
					"Content-Type",
					"application/x-www-form-urlencoded",
				);
			} else if (
				requestContentType === "text/markdown" ||
				requestContentType === "text/plain"
			) {
				body = textExternalRequestBody(bodyParams);
				setHeaderIfMissing(headers, "Content-Type", requestContentType);
			} else {
				body = JSON.stringify(bodyParams);
				setHeaderIfMissing(headers, "Content-Type", requestContentType);
			}
			fetchInit = {
				method,
				headers,
				body,
				signal: controller.signal,
			};
		}

		if (isDev) {
			console.log(`[external-handler] ${method} ${url}`);
		}

		// Retry transient upstream-unreachable failures: gateway/connection
		// codes where the request did not reach the origin (502/504 + the
		// Cloudflare tunnel family 520-524). Common when an external origin
		// sits behind a flaky tunnel. Safe to replay because the origin never
		// processed the request; 4xx and 500 are not retried (they won't
		// recover / may have taken effect).
		const RETRYABLE_UPSTREAM = new Set([502, 504, 520, 521, 522, 523, 524]);
		let response = await globalThis.fetch(url, {
			...fetchInit,
			redirect: "manual",
		});
		for (
			let attempt = 0;
			attempt < 2 && RETRYABLE_UPSTREAM.has(response.status);
			attempt++
		) {
			if (isDev) {
				console.log(
					`[external-handler] ${url} → ${response.status}, retry ${attempt + 1}/2`,
				);
			}
			await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
			response = await globalThis.fetch(url, {
				...fetchInit,
				redirect: "manual",
			});
		}
		const status = response.status;

		// Block redirects — prevents SSRF via open redirect
		if (status >= 300 && status < 400) {
			const location = response.headers.get("Location");
			if (location) {
				const redirectError = validateUrl(location, { allowHttp: isDev });
				if (redirectError) {
					return {
						data: {
							error: `Redirect blocked by SSRF protection: ${redirectError}`,
						},
						status: 403,
					};
				}
			}
			return {
				data: {
					error: `External API returned redirect (${status}) — not followed for security`,
				},
				status: 403,
			};
		}

		if (isDev) {
			console.log(`[external-handler] ${url} → ${status}`);
		}

		let data = await parseExternalResponse(response, config);
		if (delegation) data = redactDelegationResponse(data, delegation.token);

		if (isDev && status >= 400) {
			console.log(`[external-handler] Error response from ${url}:`, data);
		}

		// Extract via responsePath
		if (config.responsePath && data != null && typeof data === "object") {
			data = getByPath(data, config.responsePath) ?? data;
		}
		if (status < 400) {
			data = attachExternalSourceProvenance(data, url, ctx, config);
		}

		return { data, status };
	} catch (error) {
		if (error instanceof ExternalRequestInputError) {
			return { data: { error: error.message }, status: 400 };
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			return {
				data: { error: `External request timed out after ${timeout}ms` },
				status: 408,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			data: {
				error: delegation
					? redactDelegationResponse(message, delegation.token)
					: message,
			},
			status: 502,
		};
	} finally {
		clearTimeout(timer);
	}
}

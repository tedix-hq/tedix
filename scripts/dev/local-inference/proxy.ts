#!/usr/bin/env bun

export const LOCAL_INFERENCE_HOST = "127.0.0.1";
export const LOCAL_INFERENCE_PORT = 8791;
export const LOCAL_AI_GATEWAY_ID = "local-development";

export function resolveLocalGatewayId(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const gatewayId =
		env.TEDIX_LOCAL_AI_GATEWAY_ID?.trim() ||
		env.CF_AI_GATEWAY_ID?.trim() ||
		LOCAL_AI_GATEWAY_ID;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(gatewayId)) {
		throw new Error(
			"AI Gateway id must contain only lowercase letters, digits, and hyphens",
		);
	}
	return gatewayId;
}

/**
 * The account that owns the AI Gateway comes from the environment, never from a
 * literal in tracked source: this file ships verbatim in the OSS export, so a
 * hardcoded account id would be published. `scripts/run-local.ts` already puts
 * `TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID` in this process's environment, and the
 * bridge's `.env.example` manifest supplies `CF_ACCOUNT_ID` for a plain `bun proxy.ts`.
 */
export function resolveLocalGatewayAccountId(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const accountId = (
		env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID ||
		env.CF_ACCOUNT_ID ||
		env.CLOUDFLARE_ACCOUNT_ID ||
		""
	).trim();
	if (!/^[a-f\d]{32}$/i.test(accountId)) {
		throw new Error(
			"The local inference bridge requires a 32-character TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID (CF_ACCOUNT_ID is also accepted) naming the Cloudflare account that owns the AI Gateway",
		);
	}
	return accountId;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createLocalInferenceHandler(input: {
	token: string;
	accountId: string;
	gatewayId?: string;
	fetchImpl?: FetchLike;
}): (request: Request) => Promise<Response> {
	const token = input.token.trim();
	if (!token) throw new Error("CF_AI_GATEWAY_TOKEN resolved empty");
	const accountId = input.accountId.trim();
	if (!/^[a-f\d]{32}$/i.test(accountId)) {
		throw new Error(
			"AI Gateway account id must contain 32 hexadecimal characters",
		);
	}
	const gatewayId = resolveLocalGatewayId({
		TEDIX_LOCAL_AI_GATEWAY_ID: input.gatewayId ?? LOCAL_AI_GATEWAY_ID,
	});
	const ALLOWED_PATH_PREFIX = `/v1/${accountId}/${gatewayId}/azure-openai/`;
	const fetchImpl = input.fetchImpl ?? fetch;

	return async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "ok", service: "local-inference" });
		}
		if (
			request.method !== "POST" ||
			!url.pathname.startsWith(ALLOWED_PATH_PREFIX)
		) {
			return new Response("Not found", { status: 404 });
		}

		const headers = new Headers(request.headers);
		headers.set("cf-aig-authorization", `Bearer ${token}`);
		headers.delete("host");
		const upstreamUrl = `https://gateway.ai.cloudflare.com${url.pathname}${url.search}`;
		try {
			const upstream = await fetchImpl(upstreamUrl, {
				method: "POST",
				headers,
				body: request.body,
				redirect: "error",
				duplex: "half",
			});
			return new Response(upstream.body, {
				status: upstream.status,
				headers: upstream.headers,
			});
		} catch {
			return Response.json(
				{ error: "AI Gateway request failed" },
				{ status: 502 },
			);
		}
	};
}

if (import.meta.main) {
	const handler = createLocalInferenceHandler({
		token: process.env.CF_AI_GATEWAY_TOKEN ?? "",
		accountId: resolveLocalGatewayAccountId(),
		gatewayId: resolveLocalGatewayId(),
	});
	Bun.serve({
		hostname: LOCAL_INFERENCE_HOST,
		port: LOCAL_INFERENCE_PORT,
		fetch: handler,
	});
	console.log(
		`Local inference bridge ready on http://${LOCAL_INFERENCE_HOST}:${LOCAL_INFERENCE_PORT}`,
	);
}

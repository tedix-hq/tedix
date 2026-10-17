import { OIDC_SESSION_COOKIE } from "@tedix/auth/oidc-cookies";
import { resolveProductSession } from "@tedix/auth/product-session-broker";

type OidcApi = { fetch(request: Request): Promise<Response> };

export function hasOidcSession(request: Request) {
	return (
		resolveProductSession(
			request.headers.get("Cookie"),
			OIDC_SESSION_COOKIE,
		) !== null
	);
}
export async function proxyOidcProtocol(
	request: Request,
	api: OidcApi,
	tenantId: string | null,
) {
	const url = new URL(request.url);
	if (tenantId && url.pathname.endsWith("/start"))
		url.searchParams.set("organization", tenantId);
	// API selects configuration from D1; the host may constrain but never grant tenancy.
	const headers = new Headers();
	for (const key of ["Cookie", "Origin", "Content-Type"]) {
		const value = request.headers.get(key);
		if (value) headers.set(key, value);
	}
	if (tenantId) headers.set("X-Tedix-Tenant-Id", tenantId);
	return api.fetch(
		new Request(`https://api${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			redirect: "manual",
		}),
	);
}
export async function oidcSessionMatchesTenant(
	request: Request,
	api: OidcApi | undefined,
	tenantId: string,
) {
	if (!api || !hasOidcSession(request)) return false;
	try {
		const response = await api.fetch(
			new Request("https://api/auth/oidc/session", {
				headers: {
					Cookie: request.headers.get("Cookie") ?? "",
					"X-Tedix-Tenant-Id": tenantId,
				},
			}),
		);
		if (!response.ok) return false;
		const result = (await response.json()) as { organizationId?: string };
		return result.organizationId === tenantId;
	} catch {
		return false;
	}
}

/** Preserve the shell's existing status contract for an explicitly selected provider. */
export async function handleOidcBroker(
	request: Request,
	api: OidcApi,
	tenantId: string,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/auth/session-broker/")) return null;
	if (url.pathname.endsWith("/status")) {
		if (request.method !== "GET") return new Response(null, { status: 405 });
		const response = await api.fetch(
			new Request("https://api/auth/oidc/session", {
				headers: {
					Cookie: request.headers.get("Cookie") ?? "",
					"X-Tedix-Tenant-Id": tenantId,
				},
			}),
		);
		if (!response.ok)
			return Response.json(
				{ authenticated: false },
				{ headers: { "Cache-Control": "no-store" } },
			);
		const session = (await response.json()) as {
			expiresAt: number;
			user: { name: string; email: string };
		};
		return Response.json(
			{
				authenticated: true,
				expiresAt: session.expiresAt,
				tenantId,
				user: session.user,
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	if (url.searchParams.get("operation") === "logout") {
		if (request.headers.get("Sec-Fetch-Site") !== "same-origin")
			return new Response(null, { status: 403 });
		const response = await api.fetch(
			new Request("https://api/auth/oidc/logout", {
				method: "POST",
				headers: {
					Cookie: request.headers.get("Cookie") ?? "",
					Origin: url.origin,
					"X-Tedix-Tenant-Id": tenantId,
				},
			}),
		);
		const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
		const expired = response.headers.get("Set-Cookie");
		if (expired) headers.set("Set-Cookie", expired);
		if (response.ok) {
			const body = (await response.json()) as { logoutUrl: string | null };
			if (body.logoutUrl) headers.set("Location", body.logoutUrl);
		}
		return new Response(null, { status: 302, headers });
	}
	return Response.redirect(
		new URL(
			`/auth/oidc/start?organization=${encodeURIComponent(tenantId)}`,
			url.origin,
		),
		302,
	);
}

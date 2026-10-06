import { validateToken } from "@tedix/auth/jwt";
import {
	mountSessionBroker,
	PRODUCT_SESSION_BROKER_POLICIES,
} from "@tedix/auth/mount-session-broker";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import type { resolveOsTenant } from "@/shared/os-tenant";
import { isOsBrokerSessionRenewalDue } from "./broker-session.shared";

export const OS_BROKER_SESSION_COOKIE =
	PRODUCT_SESSION_BROKER_POLICIES.os.productCookie;
export const CLI_BROKER_SESSION_COOKIE =
	PRODUCT_SESSION_BROKER_POLICIES.cli.productCookie;
export const CLI_BROKER_CORRELATION_COOKIE =
	PRODUCT_SESSION_BROKER_POLICIES.cli.correlationCookie;

export interface OsSessionBrokerEnv {
	CLI_SESSION_BROKER?: SessionBrokerRpc;
	DESCOPE_PROJECT_ID?: string;
	/** Exact launcher origin projected from the installation manifest. */
	OS_URL?: string;
	OS_SESSION_BROKER?: SessionBrokerRpc;
}

const DESCOPE_TENANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function redirectPath(value: string | null, origin: string): string {
	if (
		!value?.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\")
	) {
		return "/";
	}
	try {
		const parsed = new URL(value, origin);
		return parsed.origin === origin && !parsed.hash
			? `${parsed.pathname}${parsed.search}`
			: "/";
	} catch {
		return "/";
	}
}

function expireCookie(name: string): string {
	return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax`;
}

async function status(
	request: Request,
	env: OsSessionBrokerEnv,
	productCookie: string,
	requiredTenantId: string | null,
): Promise<Response> {
	const session = resolveProductSession(
		request.headers.get("Cookie"),
		productCookie,
	);
	if (!session || !env.DESCOPE_PROJECT_ID) {
		return Response.json(
			{
				authenticated: false,
			},
			{ status: session ? 503 : 200, headers: { "Cache-Control": "no-store" } },
		);
	}
	try {
		const payload = await validateToken(session, {
			projectId: env.DESCOPE_PROJECT_ID,
		});
		if (!payload?.sub) {
			throw new Error("Expired session");
		}
		if (
			requiredTenantId !== null &&
			(typeof payload.dct !== "string" || payload.dct !== requiredTenantId)
		) {
			return Response.json(
				{ authenticated: false, renewalRequired: true },
				{ status: 401, headers: { "Cache-Control": "no-store" } },
			);
		}
		if (isOsBrokerSessionRenewalDue(payload.exp)) {
			return Response.json(
				{ authenticated: false, renewalRequired: true },
				{ status: 401, headers: { "Cache-Control": "no-store" } },
			);
		}
		return Response.json(
			{
				authenticated: true,
				expiresAt: payload.exp ?? null,
				tenantId: typeof payload.dct === "string" ? payload.dct : null,
				user: {
					email: typeof payload.email === "string" ? payload.email : "",
					name:
						typeof payload.name === "string"
							? payload.name
							: typeof payload.email === "string"
								? payload.email
								: "Tedix member",
				},
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch {
		return Response.json(
			{ authenticated: false },
			{ status: 401, headers: { "Cache-Control": "no-store" } },
		);
	}
}

export async function handleOsSessionBroker(
	request: Request,
	env: OsSessionBrokerEnv,
	host: ReturnType<typeof resolveOsTenant>,
	hostTenantId: string | null,
): Promise<Response | null> {
	const url = new URL(request.url);
	const cli = url.pathname.startsWith("/cli/session-broker/");
	const prefix = cli ? "/cli/session-broker" : "/auth/session-broker";
	// authz: public — the session-broker prefix IS the login flow; each verb below establishes the session it protects.
	if (!url.pathname.startsWith(`${prefix}/`)) return null;
	if (cli && host.kind !== "launcher") {
		return new Response("Not Found\n", { status: 404 });
	}
	const productCookie = cli
		? CLI_BROKER_SESSION_COOKIE
		: OS_BROKER_SESSION_COOKIE;
	// authz: public — reports only whether the presented cookie is a valid session; 401s otherwise.
	if (url.pathname === `${prefix}/status`) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed\n", {
				status: 405,
				headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
			});
		}
		return status(request, env, productCookie, cli ? null : hostTenantId);
	}
	const broker = cli ? env.CLI_SESSION_BROKER : env.OS_SESSION_BROKER;
	if (!broker) {
		return new Response("Session broker unavailable\n", {
			status: 503,
			headers: { "Cache-Control": "no-store" },
		});
	}
	const mounted = mountSessionBroker(cli ? "cli" : "os", broker, {
		installationOsOrigin: env.OS_URL,
	});
	// authz: public — login-flow callback: the broker verifies the one-time code and correlation cookie itself.
	if (url.pathname === `${prefix}/callback`) {
		return mounted.finish(request);
	}
	// authz: public — login-flow bounce: a same-origin document that navigates
	// itself to `start`, so a signed-out visitor arriving from another site
	// reaches the provenance-gated start verb with genuine same-origin headers.
	if (!cli && url.pathname === `${prefix}/continue`) {
		return mounted.continue({
			redirectPath: redirectPath(
				url.searchParams.get("redirect_to"),
				url.origin,
			),
			request,
		});
	}
	// authz: public — login-flow start: same-origin checked and redirects into the central broker.
	if (url.pathname !== `${prefix}/start`) return null;
	if (url.searchParams.get("operation") === "logout") {
		const response = await mounted.start({
			operation: "logout",
			// The CLI authorization page must retain its loopback callback params
			// through an account switch, otherwise signing out abandons the pending
			// terminal login. Product logout continues to land at the launcher.
			redirectPath: cli
				? redirectPath(url.searchParams.get("redirect_to"), url.origin)
				: "/",
			request,
			tenantId: null,
		});
		if (!cli) {
			// Both broker sessions are host-only cookies on os.tedix.dev. Logging
			// out of OS must clear a prior CLI authorization session too, otherwise
			// a later `tedix login` can silently identify as the previous user.
			response.headers.append(
				"Set-Cookie",
				expireCookie(CLI_BROKER_SESSION_COOKIE),
			);
			response.headers.append(
				"Set-Cookie",
				expireCookie(CLI_BROKER_CORRELATION_COOKIE),
			);
		}
		return response;
	}
	// The picker has already membership-validated this tenant. Selecting it here
	// establishes the central refresh family before the loopback handoff, so the
	// subsequent OAuth consent does not need to authenticate the human again.
	const cliTenantId = cli ? url.searchParams.get("tenant_id") : null;
	if (cliTenantId && !DESCOPE_TENANT_ID_PATTERN.test(cliTenantId)) {
		return new Response("Invalid CLI tenant selection\n", {
			status: 400,
			headers: { "Cache-Control": "no-store" },
		});
	}
	const tenantId = cli
		? cliTenantId
		: host.kind === "tenant"
			? hostTenantId
			: null;
	return mounted.start({
		operation: tenantId ? "issue_session" : "resume_session",
		redirectPath: redirectPath(url.searchParams.get("redirect_to"), url.origin),
		request,
		tenantId,
	});
}

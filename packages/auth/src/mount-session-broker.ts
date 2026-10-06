import { resolveSurfaceTenant } from "@tedix/tenant-directory";
import {
	continueProductSessionBroker,
	finishProductSessionBroker,
	startProductSessionBroker,
} from "./product-session-broker";
import type {
	SessionBrokerOperation,
	SessionBrokerRpc,
	SessionBrokerSurface,
} from "./session-broker";

/**
 * The complete product-session policy table. Call sites select a surface; they
 * cannot choose cookie names, callback paths, failure paths, or provenance
 * rules independently.
 */
export const PRODUCT_SESSION_BROKER_POLICIES = {
	os: {
		startPath: "/auth/session-broker/start",
		callbackPath: "/auth/session-broker/callback",
		correlationCookie: "__Host-tedix-os-broker",
		failureRedirectPath: "/",
		productCookie: "__Host-tedix-os-session",
	},
	cli: {
		startPath: "/cli/session-broker/start",
		callbackPath: "/cli/session-broker/callback",
		correlationCookie: "__Host-tedix-cli-broker",
		failureRedirectPath: "/cli/login",
		productCookie: "__Host-tedix-cli-session",
	},
	docs: {
		startPath: "/auth/session-broker/start",
		callbackPath: "/auth/session-broker/callback",
		correlationCookie: "__Host-tedix-docs-broker",
		failureRedirectPath: "/",
		productCookie: "__Host-tedix-docs-session",
	},
	cms: {
		startPath: "/_emdash/api/auth/session-broker/start",
		callbackPath: "/_emdash/api/auth/session-broker/callback",
		correlationCookie: "__Host-tedix-cms-broker",
		failureRedirectPath: "/_emdash/admin/login",
		productCookie: "__Host-tedix-cms-session",
	},
} as const satisfies Record<
	SessionBrokerSurface,
	{
		startPath: string;
		callbackPath: string;
		correlationCookie: `__Host-${string}`;
		failureRedirectPath: string;
		productCookie: `__Host-${string}`;
	}
>;

function hasTrustedHumanSurfaceReferer(request: Request): boolean {
	if (request.headers.get("Sec-Fetch-Site") !== "same-site") return false;
	const referer = request.headers.get("Referer");
	if (!referer) return false;
	try {
		const source = new URL(referer);
		if (source.protocol !== "https:" || source.port) return false;
		return (["os", "cms"] as const).some((expectedSurface) => {
			const resolved = resolveSurfaceTenant(source.hostname, {
				expectedSurface,
				platformDomain: "tedix.dev",
			});
			return resolved.kind === "apex" || resolved.kind === "tenant";
		});
	} catch {
		return false;
	}
}

function isOsDirectoryHandoff(request: Request): boolean {
	const url = new URL(request.url);
	if (url.pathname !== "/auth/session-broker/start") return false;
	const target = resolveSurfaceTenant(url.hostname, {
		expectedSurface: "os",
		platformDomain: "tedix.dev",
	});
	return target.kind === "tenant" && hasTrustedHumanSurfaceReferer(request);
}

function isCmsDirectoryHandoff(request: Request): boolean {
	const url = new URL(request.url);
	if (url.pathname !== "/_emdash/api/auth/session-broker/start") return false;
	const target = resolveSurfaceTenant(url.hostname, {
		expectedSurface: "cms",
		platformDomain: "tedix.dev",
	});
	return target.kind === "tenant" && hasTrustedHumanSurfaceReferer(request);
}

/**
 * Mount one product surface onto the shared broker protocol. The returned
 * adapter derives every security-sensitive option from the surface identity;
 * no call site can supply its own cookie or weaken the start-origin policy.
 */
export function mountSessionBroker(
	surface: SessionBrokerSurface,
	broker: SessionBrokerRpc,
	options?: { installationOsOrigin?: string },
) {
	const policy = PRODUCT_SESSION_BROKER_POLICIES[surface];
	return {
		/**
		 * Same-origin bounce for a signed-out top-level navigation whose own
		 * provenance is cross-site. See `continueProductSessionBroker`.
		 */
		continue({
			redirectPath,
			request,
		}: {
			redirectPath: string;
			request: Request;
		}) {
			return continueProductSessionBroker({
				installationOsOrigin: options?.installationOsOrigin,
				redirectPath,
				request,
				startPath: policy.startPath,
				surface,
			});
		},
		finish(request: Request) {
			return finishProductSessionBroker({
				installationOsOrigin: options?.installationOsOrigin,
				broker,
				correlationCookie: policy.correlationCookie,
				failureRedirectPath: policy.failureRedirectPath,
				productCookie: policy.productCookie,
				request,
				surface,
			});
		},
		productCookie: policy.productCookie,
		start({
			operation,
			redirectPath,
			request,
			tenantId,
		}: {
			operation: SessionBrokerOperation;
			redirectPath: string;
			request: Request;
			tenantId: string | null;
		}) {
			return startProductSessionBroker({
				installationOsOrigin: options?.installationOsOrigin,
				broker,
				correlationCookie: policy.correlationCookie,
				operation,
				productCookie: policy.productCookie,
				redirectPath,
				request,
				requireSameOriginStart: !(
					(surface === "os" && isOsDirectoryHandoff(request)) ||
					(surface === "cms" && isCmsDirectoryHandoff(request))
				),
				surface,
				tenantId,
			});
		},
	};
}

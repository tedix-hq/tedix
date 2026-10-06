import { resolveOsTenant } from "./os-tenant";

/**
 * Account identity is an apex concern even when the affordance is rendered in
 * a tenant shell. Build an absolute destination so `/account/profile` never
 * inherits the tenant hostname by accident. The isolated local lane remains
 * same-origin because it has no apex session broker.
 */
export function buildAccountProfileUrl(currentUrl: URL): string {
	if (resolveOsTenant(currentUrl.hostname).kind === "local") {
		return new URL("/account/profile", currentUrl.origin).toString();
	}
	const hostname = currentUrl.hostname.toLowerCase().replace(/\.$/, "");
	const platformDomain =
		hostname === "os.tedix.tech" || hostname.endsWith(".os.tedix.tech")
			? "tedix.tech"
			: "tedix.dev";
	return `https://os.${platformDomain}/account/profile`;
}

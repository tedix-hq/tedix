import { resolveSurfaceTenant } from "@tedix/tenant-directory";
import { assertCanonicalSessionBrokerOrigin } from "@tedix/auth/session-broker";

export type OsTenantRoute =
	| Readonly<{ kind: "tenant"; slug: string }>
	| Readonly<{ kind: "launcher" }>
	| Readonly<{ kind: "local"; slug: string | null }>
	| Readonly<{ kind: "invalid" }>;

/**
 * Resolve an OS hostname to its route. A thin re-derivation of the single
 * hostname-grammar authority in `@tedix/tenant-directory`. Production uses
 * `*.os.tedix.dev`; the explicit shared-production development lane uses the
 * identical grammar under `*.os.tedix.tech`. Both remain exact Tedix-owned
 * surfaces: arbitrary custom domains still fail closed to `invalid`.
 */
export function resolveOsTenant(
	hostname: string,
	installationOsOrigin = typeof __OS_URL__ === "string"
		? __OS_URL__
		: undefined,
): OsTenantRoute {
	const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (installationOsOrigin && installationOsOrigin !== "https://os.tedix.dev") {
		// A standalone installation serves only its declared launcher host. It
		// cannot claim arbitrary workers.dev siblings as tenant subdomains.
		try {
			const configured =
				assertCanonicalSessionBrokerOrigin(installationOsOrigin);
			return normalizedHostname === new URL(configured).hostname
				? { kind: "launcher" }
				: { kind: "invalid" };
		} catch {
			return { kind: "invalid" };
		}
	}
	const platformDomain =
		normalizedHostname === "os.tedix.tech" ||
		normalizedHostname.endsWith(".os.tedix.tech")
			? "tedix.tech"
			: "tedix.dev";
	const resolved = resolveSurfaceTenant(hostname, {
		platformDomain,
		expectedSurface: "os",
	});
	if (resolved.surface !== "os") return { kind: "invalid" };
	if (resolved.kind === "tenant" && resolved.slug) {
		return { kind: "tenant", slug: resolved.slug };
	}
	if (resolved.kind === "apex") return { kind: "launcher" };
	if (resolved.kind === "local") return { kind: "local", slug: resolved.slug };
	return { kind: "invalid" };
}

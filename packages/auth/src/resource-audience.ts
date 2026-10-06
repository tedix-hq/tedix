/** Require the resource audience; Descope also emits client and project metadata. */
export function hasResourceAudience(
	claims: { aud?: unknown; azp?: unknown; iss?: unknown },
	resource: string,
): boolean {
	if (!resource) return false;
	if (claims.aud === resource) return true;
	let project: string | undefined;
	if (typeof claims.iss === "string") {
		if (/^P[A-Za-z0-9]+$/.test(claims.iss)) {
			// Descope's validation SDK normalizes the resource issuer to its project.
			project = claims.iss;
		}
		try {
			const issuer = new URL(claims.iss);
			const path = issuer.pathname.split("/");
			if (
				path.length === 6 &&
				path[1] === "v1" &&
				path[2] === "apps" &&
				path[3] === "agentic" &&
				path[4]?.startsWith("P") &&
				path[5]?.startsWith("RS")
			)
				project = path[4];
		} catch {
			// An unrecognized issuer supplies no project audience exception.
		}
	}
	return (
		Array.isArray(claims.aud) &&
		claims.aud.includes(resource) &&
		claims.aud.every(
			(value) =>
				typeof value === "string" &&
				(value === resource || value === claims.azp || value === project),
		)
	);
}

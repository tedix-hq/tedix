export interface DescopeSessionBoundaryClaims {
	aud?: string | string[];
	iss?: string;
}

/** Exact JWT claim checks shared by the standalone CMS template and its tests. */
export function assertDescopeSessionBoundary(
	payload: DescopeSessionBoundaryClaims,
	options: { projectId: string },
): void {
	const expectedIssuer = options.projectId;
	if (payload.iss !== expectedIssuer) {
		throw new Error(`Descope JWT issuer mismatch: expected ${expectedIssuer}`);
	}

	const audiences = Array.isArray(payload.aud)
		? payload.aud
		: payload.aud
			? [payload.aud]
			: [];
	if (audiences.length > 0 && !audiences.includes(options.projectId)) {
		throw new Error(
			`Descope JWT audience mismatch: expected ${options.projectId}`,
		);
	}
}

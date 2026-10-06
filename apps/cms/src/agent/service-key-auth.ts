export function buildServiceKeyProvisionAuthCandidates(ctx: {
	forwardedAuth?: string;
	internalAuthToken?: string;
	humanAuthRequired?: boolean;
}): Record<string, string>[] {
	const candidates: Record<string, string>[] = [];
	if (ctx.humanAuthRequired) return candidates;
	if (ctx.forwardedAuth && isJwt(ctx.forwardedAuth)) {
		candidates.push({ Cookie: `DS=${ctx.forwardedAuth}` });
	}
	if (ctx.internalAuthToken) {
		candidates.push({
			"X-Tedix-CMS-Internal-Auth": ctx.internalAuthToken,
		});
	}
	return candidates;
}

function isJwt(token: string): boolean {
	const parts = token.split(".");
	return (
		parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
	);
}

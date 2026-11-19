import type { BaseContext } from "../rpc/orpc";

/**
 * Sign-in subject of the member a request acts for, so their monthly credit
 * cap applies to the work it starts: a signed-in person, or the person a
 * trusted service binding names (`X-Tedix-Acting-User`, e.g. Home acting for
 * the sender). Tedis, API keys, M2M clients and external agents act for no
 * member; scheduled and autonomous work has none either.
 */
export function actingMemberSubject(
	context: Pick<
		BaseContext,
		| "authType"
		| "descopeUserId"
		| "externalAgentPrincipalId"
		| "tediId"
		| "user"
	>,
): string | undefined {
	if (context.tediId || context.externalAgentPrincipalId) return undefined;
	if (context.authType === "user")
		return context.descopeUserId ?? context.user?.sub ?? undefined;
	return context.authType === "service-binding"
		? (context.descopeUserId ?? undefined)
		: undefined;
}

export interface CredentialExchangeTedi {
	id: string;
	organizationId: string;
	descopeUserId?: string | null;
}

export interface TediCredentialExchangeContext {
	requestedTediId: string;
	authenticatedTediId?: string;
	authenticatedDescopeUserId?: string;
	authenticatedOrganizationId?: string;
	targetOrganizationId?: string;
	tedi: CredentialExchangeTedi | null | undefined;
}

export type TediCredentialExchangeDecision =
	| {
			ok: true;
			tedi: CredentialExchangeTedi & { descopeUserId: string };
			organizationId: string;
			descopeUserId: string;
	  }
	| {
			ok: false;
			reason:
				| "tedi_not_found"
				| "requested_tedi_mismatch"
				| "authenticated_tedi_mismatch"
				| "authenticated_user_mismatch"
				| "missing_tedi_descope_user"
				| "authenticated_org_mismatch"
				| "target_org_mismatch";
	  };

export function authorizeTediCredentialExchange(
	params: TediCredentialExchangeContext,
): TediCredentialExchangeDecision {
	const tedi = params.tedi;
	if (!tedi) return { ok: false, reason: "tedi_not_found" };

	if (tedi.id !== params.requestedTediId) {
		return { ok: false, reason: "requested_tedi_mismatch" };
	}

	if (
		params.authenticatedTediId &&
		params.authenticatedTediId !== params.requestedTediId
	) {
		return { ok: false, reason: "authenticated_tedi_mismatch" };
	}

	if (!tedi.descopeUserId) {
		return { ok: false, reason: "missing_tedi_descope_user" };
	}

	if (
		params.authenticatedDescopeUserId &&
		params.authenticatedDescopeUserId !== tedi.descopeUserId
	) {
		return { ok: false, reason: "authenticated_user_mismatch" };
	}

	if (
		params.authenticatedOrganizationId &&
		params.authenticatedOrganizationId !== tedi.organizationId
	) {
		return { ok: false, reason: "authenticated_org_mismatch" };
	}

	if (
		params.targetOrganizationId &&
		params.targetOrganizationId !== tedi.organizationId
	) {
		return { ok: false, reason: "target_org_mismatch" };
	}

	return {
		ok: true,
		tedi: {
			...tedi,
			descopeUserId: tedi.descopeUserId,
		},
		organizationId: tedi.organizationId,
		descopeUserId: tedi.descopeUserId,
	};
}

import { hasResourceAudience } from "@tedix/auth/resource-audience";

/** Validate the multi-organization claim without changing its IDs. */
export function isValidSelectedOrganizations(
	value: unknown,
): value is string[] {
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= 10 &&
		value.every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 256,
		) &&
		new Set(value).size === value.length
	);
}

/**
 * Resolve the only tenant that may be persisted after OAuth. Tedix resources
 * require an active `dct` and exact agreement with the preselected tenant.
 * Third-party MCP servers retain SDK/DCR compatibility without Descope claims.
 */
export function validatedLoginTenant(input: {
	isTedixHosted: boolean;
	multiOrganizationResource?: boolean;
	expectedResource?: string;
	expectedTenant?: string;
	tokenClaims?: Record<string, unknown> | null;
}): string | undefined {
	if (input.multiOrganizationResource) {
		const selected = input.tokenClaims?.tedixSelectedOrganizations;
		const exactAudience = hasResourceAudience(
			input.tokenClaims ?? {},
			input.expectedResource ?? "",
		);
		if (
			!input.expectedResource ||
			!exactAudience ||
			input.tokenClaims?.token_type !== "access_token" ||
			typeof input.tokenClaims.dci !== "string" ||
			!isValidSelectedOrganizations(selected)
		) {
			throw new Error(
				"Tedix Connect returned no valid selected organizations. Credentials were not saved.",
			);
		}
		return undefined;
	}
	const expectedTenant = input.expectedTenant?.trim() || undefined;
	const tokenTenant =
		typeof input.tokenClaims?.dct === "string"
			? input.tokenClaims.dct.trim() || undefined
			: undefined;
	if (!input.isTedixHosted) return expectedTenant ?? tokenTenant;
	if (!tokenTenant) {
		const tenants = input.tokenClaims?.tenants;
		const isAihUserAccessToken =
			input.tokenClaims?.token_type === "access_token" &&
			typeof input.tokenClaims.azp === "string";
		if (
			expectedTenant &&
			isAihUserAccessToken &&
			tenants !== null &&
			typeof tenants === "object" &&
			Object.hasOwn(tenants, expectedTenant)
		) {
			return expectedTenant;
		}
		throw new Error(
			"Tedix OAuth returned no signed membership for the selected organization. Credentials were not saved. Run `tedix login <organization-slug>` and authorize that organization.",
		);
	}
	if (expectedTenant && tokenTenant !== expectedTenant) {
		throw new Error(
			`Tedix OAuth returned tenant ${tokenTenant}, but this login requested ${expectedTenant}. Credentials were not saved. Switch to the requested organization and try again.`,
		);
	}
	return tokenTenant;
}

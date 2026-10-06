import type { MultiOrgMcpSelection } from "./auth-helpers";

/** Connect consent belongs to the human, not a tedi in the hosting org. */
export function shouldBindHumanToTedi(
	config: Record<string, unknown> | undefined,
	selection?: MultiOrgMcpSelection | null,
): boolean {
	return !selection && config?.bindHumanToTedi !== false;
}

/** Selection has already passed the live consent, revision and membership gate. */
export function resolveConnectOrganization(
	selection: MultiOrgMcpSelection,
	target: string,
): MultiOrgMcpSelection["organizations"][number] {
	const organizations = selection.organizations;
	if (target === "auto") {
		if (organizations.length !== 1) {
			throw new Error(
				"Choose --organization <slug> when several organizations are selected.",
			);
		}
		return organizations[0]!;
	}
	const matches = organizations.filter((org) =>
		[
			org.organizationId,
			org.descopeTenantId,
			org.gatewaySlug,
			org.gatewaySlug.replace(/-unified$/, ""),
		].includes(target),
	);
	if (matches.length !== 1) {
		throw new Error(
			"Organization is not uniquely selected in this consent. Choose a selected organization or run tedix login to change consent.",
		);
	}
	return matches[0]!;
}

/** Only call after the target was matched to a live verified selection. */
export function organizationScopedRequest(
	request: Request,
	organizationId: string,
): Request {
	const headers = new Headers(request.headers);
	headers.set("x-tedix-auth-org-id", organizationId);
	// Never carry the hosting organization's human-to-tedi binding into a
	// different selected organization. The authenticated human/scopes survive.
	headers.delete("x-tedix-auth-tedi-id");
	headers.delete("X-Tedix-Organization");
	return new Request(request, { headers });
}

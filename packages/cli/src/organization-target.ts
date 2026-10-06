import type { WorkAttemptStore } from "./work-attempt-store";
import { decodeJwtPayload } from "./jwt-payload";
import { isMultiOrganizationMcpUrl } from "./oauth-provider";

export function resolveOrganizationTarget(input: {
	url: string;
	command: string;
	organization?: string;
	environmentOrganization?: string;
	accessToken?: string;
	workspace: string;
}): {
	headers: Record<string, string>;
	workspace: string;
	organization?: string;
} {
	if (!isMultiOrganizationMcpUrl(input.url)) {
		if (input.organization)
			throw new Error(
				"--organization requires a Connect workspace. Use -w to choose a direct tenant profile.",
			);
		return { headers: {}, workspace: input.workspace };
	}
	const organization =
		input.organization ??
		((
			input.environmentOrganization ?? process.env.TEDIX_ORGANIZATION
		)?.trim() ||
			undefined);
	// Raw Code Mode retains its organization-qualified surface unless targeted.
	if (input.command === "code" && !organization) {
		return { headers: {}, workspace: input.workspace };
	}
	const selected = decodeJwtPayload(
		input.accessToken ?? "",
	)?.tedixSelectedOrganizations;
	if (
		!Array.isArray(selected) ||
		selected.length < 1 ||
		selected.length > 10 ||
		selected.some((id) => typeof id !== "string" || !id || id.length > 256) ||
		new Set(selected).size !== selected.length
	) {
		throw new Error(
			"Connect has no valid organization selection. Run tedix login to renew consent.",
		);
	}
	if (!organization && selected.length !== 1) {
		throw new Error(
			"Several organizations are selected. Pass --organization <slug> or set TEDIX_ORGANIZATION for this terminal.",
		);
	}
	const target = organization ?? (selected[0] as string);
	// This is a routing hint only; the server checks live consent on every call.
	return {
		headers: { "X-Tedix-Organization": target },
		workspace: JSON.stringify([input.workspace, target]),
		organization: target,
	};
}

/** Fence only the capability store; profile names still identify auth and handoffs. */
export function organizationScopedAttemptStore(
	store: WorkAttemptStore,
	workspace: string,
): WorkAttemptStore {
	return {
		get: (key) => store.get({ ...key, workspace }),
		set: (key, attemptId) => store.set({ ...key, workspace }, attemptId),
		remove: (key, attemptId) => store.remove({ ...key, workspace }, attemptId),
	};
}

import type { WorkAttemptStore } from "./work-attempt-store";
import { decodeJwtPayload } from "./jwt-payload";
import { isMultiOrganizationMcpUrl } from "./oauth-provider";
import { savedDefaultOrganization } from "./agent-context";
import type { CredentialStoreOpts } from "./credential-store";

export function resolveOrganizationTarget(
	input: {
		url: string;
		command: string;
		organization?: string;
		environmentOrganization?: string;
		accessToken?: string;
		workspace: string;
		/** Authentication already verified this external agent's pinned organization. */
		externalAgent?: boolean;
	},
	options?: CredentialStoreOpts,
): {
	headers: Record<string, string>;
	workspace: string;
	organization?: string;
} {
	const organization =
		input.organization ??
		((
			input.environmentOrganization ?? process.env.TEDIX_ORGANIZATION
		)?.trim() ||
			undefined);
	if (input.externalAgent)
		return {
			headers: {},
			workspace: input.workspace,
			...(organization ? { organization } : {}),
		};
	if (!isMultiOrganizationMcpUrl(input.url)) {
		if (input.organization)
			throw new Error(
				"--organization requires a Connect workspace. Use -w to choose a direct tenant profile.",
			);
		return { headers: {}, workspace: input.workspace };
	}
	// Raw Code Mode and raw MCP requests keep the organization-qualified
	// surface unless targeted.
	if ((input.command === "code" || input.command === "mcp") && !organization) {
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
	const saved = organization
		? undefined
		: savedDefaultOrganization(input.workspace, options);
	const target =
		organization ??
		(saved && selected.includes(saved) ? saved : undefined) ??
		(selected.length === 1 ? (selected[0] as string) : undefined);
	if (!target) {
		throw new Error(
			`Several organizations are selected. Add one of these flags to your command.\nSelectable organizations:\n${selected.map((id) => `  --organization ${id}`).join("\n")}\nRun tedix orgs -w ${input.workspace} to see organization names, or set TEDIX_ORGANIZATION for this terminal.`,
		);
	}
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

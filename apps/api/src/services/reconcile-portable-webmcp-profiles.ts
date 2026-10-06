import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import type { DbClient } from "@tedix/db/client";
import { getPortableWebMcpToolAdmissions } from "@tedix/db/queries/app-gating";
import {
	listProviderPortableWebMcpConfigurations,
	publishProviderPortableWebMcpProfile,
} from "@tedix/db/queries/provider-installations";

/** What reconciling one installation's published profile did. */
export interface PortableWebMcpReconciliation {
	installationId: string;
	fromRevision: number;
	toRevision: number | null;
	removedCallables: string[];
	status:
		| "unchanged"
		| "reconciled"
		| "route_would_empty"
		| "conflict"
		| "failed";
	message?: string;
}

/**
 * A published profile pins callables by name, so it does not follow a provider
 * that stops shipping one.
 *
 * The admission check already notices — it rejects the callable with
 * `tool_unavailable` every time a session is issued — but noticing on the read
 * path only produces a log line and a widget that offers a tool the
 * installation then refuses. The profile stays broken until a person finds it.
 *
 * So the profile is reconciled at the moment the provider's tool set actually
 * changes. A callable that no longer exists cannot be admitted by anyone, and
 * dropping it is the only outcome that leaves the profile meaning what it says.
 * Each reconciliation is an ordinary revision with a change summary naming the
 * cause, so the edit is visible in the same history a hand publish is.
 */
export async function reconcilePublishedWebMcpProfiles(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		providerAppId: string;
		reason: string;
		publishedBy: string;
	},
): Promise<PortableWebMcpReconciliation[]> {
	const [configurations, catalogTools] = await Promise.all([
		listProviderPortableWebMcpConfigurations(db, input.providerOrganizationId),
		getPortableWebMcpToolAdmissions(db, input.providerAppId),
	]);
	const liveToolIds = new Set(catalogTools.map((tool) => tool.toolId));

	const reconciliations: PortableWebMcpReconciliation[] = [];
	for (const configuration of configurations) {
		if (configuration.providerAppId !== input.providerAppId) continue;
		const profile = configuration.profile;
		if (!profile) continue;

		const namespace = configuration.hostTenantNamespace;
		// Only this provider's own callables are in question. A `tedix_tenant`
		// tool belongs to the platform, and a callable in another namespace is
		// already rejected for a different reason that this must not mask.
		const isStale = (tool: { callable: string; authority?: string }) => {
			if (tool.authority === "tedix_tenant") return false;
			const separator = tool.callable.indexOf(".");
			if (separator < 0) return false;
			if (tool.callable.slice(0, separator) !== namespace) return false;
			return !liveToolIds.has(tool.callable.slice(separator + 1));
		};

		const removedCallables = profile.routes.flatMap((route) =>
			route.tools.filter(isStale).map((tool) => tool.callable),
		);
		if (removedCallables.length === 0) {
			reconciliations.push({
				installationId: configuration.installationId,
				fromRevision: configuration.revision,
				toRevision: configuration.revision,
				removedCallables: [],
				status: "unchanged",
			});
			continue;
		}

		const routes = profile.routes.map((route) => ({
			...route,
			tools: route.tools.filter((tool) => !isStale(tool)),
		}));
		const emptied = routes.filter((route) => route.tools.length === 0);
		if (emptied.length > 0) {
			// Publishing a route with no tools would replace a broken profile with
			// an empty one. Whoever owns the page has to decide what that route
			// offers instead, so this is reported and left alone.
			reconciliations.push({
				installationId: configuration.installationId,
				fromRevision: configuration.revision,
				toRevision: null,
				removedCallables,
				status: "route_would_empty",
				message: `Pruning would leave no tools on route(s): ${emptied
					.map((route) => route.id)
					.join(", ")}`,
			});
			continue;
		}

		const next: PortableWebMcpProfile = { ...profile, routes };
		try {
			const published = await publishProviderPortableWebMcpProfile(db, {
				providerOrganizationId: input.providerOrganizationId,
				installationId: configuration.installationId,
				expectedRevision: configuration.revision,
				profile: next,
				changeSummary: `Removed ${removedCallables.length} callable(s) the provider no longer ships: ${removedCallables.join(", ")}. Cause: ${input.reason}`,
				publishedBy: input.publishedBy,
			});
			if (published === "conflict" || published === null) {
				reconciliations.push({
					installationId: configuration.installationId,
					fromRevision: configuration.revision,
					toRevision: null,
					removedCallables,
					status: "conflict",
					message:
						published === "conflict"
							? "Profile changed while reconciling; it will reconcile on the next import"
							: "Installation not found",
				});
				continue;
			}
			reconciliations.push({
				installationId: configuration.installationId,
				fromRevision: configuration.revision,
				toRevision: published.revision,
				removedCallables,
				status: "reconciled",
			});
		} catch (error) {
			reconciliations.push({
				installationId: configuration.installationId,
				fromRevision: configuration.revision,
				toRevision: null,
				removedCallables,
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return reconciliations;
}

import { providerWidgetAllowsTedi } from "@tedix/api-contract/schemas/embedded-widget-access";
import { ORPCError } from "@orpc/server";
import { McpConfigSchema } from "@tedix/api-contract/schemas/app";
import {
	buildTedixMcpResourceUri,
	reconcileTedixMcpOwnershipTags,
} from "@tedix/auth/aih-audiences";
import {
	loadAllDescopeMcpServers,
	registerDescopeMcpResource,
} from "@tedix/auth/aih-client";
import { getManagementClient } from "@tedix/auth/client";
import { grantAppOperator } from "@tedix/auth/fga";
import {
	createAppWithId,
	getAppByIdForOrganization,
	getAppMetadataJson,
	updateAppMetadata,
} from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import type { getProviderInstallation } from "@tedix/db/queries/provider-installations";
import {
	getTediByIdForOrganization,
	releaseTediRuntimeLease,
	tryAcquireTediRuntimeLease,
} from "@tedix/db/queries/tedis";

type ProviderInstallation = NonNullable<
	Awaited<ReturnType<typeof getProviderInstallation>>
>;

import { ensureTediAihClientForApp } from "../lib/tedi-aih-client-sync";
import type { BaseContext } from "../rpc/orpc";

/** Provider/platform-authorized installation; settings may supply a validated proposed selection before its CAS publication. */
export async function ensureProviderInstallationGateway(
	context: BaseContext,
	installation: ProviderInstallation,
	selectedTediId?: string,
): Promise<void> {
	if (installation.status !== "active" && !selectedTediId) return;
	if (selectedTediId && !providerWidgetAllowsTedi(installation, selectedTediId))
		throw new ORPCError("FORBIDDEN", {
			message: "Worker is not selected for this installation",
		});
	const unavailable = (message: string) =>
		new ORPCError("CONFLICT", { message });
	if (
		!context.env.DESCOPE_PROJECT_ID ||
		!context.env.DESCOPE_MANAGEMENT_KEY ||
		!context.env.SECRETS_MASTER_KEY
	)
		throw unavailable("Provider gateway identity configuration is unavailable");
	const [source, tedi] = await Promise.all([
		getAppByIdForOrganization(
			context.db,
			installation.providerAppId,
			installation.providerOrganizationId,
		),
		getTediByIdForOrganization(
			context.db,
			selectedTediId ?? installation.primaryTediId,
			installation.customerOrganizationId,
		),
	]);
	if (
		!source ||
		source.visibility === "disabled" ||
		!tedi?.descopeUserId ||
		tedi.status !== "active" ||
		tedi.retiredAt
	)
		throw unavailable("Provider gateway source or worker is unavailable");
	// Concurrent onboarding retries share the existing worker lease primitive.
	// Serialize the external resource/client registration as well as the D1 row.
	const lease = {
		tediId: tedi.id,
		name: "provider-installation-gateway",
		owner: crypto.randomUUID(),
	};
	if (
		!(await tryAcquireTediRuntimeLease(context.db, {
			...lease,
			ttlMs: 300_000,
		}))
	)
		throw unavailable(
			"Provider gateway provisioning is in progress; retry this request",
		);
	try {
		const slug = `embedded-gateway-${installation.id}`;
		const apps = await getAppsByOrganization(
			context.db,
			installation.customerOrganizationId,
		);
		let app = apps.find((app) => app.slug === slug);
		if (!app) {
			// Reuse the installed single-source customer gateway, including its custom
			// branding/policy. Never convert a multi-source app into an installation app.
			const candidates = apps.filter((candidate) => {
				const parsed = McpConfigSchema.safeParse(
					getAppMetadataJson(candidate)?.mcpConfig ?? {},
				);
				if (!parsed.success) return false;
				const aggregate = parsed.data.aggregateApps;
				return (
					candidate.visibility !== "disabled" &&
					aggregate?.length === 1 &&
					aggregate[0]?.slug === source.slug &&
					aggregate[0]?.prefix === installation.hostTenantNamespace
				);
			});
			if (candidates.length > 1)
				throw unavailable(
					"Multiple provider gateways require operator selection",
				);
			app = candidates[0];
		}
		if (!app) {
			// The installation UUID is a stable identity in the separate apps table.
			// The unique ID/slug makes D1 creation recoverable after an interrupted call.
			app =
				(await createAppWithId(context.db, {
					id: installation.id,
					organizationId: installation.customerOrganizationId,
					slug,
					name: `${tedi.name} MCP`,
					visibility: "private",
					discoveryStatus: "pending",
					metadata: {
						mcpConfig: {
							authMode: "authenticated",
							codeMode: true,
							expectedAudience: buildTedixMcpResourceUri(slug),
							assignmentConfig: { mode: "manual" },
							aggregateApps: [
								{
									slug: source.slug,
									prefix: installation.hostTenantNamespace,
									// The source's read tools, by rule: nothing to recompute
									// when the provider ships another endpoint.
									readOnly: true,
								},
							],
						},
					},
				})) ?? undefined;
		}
		if (
			!app ||
			app.organizationId !== installation.customerOrganizationId ||
			app.visibility === "disabled"
		)
			throw unavailable("Provider gateway is unavailable");
		const metadata = getAppMetadataJson(app);
		let config = McpConfigSchema.parse(metadata?.mcpConfig ?? {});
		const aggregates = config?.aggregateApps;
		if (
			aggregates?.length !== 1 ||
			aggregates[0]?.slug !== source.slug ||
			aggregates[0]?.prefix !== installation.hostTenantNamespace
		)
			throw unavailable("Provider gateway source identity changed");
		// Gateways created before the rule carry an enumerated allowlist. Migrate
		// them once: the snapshot is what went stale, so it is removed rather
		// than refreshed.
		if (aggregates[0].toolIds || aggregates[0].readOnly !== true) {
			const { toolIds: _snapshot, ...entry } = aggregates[0];
			app =
				(await updateAppMetadata(context.db, app.id, {
					mcpConfig: {
						...config,
						aggregateApps: [{ ...entry, readOnly: true }],
					},
				})) ?? undefined;
			if (!app)
				throw unavailable("Provider gateway mount rule was not persisted");
			config = McpConfigSchema.parse(getAppMetadataJson(app)?.mcpConfig ?? {});
		}
		if (!config?.descopeResourceId) {
			const audience = buildTedixMcpResourceUri(app.slug);
			const existing = (await loadAllDescopeMcpServers(context.env)).filter(
				(server) => server.audienceWhitelist?.includes(audience),
			);
			if (existing.length > 1)
				throw unavailable("Provider gateway resource identity is ambiguous");
			if (existing[0] && !existing[0].tags?.includes(`app:${app.slug}`))
				throw unavailable("Provider gateway resource ownership is unverified");
			const server =
				existing[0] ??
				(await registerDescopeMcpResource(context.env, {
					name: app.name,
					audienceWhitelist: [audience],
					tags: reconcileTedixMcpOwnershipTags([], { app: app.slug }),
					approvedScopes: {
						connectionsScopes: [
							{
								name: "connections.execute",
								description: "Execute assigned provider tools",
							},
						],
					},
				}));
			app =
				(await updateAppMetadata(context.db, app.id, {
					mcpConfig: { ...config, descopeResourceId: server.id },
				})) ?? undefined;
			if (!app)
				throw unavailable("Provider gateway registration was not persisted");
		}
		await grantAppOperator(
			getManagementClient(context.env),
			tedi.descopeUserId,
			app.id,
		);
		const result = await ensureTediAihClientForApp({
			env: context.env,
			db: context.db,
			masterKey: context.env.SECRETS_MASTER_KEY,
			tedi,
			app,
			role: "operator",
			createdBy: context.user?.sub ?? null,
		});
		if (result.status === "skipped")
			throw unavailable("Provider gateway client was not provisioned");
	} finally {
		await releaseTediRuntimeLease(context.db, lease);
	}
}

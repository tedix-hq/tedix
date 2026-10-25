import type { DbClient } from "@tedix/db/client";
import type { App } from "@tedix/db/schema/apps";
import { getAppsBySlugsWithTools } from "@tedix/db/queries/app-records";
import { getPersonalRequestConsent } from "@tedix/db/queries/personal-request-consent";

/** Only the human-admitted Home run may read its caller's personal calendar. */
export async function readPersonalCalendar(input: {
	db: DbClient;
	env: Partial<
		Pick<CloudflareEnv, "MCP_SERVICE" | "MCP_URL" | "PLATFORM_SERVICE_TOKEN">
	>;
	organizationId: string;
	userId: string;
	runId: string;
	conversationId: string;
	apps: App[];
	now?: number;
}): Promise<string> {
	const now = input.now ?? Date.now();
	const consent = await getPersonalRequestConsent(
		input.db,
		input.organizationId,
		input.runId,
	);
	const grant = consent?.metadata;
	if (
		!consent ||
		consent.actorId !== input.userId ||
		grant?.requesterUserId !== input.userId ||
		grant.rootRunId !== input.runId ||
		grant.conversationId !== input.conversationId ||
		grant.tediId ||
		typeof grant.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(grant.expiresAt)) ||
		Date.parse(grant.expiresAt) <= now ||
		Date.parse(grant.expiresAt) - consent.timestamp.getTime() >
			15 * 60 * 1000 + 1000
	)
		return "Calendar not read: no active personal request admission.";
	const candidates = input.apps
		.filter(
			(app) =>
				app.metadata?.mcpConfig?.connectionProviderId === "google-calendar",
		)
		.slice(0, 2);
	if (!candidates.length)
		return "Calendar not read: no personal calendar reader is configured.";
	const surfaces = await getAppsBySlugsWithTools(
		input.db,
		candidates.map((app) => ({
			slug: app.slug,
			appId: app.id,
			hostOrganizationId: input.organizationId,
		})),
	);
	for (const surface of surfaces) {
		if (!surface || surface.app.organizationId !== input.organizationId)
			continue;
		const tool = surface.tools.find(
			(tool) =>
				tool.enabled &&
				tool.annotations?.readOnlyHint === true &&
				tool.config?.mcpToolName === "list_events",
		);
		if (!tool) continue;
		const { callDirectReadMcp, directReadConnectionRequirement } =
			await import("../kernel-runtime/direct-read");
		const requirement = directReadConnectionRequirement({
			appMetadata: surface.app.metadata,
			toolConfig: tool.config,
		});
		if (
			requirement?.providerId !== "google-calendar" ||
			requirement.tokenScope !== "user"
		)
			continue;
		// This is the existing exact read-only gateway; it resolves only this
		// admitted caller's connection and never opens consent or changes accounts.
		try {
			const result = await callDirectReadMcp({
				context: { env: input.env },
				organizationId: input.organizationId,
				appSlug: surface.app.slug,
				actingUserId: input.userId,
				method: "tools/call",
				params: {
					name: tool.toolId,
					arguments: {
						calendarId: "primary",
						timeMin: new Date(now - 7 * 86400000).toISOString(),
						timeMax: new Date(now + 7 * 86400000).toISOString(),
						maxResults: 25,
						singleEvents: true,
						orderBy: "startTime",
					},
				},
				timeoutMs: 10000,
			});
			return JSON.stringify({
				source: "connected_calendar",
				app: surface.app.slug,
				observedAt: new Date(now).toISOString(),
				result,
			}).slice(0, 6000);
		} catch (error) {
			return `Calendar read unavailable: ${error instanceof Error ? error.message : "gateway read failed"}`;
		}
	}
	return "Calendar not read: no reviewed personal event reader is available.";
}

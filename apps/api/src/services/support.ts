import { SupportConfigurationSchema } from "@tedix/api-contract/schemas/support";
import { supportObjectId } from "@tedix/api-contract/utils/support-report";
import * as tickets from "@tedix/db/queries/support";
import type { SupportTicketRow } from "@tedix/db/schema/support";
import type { BaseContext } from "../rpc/context";
import { createError, ErrorCodes } from "../rpc/orpc";
import { requireOrgId } from "../rpc/org-scope";

export async function supportConfig(context: Pick<BaseContext, "db">) {
	const value = await tickets.getSupportConfiguration(context.db);
	if (!value?.enabled)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Support intake is not configured for this installation",
		);
	const parsed = SupportConfigurationSchema.safeParse(value);
	if (!parsed.success)
		throw createError(
			ErrorCodes.CONFLICT,
			"Support configuration is invalid; ask the installation admin to configure Support",
		);
	return parsed.data;
}
export function supportReporter(context: BaseContext) {
	const userId = context.userId ?? context.gatewayEndUserId;
	if (userId) return `user:${userId}`;
	if (context.tediId) return `tedi:${context.tediId}`;
	if (context.externalAgentPrincipalId)
		return `external_agent:${context.externalAgentPrincipalId}`;
	if (context.apiKey?.id) return `apikey:${context.apiKey.id}`;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Support requires an attributable authenticated caller",
	);
}
export async function supportStaff(context: BaseContext, humanOnly = false) {
	const config = await supportConfig(context);
	const userId = context.userId ?? context.gatewayEndUserId;
	const human =
		context.authType === "user" &&
		!context.externalAgentPrincipalId &&
		!context.ownerHostSessionId &&
		userId === config.adminUserId;
	if (
		requireOrgId(context) !== config.platformOrgId ||
		!(human || (!humanOnly && context.tediId === config.supportTediId))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the configured Support tedi or designated human admin can access support operations",
		);
	return { config, human };
}
export function supportReceipt(row: SupportTicketRow, afterVersion = 0) {
	return {
		title: row.report.title,
		owner: "Support",
		waitingOn:
			row.status === "resolved"
				? ("none" as const)
				: row.draft || row.interactionId
					? ("admin" as const)
					: row.status === "answered"
						? ("reporter" as const)
						: ("support" as const),
		lastPublicUpdateAt: row.publicUpdates.at(-1)?.createdAt ?? null,
		ticketId: row.id,
		workItemId: row.workItemId,
		statusUrl: `/work/items/${row.workItemId}`,
		status: row.status,
		version: row.version,
		recordedAt: row.createdAt,
		mirrorDelivery: row.mirrorDelivery,
		nextUpdateDue: row.nextUpdateDue,
		reporterVerification: row.reporterVerification,
		publicUpdates: row.publicUpdates.filter((x) => x.version > afterVersion),
		nextPollMs: 60_000,
	};
}
export function staffSupportTicket(row: SupportTicketRow) {
	return {
		receipt: supportReceipt(row),
		report: row.report,
		mirrorWorkItemId: row.mirrorWorkItemId,
		draft: row.draft,
		escalationWorkItemId: row.escalationWorkItemId,
		interactionId: row.interactionId,
	};
}
export async function deliverSupportTicket(
	context: Pick<BaseContext, "db">,
	row: SupportTicketRow,
) {
	const config = await supportConfig(context);
	if (row.platformOrgId !== config.platformOrgId)
		throw new Error("Support bridge destination changed");
	const project = await tickets.ensureSupportProject(context.db, {
		id: await supportObjectId(`support-project:${config.platformOrgId}`),
		orgId: config.platformOrgId,
		key: config.projectKey,
		ownerTediId: config.supportTediId,
		now: new Date().toISOString(),
	});
	await tickets.deliverSupportMirror(context.db, row, {
		projectId: project.id,
		tediId: config.supportTediId,
		eventId: await supportObjectId(`support-wake:${row.id}`),
		now: new Date().toISOString(),
	});
}
export async function changeSupportTicket(
	context: BaseContext,
	row: SupportTicketRow,
	p: Omit<
		Parameters<typeof tickets.updateSupportTicket>[2],
		"commentId" | "eventId"
	>,
) {
	const changed = await tickets.updateSupportTicket(context.db, row, {
		...p,
		commentId: await supportObjectId(`support-comment:${row.id}:${p.key}`),
		eventId: await supportObjectId(`support-event:${row.id}:${p.key}`),
	});
	if (!changed)
		throw createError(
			ErrorCodes.CONFLICT,
			"Ticket changed; read its current version before updating",
		);
	return changed;
}

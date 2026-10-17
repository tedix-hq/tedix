import {
	getSupportConfiguration,
	ensureSupportProject,
} from "@tedix/db/queries/support";
import {
	createWorkItem,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import {
	redactSupportText,
	supportObjectId,
} from "@tedix/api-contract/utils/support-report";
import type { BaseContext } from "../rpc/context";

/** Restricted email stub: persist a mapping task, never infer a tenant from From. */
export async function stageSupportEmail(
	context: Pick<BaseContext, "db">,
	input: {
		organizationId: string;
		tediId: string;
		messageId: string;
		threadId: string;
		subject: string;
	},
) {
	const config = await getSupportConfiguration(context.db);
	if (
		!config?.enabled ||
		config.platformOrgId !== input.organizationId ||
		config.supportTediId !== input.tediId
	)
		return null;
	const now = new Date().toISOString(),
		sourceIntentId = `support-email:${input.messageId}`;
	const prior = await getWorkItemBySourceIntentId(context.db, {
		orgId: config.platformOrgId,
		sourceIntentId,
	});
	if (prior) return prior.id;
	const project = await ensureSupportProject(context.db, {
		id: await supportObjectId(`support-project:${config.platformOrgId}`),
		orgId: config.platformOrgId,
		key: config.projectKey,
		ownerTediId: config.supportTediId,
		now,
	});
	const row = await createWorkItem(context.db, {
		id: await supportObjectId(`${config.platformOrgId}:${sourceIntentId}`),
		orgId: config.platformOrgId,
		title: `Verify support email: ${redactSupportText(input.subject).slice(0, 160)}`,
		description:
			"Support email received. Verify the sender, exact organization and consented report before filing a tenant ticket. Read the original mailbox record under ordinary mailbox authority. Do not infer membership from an email address or domain; do not send a reply automatically.",
		metadata: {
			emailMessageId: input.messageId,
			emailThreadId: input.threadId,
			supportEmailState: "requires_mapping",
		},
		workKind: "operations",
		workClass: "maintenance",
		riskLevel: "low",
		projectId: project.id,
		accountableOwnerType: "user",
		accountableOwnerId: config.adminUserId,
		sourceIntentId,
		createdAt: now,
	});
	return row.id;
}

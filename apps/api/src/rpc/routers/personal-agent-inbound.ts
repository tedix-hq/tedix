import { implement } from "@orpc/server";
import { personalAgentInboundContract } from "@tedix/api-contract/contracts/personal-agent-inbound";
import { PersonalAgentEnrollmentSchema } from "@tedix/api-contract/schemas/personal-agent-inbound";
import {
	PERSONAL_AGENT_NAMESPACE,
	personalAgentConfigKey,
} from "@tedix/db/queries/personal-agent-inbound";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import { createOrgSecret } from "@tedix/db/queries/organization-secrets";
import {
	getUserConfig,
	listUserConfigs,
	putUserConfig,
} from "@tedix/db/queries/user-configs";
import { encryptSecret } from "@tedix/db/utils/secrets-encryption";
import {
	getPersonalAgentEmailDestination,
	getPersonalAgentValue,
} from "@tedix/db/queries/personal-agent-outbound";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const owner = implement(personalAgentInboundContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(AUTHZ.osAuthor)
	.use(async ({ context, next }) => {
		if (context.authType !== "user" || !context.userId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"A person must enroll their own personal agent",
			);
		return next({
			context: {
				...context,
				ownerUserId: context.userId,
				orgId: requireOrgId(context),
			},
		});
	});

export const personalAgentInboundContractRouter = {
	configureDelivery: owner.configureDelivery.handler(
		async ({ input, context }) => {
			const key = personalAgentConfigKey(context.orgId, input.id);
			const row = await getUserConfig(context.db, {
				userId: context.ownerUserId,
				namespace: PERSONAL_AGENT_NAMESPACE,
				key,
			});
			const parsed = PersonalAgentEnrollmentSchema.safeParse(row?.value);
			if (
				!row ||
				!parsed.success ||
				!parsed.data.active ||
				parsed.data.orgId !== context.orgId ||
				parsed.data.representedUserId !== context.ownerUserId
			)
				throw createError(ErrorCodes.NOT_FOUND, "Active enrollment not found");
			const enrollment = {
				...parsed.data,
				delivery: { workComment: true as const, email: input.email },
			};
			if (
				input.email &&
				!(await getPersonalAgentEmailDestination(context.db, enrollment))
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Choose the enrolled agent's active member identity and an active organization sender address",
				);
			const saved = await putUserConfig(context.db, {
				userId: context.ownerUserId,
				namespace: PERSONAL_AGENT_NAMESPACE,
				key,
				value: enrollment,
				expectedRevision: row.revision,
			});
			if (!saved.ok)
				throw createError(ErrorCodes.CONFLICT, "Enrollment changed; reload");
			return enrollment;
		},
	),
	value: owner.value.handler(async ({ context }) => {
		const end = new Date().toISOString();
		const start = new Date(Date.parse(end) - 7 * 86400000).toISOString();
		const rows = await listUserConfigs(context.db, {
			userId: context.ownerUserId,
			namespace: PERSONAL_AGENT_NAMESPACE,
			limit: 500,
		});
		const result = [];
		for (const row of rows) {
			const parsed = PersonalAgentEnrollmentSchema.safeParse(row.value);
			if (
				!parsed.success ||
				parsed.data.orgId !== context.orgId ||
				parsed.data.representedUserId !== context.ownerUserId
			)
				continue;
			const e = parsed.data;
			const counts = await getPersonalAgentValue(context.db, e, start, end);
			result.push({
				sourceAgentId: e.id,
				sourceAgentName: e.sourceAgentName,
				windowStart: start,
				windowEnd: end,
				...counts,
				decidedFromCardPercent: counts.decisionCards
					? (100 * counts.decidedFromCard) / counts.decisionCards
					: null,
				remindersAvoided: null,
				historicalChatBaseline: null,
			});
		}
		return result;
	}),
	enroll: owner.enroll.handler(async ({ input, context }) => {
		const project = await getProjectByIdForOrganization(
			context.db,
			context.orgId,
			input.projectId,
		);
		if (!project || project.status !== "active" || !project.objectiveId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Choose an active purpose-linked project in this organization",
			);
		const masterKey = context.env.SECRETS_MASTER_KEY;
		if (!masterKey)
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Secrets encryption unavailable",
			);
		const id = crypto.randomUUID();
		const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		const enrollment = {
			id,
			orgId: context.orgId,
			representedUserId: context.ownerUserId,
			sourceAgentName: input.sourceAgentName,
			projectId: project.id,
			secretName: `personal-agent-${id}`,
			active: true,
			createdAt: new Date().toISOString(),
		};
		await createOrgSecret(context.db, {
			organizationId: context.orgId,
			name: enrollment.secretName,
			encryptedValue: await encryptSecret(masterKey, context.orgId, token),
			hint: null,
			createdBy: context.ownerUserId,
		});
		const saved = await putUserConfig(context.db, {
			userId: context.ownerUserId,
			namespace: PERSONAL_AGENT_NAMESPACE,
			key: personalAgentConfigKey(context.orgId, id),
			value: enrollment,
			expectedRevision: 0,
		});
		if (!saved.ok)
			throw createError(ErrorCodes.CONFLICT, "Enrollment conflict");
		return { enrollment, token };
	}),
	list: owner.list.handler(async ({ context }) => {
		const rows = await listUserConfigs(context.db, {
			userId: context.ownerUserId,
			namespace: PERSONAL_AGENT_NAMESPACE,
			limit: 500,
		});
		return rows.flatMap((row) => {
			const e = PersonalAgentEnrollmentSchema.safeParse(row.value);
			return e.success && e.data.orgId === context.orgId ? [e.data] : [];
		});
	}),
	revoke: owner.revoke.handler(async ({ input, context }) => {
		const key = personalAgentConfigKey(context.orgId, input.id);
		const row = await getUserConfig(context.db, {
			userId: context.ownerUserId,
			namespace: PERSONAL_AGENT_NAMESPACE,
			key,
		});
		const e = PersonalAgentEnrollmentSchema.safeParse(row?.value);
		if (
			!row ||
			!e.success ||
			e.data.orgId !== context.orgId ||
			e.data.representedUserId !== context.ownerUserId
		)
			throw createError(ErrorCodes.NOT_FOUND, "Enrollment not found");
		const saved = await putUserConfig(context.db, {
			userId: context.ownerUserId,
			namespace: PERSONAL_AGENT_NAMESPACE,
			key,
			expectedRevision: row.revision,
			value: { ...e.data, active: false },
		});
		if (!saved.ok)
			throw createError(
				ErrorCodes.CONFLICT,
				"Enrollment changed; retry revocation",
			);
		return { revoked: true as const };
	}),
};

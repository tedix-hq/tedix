import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { validateSkillInput } from "@tedix/db/queries/cognitive/skill-validation";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	getMemberByIdForOrganization,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import {
	getOsWorkspaceResource,
	getOsWorkspaceSkillDraftGrant,
	setOsWorkspaceSkillDraftGrant,
	createOsWorkspaceSkillDraftProposal,
	getOsWorkspaceSkillDraftProposal,
	listOsWorkspaceSkillDraftProposals,
	withdrawOsWorkspaceSkillDraftProposal,
} from "@tedix/db/queries/os-workspaces/resources";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { validateSkillSchedulePolicy } from "@tedix/api-contract/utils/skill-schedule";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../orpc";
import {
	authedSkills,
	skillSchedulePolicyChanged,
	sha256Digest,
} from "./cognitive-shared";
import { applyValidationGate } from "./cognitive-skill-shared";
import { requireWorkspace } from "./os-workspaces-shared";

async function requireMember(context: BaseContext) {
	const organizationId = requireOrgId(context);
	let subject = context.authType === "user" ? context.user?.sub : undefined;
	// A trusted Home call may act only for its own member, never a supplied user id.
	if (
		context.authType === "service-binding" &&
		context.tediId &&
		context.descopeUserId
	) {
		const tedi = await getTediByIdForOrganization(
			context.db,
			context.tediId,
			organizationId,
		);
		if (tedi?.status === "active" && tedi.ownerUserId === context.descopeUserId)
			subject = context.descopeUserId;
	}
	const member = subject
		? await getMemberByUserId(context.db, organizationId, subject)
		: undefined;
	if (!member || member.status !== "active")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An active member identity is required for workspace skill drafts",
		);
	return member;
}

async function requireLinkedSkill(
	context: BaseContext,
	target: { workspaceId: string; resourceId: string },
) {
	const workspace = await requireWorkspace(context, target.workspaceId);
	if (workspace.status !== "active")
		throw createError(ErrorCodes.FORBIDDEN, "Workspace is not active");
	const resource = await getOsWorkspaceResource(context.db, {
		organizationId: workspace.organizationId,
		...target,
	});
	if (
		!resource ||
		resource.status !== "active" ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "skill" ||
		resource.connectionScope !== "tenant"
	) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Active workspace skill resource not found",
		);
	}
	const skill = await getSkillEntry(
		context.db,
		resource.providerResourceId,
		workspace.organizationId,
	);
	if (!skill || skill.lifecycleState === "archived")
		throw createError(ErrorCodes.NOT_FOUND, "Linked skill not found");
	return { workspace, resource, skill };
}

export const skillsGetWorkspaceDraftGrant = authedSkills.getWorkspaceDraftGrant
	.use(AUTHZ.osRead)
	.handler(async ({ input, context }) => {
		const member = await requireMember(context);
		await requireLinkedSkill(context, input);
		const grant = await getOsWorkspaceSkillDraftGrant(context.db, {
			organizationId: member.organizationId,
			memberId: member.id,
			...input,
		});
		return { grant: grant ?? null };
	});

export const skillsSetWorkspaceDraftGrant = authedSkills.setWorkspaceDraftGrant
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		const actor = await requireMember(context);
		if (
			context.authType !== "user" ||
			context.tediId ||
			context.externalAgentPrincipalId ||
			actor.kind !== "human" ||
			!["owner", "admin"].includes(actor.role)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"An active human owner or administrator must grant workspace skill drafts",
			);
		}
		const member = await getMemberByIdForOrganization(context.db, {
			organizationId: actor.organizationId,
			memberId: input.memberId,
		});
		if (
			!member ||
			member.organizationId !== actor.organizationId ||
			member.status !== "active"
		)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Active organization member not found",
			);
		const expiresAt = Date.parse(input.expiresAt);
		if (
			input.enabled &&
			(expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 86400_000)
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Draft access must expire within 30 days",
			);
		const { skill } = await requireLinkedSkill(context, input);
		const grant = await setOsWorkspaceSkillDraftGrant(context.db, {
			organizationId: actor.organizationId,
			memberId: input.memberId,
			workspaceId: input.workspaceId,
			resourceId: input.resourceId,
			skillId: skill.id,
			enabled: input.enabled,
			expiresAt: new Date(expiresAt).toISOString(),
			grantedBy: actor.id,
			updatedAt: new Date().toISOString(),
		});
		await emitAuditEvent(context.db, {
			organizationId: actor.organizationId,
			actorId: actor.id,
			actorType: "user",
			action: "skill.workspace_draft_grant.set",
			resourceType: "workspace_resource",
			resourceId: input.resourceId,
			metadata: {
				memberId: member.id,
				workspaceId: input.workspaceId,
				enabled: input.enabled,
				expiresAt: grant.expiresAt,
				skillId: skill.id,
			},
		});
		return { grant };
	});

export const skillsProposeWorkspaceRevision =
	authedSkills.proposeWorkspaceRevision
		.use(withAuthorization("os:author", "mcp:skills.write"))
		.handler(async ({ input, context }) => {
			const member = await requireMember(context);
			const { workspace, resource, skill } = await requireLinkedSkill(
				context,
				input,
			);
			const grant = await getOsWorkspaceSkillDraftGrant(context.db, {
				organizationId: member.organizationId,
				memberId: member.id,
				workspaceId: workspace.id,
				resourceId: resource.id,
			});
			if (
				!grant?.enabled ||
				Date.parse(grant.expiresAt) <= Date.now() ||
				!Number.isFinite(Date.parse(grant.expiresAt)) ||
				grant.skillId !== skill.id
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Ask an owner or administrator for draft access to this workspace skill",
				);
			const payloadDigest = await sha256Digest(
				JSON.stringify({
					memberId: member.id,
					workspaceId: workspace.id,
					resourceId: resource.id,
					skillId: skill.id,
					revision: input.expectedSourceRevision,
					content: input.content,
					files:
						input.files === undefined
							? null
							: Object.fromEntries(
									Object.entries(input.files).sort(([a], [b]) =>
										a.localeCompare(b),
									),
								),
					reason: input.reason,
				}),
			);
			const identity = {
				organizationId: member.organizationId,
				workspaceId: workspace.id,
				resourceId: resource.id,
				proposalId: input.requestId,
			};
			let proposal = await getOsWorkspaceSkillDraftProposal(
				context.db,
				identity,
			);
			if (!proposal) {
				if (skill.revision !== input.expectedSourceRevision)
					throw createError(
						ErrorCodes.CONFLICT,
						"The linked skill changed; reload it before proposing a draft",
					);
				if (skillSchedulePolicyChanged(skill.content, input.content))
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Workspace drafts cannot change schedule policy",
					);
				const schedule = validateSkillSchedulePolicy(input.content);
				if (schedule.issues.length)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"The draft contains an invalid schedule policy",
					);
				const files = input.files ?? skill.files;
				applyValidationGate(
					await validateSkillInput(
						context.db,
						{
							title: skill.title,
							content: input.content,
							files,
							mcpAppBindings: skill.mcpAppBindings,
							organizationId: member.organizationId,
						},
						skill.appId,
					),
					"error",
				);
				proposal = await createOsWorkspaceSkillDraftProposal(context.db, {
					id: input.requestId,
					organizationId: member.organizationId,
					memberId: member.id,
					workspaceId: workspace.id,
					resourceId: resource.id,
					skillId: skill.id,
					sourceRevision: skill.revision,
					baseContent: skill.content,
					baseFiles: skill.files,
					content: input.content,
					files,
					reason: input.reason,
					payloadDigest,
					createdAt: new Date().toISOString(),
					status: "pending",
				});
			}
			if (
				!proposal ||
				proposal.memberId !== member.id ||
				proposal.payloadDigest !== payloadDigest
			)
				throw createError(
					ErrorCodes.CONFLICT,
					"This draft request was already used for a different proposal",
				);
			const actor = auditActor(context);
			await insertAuditEvent(context.db, {
				id: `workspace-draft:${proposal.id}`,
				ignoreDuplicates: true,
				organizationId: member.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "skill.workspace_draft.proposed",
				resourceType: "workspace_skill_draft",
				resourceId: proposal.id,
				metadata: {
					memberId: member.id,
					workspaceId: workspace.id,
					resourceId: resource.id,
					sourceSkillId: skill.id,
					sourceRevision: proposal.sourceRevision,
					humanActivationRequired: true,
				},
			});
			return {
				proposal,
				workspaceId: workspace.id,
				resourceId: resource.id,
				humanActivationRequired: true as const,
				canWithdraw: proposal.status === "pending",
			};
		});

export const skillsListWorkspaceDraftProposals =
	authedSkills.listWorkspaceDraftProposals
		.use(AUTHZ.osRead)
		.handler(async ({ input, context }) => {
			const member = await requireMember(context);
			await requireWorkspace(context, input.workspaceId);
			return {
				proposals: await listOsWorkspaceSkillDraftProposals(context.db, {
					organizationId: member.organizationId,
					...input,
					...(["owner", "admin"].includes(member.role)
						? {}
						: { memberId: member.id }),
				}),
			};
		});

export const skillsGetWorkspaceDraftProposal =
	authedSkills.getWorkspaceDraftProposal
		.use(AUTHZ.osRead)
		.handler(async ({ input, context }) => {
			const member = await requireMember(context);
			await requireWorkspace(context, input.workspaceId);
			const proposal = await getOsWorkspaceSkillDraftProposal(context.db, {
				organizationId: member.organizationId,
				...input,
			});
			if (
				!proposal ||
				(proposal.memberId !== member.id &&
					!["owner", "admin"].includes(member.role))
			)
				throw createError(ErrorCodes.NOT_FOUND, "Draft proposal not found");
			return {
				proposal,
				workspaceId: input.workspaceId,
				resourceId: input.resourceId,
				humanActivationRequired: true as const,
				canWithdraw:
					proposal.memberId === member.id && proposal.status === "pending",
			};
		});

export const skillsWithdrawWorkspaceDraftProposal =
	authedSkills.withdrawWorkspaceDraftProposal
		.use(withAuthorization("os:author", "mcp:skills.write"))
		.handler(async ({ input, context }) => {
			const member = await requireMember(context);
			await requireWorkspace(context, input.workspaceId);
			const identity = {
				organizationId: member.organizationId,
				memberId: member.id,
				...input,
			};
			const existing = await getOsWorkspaceSkillDraftProposal(
				context.db,
				identity,
			);
			if (!existing || existing.memberId !== member.id)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Your draft proposal was not found",
				);
			const proposal = await withdrawOsWorkspaceSkillDraftProposal(context.db, {
				...identity,
				now: new Date().toISOString(),
			});
			if (!proposal)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Your draft proposal was not found",
				);
			const actor = auditActor(context);
			await insertAuditEvent(context.db, {
				id: `workspace-draft-withdraw:${proposal.id}`,
				ignoreDuplicates: true,
				organizationId: member.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "skill.workspace_draft.withdrawn",
				resourceType: "workspace_skill_draft",
				resourceId: proposal.id,
				metadata: {
					workspaceId: input.workspaceId,
					resourceId: input.resourceId,
					memberId: member.id,
				},
			});
			return {
				proposal,
				workspaceId: input.workspaceId,
				resourceId: input.resourceId,
				humanActivationRequired: true as const,
				canWithdraw: false,
			};
		});

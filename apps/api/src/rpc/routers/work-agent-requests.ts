import { createRouterClient } from "@orpc/server";
import {
	AgentRequestProposalSchema,
	type AgentRequestProposal,
} from "@tedix/api-contract/schemas/agent-requests";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getApiKeyById } from "@tedix/db/queries/api-keys";
import {
	getConnectionInstance,
	createConnectionInstance,
	listConnectionInstances,
} from "@tedix/db/queries/connection-instances";
import { getMemberByCanonicalUserId } from "@tedix/db/queries/organization-members";
import { setConnectionConsumerGrants } from "@tedix/db/queries/organizations";
import { getExternalAgentPrincipalByCredential } from "@tedix/db/queries/external-agent-identity/principals";
import {
	claimAgentRequestExecution,
	finishAgentRequestExecution,
} from "@tedix/db/queries/work-items/approvals";
import { safeExceptionTopology } from "../../lib/safe-log-metadata";
import { type BaseContext, createError, ErrorCodes } from "../orpc";
import { collectReferencedProviders } from "./connections/provider-registration";
import { readConnectionProviders } from "./connections/discovery-user";
import { connectionAccountMode } from "@tedix/api-contract/utils/connection-account-mode";
import { requireOwnerAdminWorkItemAuthor } from "./work-items/policy-helpers";

/** Rechecked before execution: approval does not preserve revoked resource access. */
export async function validateAgentRequestTarget(
	context: BaseContext,
	orgId: string,
	proposal: AgentRequestProposal,
) {
	if (proposal.kind === "external_agent") {
		const key = await getApiKeyById(context.db, proposal.credentialBindingId);
		if (
			await getExternalAgentPrincipalByCredential(context.db, {
				organizationId: orgId,
				credentialBindingId: proposal.credentialBindingId,
			})
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"This credential already has an external agent principal",
			);
		if (!key || key.organizationId !== orgId || key.status !== "active")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Credential binding must reference an active API key in this organization",
			);
	}
	if (proposal.kind === "connection" || proposal.kind === "connection_grant") {
		const references = await collectReferencedProviders(context.db, orgId);
		if (!references.ids.has(proposal.providerId))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Provider is not installed in this workspace",
			);
		if (proposal.kind === "connection_grant") {
			if (
				!(await getConnectionInstance(
					context.db,
					{ organizationId: orgId },
					proposal.connectionInstanceId,
					proposal.providerId,
				))
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Organization connection account not found",
				);
			if (proposal.policy.mode === "selected") {
				for (const id of proposal.policy.tediIds) {
					const tedi = await getTediByIdForOrganization(context.db, id, orgId);
					if (!tedi || tedi.retiredAt)
						throw createError(
							ErrorCodes.NOT_FOUND,
							"Consumer tedi is not active in this organization",
						);
				}
				for (const reference of proposal.policy.skills) {
					const skill = await getSkillEntry(context.db, reference.id, orgId);
					if (!skill || skill.revision !== reference.revision)
						throw createError(
							ErrorCodes.CONFLICT,
							"Consumer skill revision is not current in this organization",
						);
				}
			}
		} else {
			const provider = (await readConnectionProviders(context)).data.find(
				(row) => row.appId === proposal.providerId,
			);
			if (
				!provider ||
				connectionAccountMode(provider).mode !== "multiple" ||
				!provider.supportedScopes.includes("tenant")
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Provider does not support named organization OAuth accounts",
				);
			if (
				(await listConnectionInstances(context.db, { organizationId: orgId }))
					.length >= 100
			)
				throw createError(ErrorCodes.BAD_REQUEST, "Account limit reached");
		}
	}
}

export async function carryOutAgentRequestDecision(
	context: BaseContext,
	input: { orgId: string; proposalId: string; decisionId: string },
) {
	await requireOwnerAdminWorkItemAuthor(
		context,
		input.orgId,
		"Agent request execution",
	);
	const claimed = await claimAgentRequestExecution(context.db, input);
	if (!claimed) return;
	try {
		const proposal = AgentRequestProposalSchema.parse(claimed.proposal);
		await validateAgentRequestTarget(context, input.orgId, proposal);
		const owner = await getMemberByCanonicalUserId(
			context.db,
			input.orgId,
			proposal.ownerUserId,
		);
		if (!owner || owner.status !== "active" || owner.kind !== "human")
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Request owner is no longer active",
			);
		let resourceId: string;
		let message: string;
		if (proposal.kind === "tedi") {
			const { createTediForApprovedRequest } = await import("./tedis/create");
			const tedi = await createTediForApprovedRequest(context, proposal);
			resourceId = tedi.id;
			message = "Tedi created";
		} else if (proposal.kind === "external_agent") {
			const { externalAgentIdentityContractRouter } =
				await import("./external-agent-identity");
			const principal = await createRouterClient(
				externalAgentIdentityContractRouter,
				{ context },
			).createPrincipal({
				key: proposal.key,
				displayName: proposal.displayName,
				credentialBindingType: "api_key",
				credentialBindingId: proposal.credentialBindingId,
				metadata: {
					ownerUserId: proposal.ownerUserId,
					...(proposal.ownerTeam ? { ownerTeam: proposal.ownerTeam } : {}),
					justification: proposal.justification,
					dataSensitivity: proposal.dataSensitivity,
					approvalProposalId: claimed.id,
				},
			});
			if (principal.metadata.approvalProposalId !== claimed.id)
				throw createError(
					ErrorCodes.CONFLICT,
					"Credential was bound by another request",
				);
			resourceId = principal.id;
			message = "External agent registered against its existing credential";
		} else if (proposal.kind === "connection") {
			// New accounts have no agent consumers until a separate resource.grant decision.
			await setConnectionConsumerGrants(
				context.db,
				input.orgId,
				proposal.providerId,
				{ mode: "selected", tediIds: [], skills: [] },
				claimed.id,
			);
			const slot = await createConnectionInstance(context.db, {
				id: claimed.id,
				organizationId: input.orgId,
				ownerUserId: owner.descopeUserId,
				providerId: proposal.providerId,
				label: proposal.label,
				allowedResources: proposal.allowedResources,
				ownerTeam: proposal.ownerTeam,
				justification: proposal.justification,
				dataSensitivity: proposal.dataSensitivity,
			});
			resourceId = slot.id;
			message =
				"Account setup authorized; the person must finish provider consent and redeem their connect ticket";
		} else {
			const { setConsumerGrants } =
				await import("./connections/consumer-grants");
			await createRouterClient(
				{ setConsumerGrants },
				{ context },
			).setConsumerGrants({
				providerId: proposal.providerId,
				connectionInstanceId: proposal.connectionInstanceId,
				policy: proposal.policy,
			});
			resourceId = proposal.connectionInstanceId;
			message = "Connection consumer policy updated";
		}
		await finishAgentRequestExecution(context.db, {
			...input,
			execution: {
				status: "succeeded",
				resourceId,
				completedAt: new Date().toISOString(),
				message,
			},
		});
	} catch (error) {
		console.error("[work-approval] Agent request execution failed", {
			proposalId: input.proposalId,
			exception: safeExceptionTopology(error),
		});
		await finishAgentRequestExecution(context.db, {
			...input,
			execution: {
				status: "failed",
				completedAt: new Date().toISOString(),
				message:
					"Approval recorded; execution needs operator review. Inspect the target before requesting another action.",
			},
		});
	}
}

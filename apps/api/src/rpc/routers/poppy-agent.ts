import { implement } from "@orpc/server";
import { poppyAgentContract } from "@tedix/api-contract/contracts/poppy-agent";
import {
	getPoppyAgentIdentityView,
	setPoppyAgentIdentityEnabled,
} from "../../services/poppy-agent-identity";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import { withOrg } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { type TediAccessPolicy, requireTediAccess } from "../tedi-access";

const poppyAgentOs = implement(poppyAgentContract).$context<BaseContext>();

/**
 * Org members reach only tedis their organization owns; platform principals
 * keep cross-organization authority. The permission guards decide who may
 * toggle — a tedi credential never holds `tedis:update`/`tedis:read` scopes.
 */
const POPPY_AGENT_TEDI_ACCESS: TediAccessPolicy = {
	scope: "organization",
	missingOrganizationCode: "FORBIDDEN",
	platformAuthority: "platform-principal",
};

const get = poppyAgentOs.get
	.use(withAuth)
	.use(AUTHZ.tedisRead)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(
			context,
			input.tediId,
			POPPY_AGENT_TEDI_ACCESS,
		);
		return getPoppyAgentIdentityView(context.env, context.db, tedi);
	});

const setEnabled = poppyAgentOs.setEnabled
	.use(withAuth)
	.use(AUTHZ.tedisWrite)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(
			context,
			input.tediId,
			POPPY_AGENT_TEDI_ACCESS,
		);
		const actor = auditActor(context);
		const view = await setPoppyAgentIdentityEnabled(context.env, context.db, {
			tedi,
			enabled: input.enabled,
			actorId: actor.actorId,
		});
		await emitAuditEvent(context.db, {
			organizationId: context.organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: input.enabled
				? "poppy_agent.identity_enabled"
				: "poppy_agent.identity_disabled",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: { slug: tedi.slug, clientId: view.clientId },
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});
		return view;
	});

export const poppyAgentContractRouter = poppyAgentOs.router({
	get,
	setEnabled,
});

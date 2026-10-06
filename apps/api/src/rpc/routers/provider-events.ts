import { implement } from "@orpc/server";
import { providerEventsContract } from "@tedix/api-contract/contracts/provider-events";
import { listProviderEventSubscriptions } from "@tedix/db/queries/provider-events";
import { withAuth, withAuthorization, type BaseContext } from "../orpc";
import { requireOrgId } from "../org-scope";
import {
	registerSubscription,
	disableSubscription,
	loadSubscription,
	statusProjection,
	queueReconciliation,
} from "../../services/provider-events/subscriptions";
const authed = implement(providerEventsContract)
	.$context<BaseContext>()
	.use(withAuth);
export const providerEventsContractRouter = authed.router({
	register: authed.register
		.use(withAuthorization("integrations:manage", "integrations:manage"))
		.handler(({ context, input }) =>
			registerSubscription(context, requireOrgId(context), input),
		),
	list: authed.list
		.use(withAuthorization("integrations:manage", "integrations:manage"))
		.handler(async ({ context }) =>
			(
				await listProviderEventSubscriptions(context.db, requireOrgId(context))
			).map(statusProjection),
		),
	get: authed.get
		.use(withAuthorization("integrations:manage", "integrations:manage"))
		.handler(async ({ context, input }) =>
			statusProjection(
				await loadSubscription(context, requireOrgId(context), input.id),
			),
		),
	disable: authed.disable
		.use(withAuthorization("integrations:manage", "integrations:manage"))
		.handler(({ context, input }) =>
			disableSubscription(context, requireOrgId(context), input.id),
		),
	reconcile: authed.reconcile
		.use(withAuthorization("integrations:manage", "integrations:manage"))
		.handler(async ({ context, input }) => ({
			queued: await queueReconciliation(
				context,
				await loadSubscription(context, requireOrgId(context), input.id),
				`manual:${crypto.randomUUID()}`,
			),
		})),
});

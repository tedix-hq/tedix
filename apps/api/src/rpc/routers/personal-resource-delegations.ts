import { implement } from "@orpc/server";
import { personalResourceDelegationsContract } from "@tedix/api-contract/contracts/personal-resource-delegations";
import {
	createPersonalResourceDelegation,
	listPersonalResourceDelegations,
	revokePersonalResourceDelegation,
} from "@tedix/db/queries/personal-resource-delegations";
import type { PersonalResourceDelegationRow } from "@tedix/db/schema/personal-resource-delegations";
import {
	preparePersonalResourceDelegation,
	requirePersonalDelegationOwner,
} from "../../services/personal-resource-delegation-authority";
import {
	type BaseContext,
	withAuth,
	withAuthorization,
	createError,
	ErrorCodes,
} from "../orpc";
const os = implement(personalResourceDelegationsContract)
	.$context<BaseContext>()
	.use(withAuth);
function project(row: PersonalResourceDelegationRow) {
	const {
		accountSubject: _subject,
		grantFingerprint: _fingerprint,
		...publicRow
	} = row;
	return publicRow;
}
export const personalResourceDelegationsRouter = os.router({
	create: os.create
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Only an authenticated personal account owner with active organization membership may manage their own consent records",
				},
				"connections.read",
			),
		)
		.handler(async ({ context, input }) =>
			project(
				await createPersonalResourceDelegation(
					context.db,
					await preparePersonalResourceDelegation(context, input),
				),
			),
		),
	list: os.list
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Only an authenticated personal account owner with active organization membership may manage their own consent records",
				},
				"connections.read",
			),
		)
		.handler(async ({ context, input }) => {
			const owner = await requirePersonalDelegationOwner(context);
			return (
				await listPersonalResourceDelegations(context.db, {
					...owner,
					limit: input.limit,
				})
			).map(project);
		}),
	revoke: os.revoke
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Only an authenticated personal account owner with active organization membership may manage their own consent records",
				},
				"connections.read",
			),
		)
		.handler(async ({ context, input }) => {
			const owner = await requirePersonalDelegationOwner(context);
			const row = await revokePersonalResourceDelegation(context.db, {
				...owner,
				id: input.id,
				revokedAt: new Date().toISOString(),
			});
			if (!row)
				throw createError(ErrorCodes.NOT_FOUND, "Personal consent not found");
			return project(row);
		}),
});

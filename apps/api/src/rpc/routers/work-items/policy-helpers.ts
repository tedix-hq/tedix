import { implement } from "@orpc/server";
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { requireOrgId } from "../../org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../../orpc";
import {
	verifiedActiveUserMembership,
	verifiedActiveWorkActor,
} from "../work-items-principal";

export const workItemsOs = implement(workItemsContract).$context<BaseContext>();
export const authOs = workItemsOs.use(withAuth);

export async function assertWorkItemAccess(context: BaseContext, id: string) {
	const workItem = await getWorkItemById(context.db, id);
	if (!workItem) throw createError(ErrorCodes.NOT_FOUND, "Work Item not found");
	if (workItem.orgId !== requireOrgId(context))
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this Work Item");
	return workItem;
}

export async function requireOwnerAdminWorkItemAuthor(
	context: BaseContext,
	orgId: string,
	action = "Work Item lifecycle change",
): Promise<string> {
	const membership = await verifiedActiveUserMembership(
		context,
		orgId,
		"owner/admin",
	);
	if (
		membership?.status !== "active" ||
		(membership.role !== "owner" && membership.role !== "admin")
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`${action} requires a current active organization owner or admin membership`,
		);
	}
	return membership.userId;
}

/**
 * Dedicated scope that lets a NON-HUMAN principal fix a Work Item's acceptance
 * contract. Modelled on EARNED_DELEGATION_GOVERN_SCOPE: ordinary agent and org
 * keys fail closed, and `platform:admin` alone is deliberately NOT sufficient — the
 * owner grants this explicitly (`tedix agent start --agent-scopes`) or an agent
 * cannot make its own work executable.
 */
export const WORK_ACCEPT_SCOPE = "work:accept";

export function hasWorkAcceptanceScope(
	context: Pick<BaseContext, "authType" | "apiKey" | "tediScopes">,
): boolean {
	// A human principal is authorized by membership, never by scope.
	if (context.authType === "user") return false;
	const scopes = [
		...(context.apiKey?.scopes ?? []),
		...(context.tediScopes ?? []),
	];
	return scopes.includes(WORK_ACCEPT_SCOPE);
}

/**
 * Who may fix a Work Item's acceptance contract.
 *
 * Acceptance is the step that makes an item executable, and it used to require
 * an owner/admin USER — so an agent could create work but never start it, and
 * every autonomous change needed a human even for hygiene-class work. Tedix is
 * an agent-native factory, so a gateway-verified external agent or tedi may
 * accept under ITS OWN principal when its credential carries WORK_ACCEPT_SCOPE.
 *
 * This is about attribution and least privilege as much as capability: an agent
 * driving the owner's CLI OAuth session could already accept, and the board
 * recorded a human who had not acted. It now records who actually did.
 *
 * Human authority is unchanged — an owner/admin still accepts without any extra
 * scope, and every other principal fails closed with the scope named.
 */
export async function workItemAcceptanceActor(
	context: BaseContext,
	orgId: string,
): Promise<{ type: "user" | "tedi" | "external_agent"; id: string }> {
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type === "user") {
		return {
			type: "user",
			id: await requireOwnerAdminWorkItemAuthor(
				context,
				orgId,
				"Work Item acceptance",
			),
		};
	}
	if (!hasWorkAcceptanceScope(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Work Item acceptance by a ${actor.type} principal requires the ${WORK_ACCEPT_SCOPE} scope`,
		);
	}
	return { type: actor.type, id: actor.id };
}

/** Case/portfolio writes are restricted to owner/admin humans or active,
 * gateway-verified tedi/external-agent credentials. */
export async function verifiedWorkFactoryMutator(
	context: BaseContext,
	orgId: string,
) {
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type !== "user") return actor;
	return {
		type: "user" as const,
		id: await requireOwnerAdminWorkItemAuthor(
			context,
			orgId,
			"Work factory mutation",
		),
		sessionId: undefined,
		externalSessionKey: undefined,
	};
}

export function rethrowWorkItemWriteError(error: unknown): never {
	if (
		error instanceof Error &&
		error.name === "WorkFactoryError" &&
		"code" in error &&
		typeof error.code === "string"
	) {
		const code = error.code;
		if (code === "NOT_FOUND") {
			throw createError(ErrorCodes.NOT_FOUND, error.message);
		}
		if (
			code === "STALE_ATTEMPT" ||
			code === "EVIDENCE_CONFLICT" ||
			code === "NOT_READY"
		) {
			throw createError(ErrorCodes.CONFLICT, error.message);
		}
		if (
			code === "ACCEPTANCE_REQUIRED" ||
			code === "EVIDENCE_REQUIRED" ||
			code === "INDEPENDENT_REVIEW_REQUIRED"
		) {
			throw createError(ErrorCodes.UNPROCESSABLE_CONTENT, error.message);
		}
	}
	throw error;
}

export function rethrowWorkControlError(
	error: unknown,
	options: {
		invalidPrincipal?: "forbidden";
		notFound?: "bad_request";
		transitionConflict?: boolean;
	} = {},
): never {
	if (
		error instanceof Error &&
		error.name === "WorkControlError" &&
		"code" in error &&
		typeof error.code === "string"
	) {
		if (error.code === "NOT_FOUND")
			throw createError(
				options.notFound === "bad_request"
					? ErrorCodes.BAD_REQUEST
					: ErrorCodes.NOT_FOUND,
				error.message,
			);
		if (
			error.code === "CONFLICT" ||
			(options.transitionConflict && error.code === "INVALID_TRANSITION")
		) {
			throw createError(ErrorCodes.CONFLICT, error.message);
		}
		if (
			error.code === "INVALID_PRINCIPAL" &&
			options.invalidPrincipal === "forbidden"
		) {
			throw createError(ErrorCodes.FORBIDDEN, error.message);
		}
		if (
			["INVALID_PRINCIPAL", "INVALID_TRANSITION", "NOT_ELIGIBLE"].includes(
				error.code,
			)
		) {
			throw createError(ErrorCodes.UNPROCESSABLE_CONTENT, error.message);
		}
		throw createError(ErrorCodes.BAD_REQUEST, error.message);
	}
	throw error;
}

/**
 * Auth types that affirmatively prove a human operator or an operator-issued
 * key, mirroring `CAPABILITY_MUTATION_TRUSTED_AUTH_TYPES` in `tedis/crud.ts`.
 * Every other value — including `undefined` — is untrusted for this class of
 * decision regardless of the caller's own granted scopes.
 */
const RISK_LEVEL_TRUSTED_AUTH_TYPES = new Set(["user", "apikey"]);

/**
 * A Work Item's `riskLevel` decides whether admission needs an approval at all:
 * `requiredWorkAdmissionAuthorities` returns nothing below high/critical. The
 * schema defaults the field to `medium`, and creation used to forward whatever
 * the caller sent — so a scoped harness could declare its own work `low` and
 * admit it with no proposer/disposer pair ever existing. Lowering risk AFTER
 * creation was already human-only; setting it low AT creation was not, which
 * made "never lower risk to avoid admission" an honour system.
 *
 * Risk is therefore owner-held on the same terms as `budgets`: an untrusted
 * principal's value is discarded and the server default applies. This does not
 * make every agent-created item require an approval — medium-risk work still
 * self-admits by design — it removes the ability to DODGE one. Whenever an
 * approval is required, `'self approval is forbidden'` remains a D1 trigger.
 *
 * Returns `undefined` for an untrusted caller so the single default in
 * `createWorkItem` stays the one source of truth.
 */
export function ownerHeldRiskLevel<T>(
	authType: string | undefined,
	requested: T,
): T | undefined {
	return RISK_LEVEL_TRUSTED_AUTH_TYPES.has(String(authType ?? ""))
		? requested
		: undefined;
}

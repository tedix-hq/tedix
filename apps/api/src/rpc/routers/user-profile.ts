import { baseErrorConstructors } from "@tedix/api-contract/errors";
/**
 * Account-wide human profile. D1 is the editable profile authority; Descope
 * remains the authority for login identifiers, credentials, MFA and sessions.
 * The caller never supplies an id, so neither tenant administration nor a
 * machine credential can substitute another user.
 */

import { implement } from "@orpc/server";
import { userProfileContract } from "@tedix/api-contract/contracts/user-profile";
import {
	getUserConfig,
	upsertUserConfig,
} from "@tedix/db/queries/user-configs";
import { getUserById, updateUserProfile } from "@tedix/db/queries/users";
import {
	buildDeliveryUrl,
	deleteCfImage,
	extractImageId,
	getCfImage,
	requestDirectUpload,
} from "../../lib/cf-images";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

const os = implement(userProfileContract).$context<BaseContext>();
const authed = os.use(withAuth);

export function requireHumanUserId(context: BaseContext): string {
	if (context.authType === "user" && context.user?.sub && context.userId) {
		return context.userId;
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"A canonical authenticated human identity is required",
	);
}

async function profileOutput(
	context: BaseContext,
	user: Awaited<ReturnType<typeof getUserById>>,
) {
	if (!user) {
		throw createError(ErrorCodes.NOT_FOUND, "User profile not found");
	}
	const avatarUrl = (() => {
		const value = user.avatarUrl?.trim();
		if (!value) return null;
		try {
			const protocol = new URL(value).protocol;
			return protocol === "https:" || protocol === "http:" ? value : null;
		} catch {
			return null;
		}
	})();
	const welcome = (await getUserConfig(context.db, welcomeKey(user.id)))?.value;
	return {
		id: user.id,
		email: user.email,
		name: user.name ?? null,
		avatarUrl,
		revision: user.profileRevision,
		updatedAt: user.updatedAt ?? null,
		welcomeCompleted: accountIsNewSince(user.createdAt, WELCOME_SINCE)
			? welcome?.completed === true
			: true,
		getStartedHidden: welcome?.checklistHidden === true,
	};
}

async function verifyAvatarUpload(
	context: BaseContext,
	userId: string,
	input: { imageId: string; uploadNonce: string },
): Promise<number> {
	const image = await getCfImage(context.env, input.imageId);
	if (!image) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Uploaded image not found; the upload may not have completed",
		);
	}
	const expectedRevision = Number(image.meta?.profileRevision);
	if (
		image.meta?.entityType !== "user" ||
		image.meta.canonicalUserId !== userId ||
		image.meta.uploadNonce !== input.uploadNonce ||
		!Number.isSafeInteger(expectedRevision) ||
		expectedRevision < 1
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Uploaded image metadata does not match this profile operation",
		);
	}
	return expectedRevision;
}

const getMine = authed.getMine
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires an authenticated human and derives the only profile id from the credential-resolved canonical user.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context }) => {
		const userId = requireHumanUserId(context);
		return profileOutput(context, await getUserById(context.db, userId));
	});

const updateMine = authed.updateMine
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires an authenticated human and derives the only profile id from the credential-resolved canonical user.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context, input }) => {
		const userId = requireHumanUserId(context);
		const updated = await updateUserProfile(context.db, {
			userId,
			name: input.name,
			expectedRevision: input.expectedRevision,
		});
		if (!updated) {
			const current = await getUserById(context.db, userId);
			throw baseErrorConstructors.CONFLICT({
				message:
					"Profile revision compare-and-swap lost against another update",
				data: {
					expectedRevision: input.expectedRevision,
					currentRevision: current?.profileRevision ?? null,
				},
			});
		}
		return profileOutput(context, updated);
	});

const requestAvatarUpload = authed.requestAvatarUpload
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires an authenticated human and derives the only profile id from the credential-resolved canonical user.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context }) => {
		const userId = requireHumanUserId(context);
		const current = await getUserById(context.db, userId);
		if (!current) {
			throw createError(ErrorCodes.NOT_FOUND, "User profile not found");
		}
		const uploadNonce = crypto.randomUUID();
		const { id, uploadURL } = await requestDirectUpload(context.env, {
			metadata: {
				entityType: "user",
				canonicalUserId: userId,
				uploadNonce,
				profileRevision: String(current.profileRevision),
			},
		});
		return { imageId: id, uploadURL, uploadNonce };
	});

const confirmAvatarUpload = authed.confirmAvatarUpload
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires an authenticated human and derives the only profile id from the credential-resolved canonical user.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context, input }) => {
		const userId = requireHumanUserId(context);
		const expectedRevision = await verifyAvatarUpload(context, userId, input);

		const current = await getUserById(context.db, userId);
		if (!current) {
			throw createError(ErrorCodes.NOT_FOUND, "User profile not found");
		}
		const url = buildDeliveryUrl(context.env.CF_ACCOUNT_HASH, input.imageId);
		const updated = await updateUserProfile(context.db, {
			userId,
			avatarUrl: url,
			expectedRevision,
		});
		if (!updated) {
			await deleteCfImage(context.env, input.imageId).catch(() => {});
			const latest = await getUserById(context.db, userId);
			throw baseErrorConstructors.CONFLICT({
				message: "Profile changed after the avatar upload was requested",
				data: {
					expectedRevision,
					currentRevision: latest?.profileRevision ?? null,
				},
			});
		}

		const previousId = extractImageId(current.avatarUrl);
		if (previousId && previousId !== input.imageId) {
			await deleteCfImage(context.env, previousId).catch(() => {});
		}
		return { url, imageId: input.imageId, revision: updated.profileRevision };
	});

const deleteAvatar = authed.deleteAvatar
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires an authenticated human and derives the only profile id from the credential-resolved canonical user.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context, input }) => {
		const userId = requireHumanUserId(context);
		const current = await getUserById(context.db, userId);
		if (!current) {
			throw createError(ErrorCodes.NOT_FOUND, "User profile not found");
		}
		const updated = await updateUserProfile(context.db, {
			userId,
			avatarUrl: null,
			expectedRevision: input.expectedRevision,
		});
		if (!updated) {
			const latest = await getUserById(context.db, userId);
			throw baseErrorConstructors.CONFLICT({
				message: "Profile changed before the avatar could be deleted",
				data: {
					expectedRevision: input.expectedRevision,
					currentRevision: latest?.profileRevision ?? null,
				},
			});
		}
		const previousId = extractImageId(current.avatarUrl);
		if (previousId) {
			await deleteCfImage(context.env, previousId).catch(() => {});
		}
		return { success: true as const, revision: updated.profileRevision };
	});

/** The day the welcome shipped: accounts created before it are not new. */
const WELCOME_SINCE = Date.parse("2026-11-19T00:00:00.000Z");

/** `created_at` is ISO, or SQLite's `YYYY-MM-DD HH:MM:SS` in UTC. */
function accountIsNewSince(
	createdAt: string | null | undefined,
	since: number,
): boolean {
	if (!createdAt) return false;
	const at = Date.parse(
		createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`,
	);
	return Number.isFinite(at) && at >= since;
}

// Account-wide: moving to another organization must not restart the welcome.
const welcomeKey = (userId: string) => ({
	userId,
	namespace: "os.welcome",
	key: "account",
});

const completeWelcome = authed.completeWelcome
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only the credential-resolved human can read or complete their own welcome.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context, input }) => {
		const key = welcomeKey(requireHumanUserId(context));
		const current = (await getUserConfig(context.db, key))?.value;
		await upsertUserConfig(context.db, {
			...key,
			value: {
				...current,
				completed: true,
				...(input.hideChecklist ? { checklistHidden: true } : {}),
			},
		});
		return { completed: true };
	});

export const userProfileContractRouter = os.router({
	completeWelcome,
	getMine,
	updateMine,
	requestAvatarUpload,
	confirmAvatarUpload,
	deleteAvatar,
});

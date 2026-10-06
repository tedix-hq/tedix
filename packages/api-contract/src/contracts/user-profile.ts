import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

export const UserProfileSchema = z.object({
	id: z
		.string()
		.min(1)
		.describe(
			"Opaque canonical Tedix user id; legacy rows may retain a provider subject",
		),
	email: z.email(),
	name: z
		.string()
		.nullable()
		.describe(
			"Null until the human or identity bootstrap supplies a display name",
		),
	avatarUrl: z
		.url()
		.nullable()
		.describe("Null when the human has no managed Tedix avatar"),
	revision: z.number().int().min(1),
	updatedAt: z
		.string()
		.nullable()
		.describe(
			"Null only for legacy profile rows that predate update timestamps",
		),
});

const profileConflictErrors = {
	CONFLICT: {
		message: "Profile revision conflict",
		data: z
			.object({
				expectedRevision: z.number().int().min(1),
				currentRevision: z
					.number()
					.int()
					.min(1)
					.nullable()
					.describe("Null only if the canonical profile no longer exists"),
			})
			.optional()
			.describe(
				"Optional for compatibility with generic conflict responses that carry no revision details",
			),
	},
} as const;

export const userProfileContract = oc
	.route({ tags: ["user-profile"], prefix: "/user-profile" })
	.errors(baseErrors)
	.router({
		getMine: oc
			.route({
				method: "GET",
				path: "/mine",
				summary: "Get the authenticated human's profile",
			})
			.input(z.object({}))
			.output(UserProfileSchema),

		updateMine: oc
			.route({
				method: "PUT",
				path: "/mine",
				summary: "Update the authenticated human's display name",
				description:
					"Updates the canonical Tedix profile with optimistic concurrency. Email and authentication security remain provider-owned; avatars use the managed Images lifecycle.",
			})
			.errors(profileConflictErrors)
			.input(
				z.object({
					name: z.string().trim().min(1).max(100),
					expectedRevision: z.number().int().min(1),
				}),
			)
			.output(UserProfileSchema),

		requestAvatarUpload: oc
			.route({
				method: "POST",
				path: "/avatar/request-upload",
				summary: "Mint a one-time upload URL for the caller's avatar",
				description:
					"The resulting avatar is publicly deliverable by its unguessable Cloudflare Images URL. Authentication protects mutation, not possession of the delivery URL.",
			})
			.input(z.object({}))
			.output(
				z.object({
					imageId: z.string().min(1),
					uploadURL: z.url(),
					uploadNonce: z.uuid(),
				}),
			),

		confirmAvatarUpload: oc
			.route({
				method: "POST",
				path: "/avatar/confirm-upload",
				summary: "Confirm and bind the caller's uploaded avatar",
			})
			.errors(profileConflictErrors)
			.input(
				z.object({
					imageId: z.string().min(1),
					uploadNonce: z.uuid(),
				}),
			)
			.output(
				z.object({
					url: z.url(),
					imageId: z.string().min(1),
					revision: z.number().int().min(1),
				}),
			),

		deleteAvatar: oc
			.route({
				method: "DELETE",
				path: "/avatar",
				summary: "Delete the caller's managed avatar",
			})
			.errors(profileConflictErrors)
			.input(z.object({ expectedRevision: z.number().int().min(1) }))
			.output(
				z.object({
					success: z.literal(true),
					revision: z.number().int().min(1),
				}),
			),
	});

export type UserProfileContract = typeof userProfileContract;

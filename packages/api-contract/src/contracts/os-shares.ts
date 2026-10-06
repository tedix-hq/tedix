import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { OsCreatedByKindSchema } from "../schemas/os-workspaces";

/**
 * Tedix OS governed sharing: revocable capability links for outputs,
 * Gadgets, and workspaces. D1 `os_share_links` and `os_share_sessions` are
 * canonical. A link is a
 * random 256-bit token returned exactly once at creation; only its sha-256
 * hash persists, so the wire share shape never carries the token or its hash.
 * Redemption exchanges the fragment-only link secret for a short-lived,
 * hash-only session and an atomic first resource read. Policy may narrow a
 * role but never widen it.
 *
 * Internal + MCP projection only — no REST publication. All ids are UUIDs.
 */

export const OsShareResourceTypeSchema = z.enum([
	"output",
	"gadget",
	"workspace",
]);

export const OsShareRoleSchema = z.enum(["viewer", "use", "build"]);

export const OsShareRevisionModeSchema = z.enum(["living", "pinned"]);

/** One share link, backed by `os_share_links`. Never carries token material. */
export const OsShareLinkSchema = z.object({
	id: z.string().uuid(),
	organizationId: z.string(),
	resourceType: OsShareResourceTypeSchema,
	resourceId: z.string().uuid(),
	role: OsShareRoleSchema,
	revisionMode: OsShareRevisionModeSchema,
	pinnedRevisionId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"Exact immutable revision for a pinned Gadget/output link; null for living links and pinned Workspace snapshots",
		),
	note: z
		.string()
		.nullable()
		.describe("Optional owner-authored context shown to link recipients"),
	policyMaxRole: OsShareRoleSchema.nullable().describe(
		"Current policy ceiling; null means no policy restriction beyond the authored role",
	),
	policyReason: z
		.string()
		.nullable()
		.describe(
			"Auditable reason for the current policy ceiling, or null when unrestricted",
		),
	policyRestrictedAt: z
		.string()
		.nullable()
		.describe(
			"ISO timestamp of the current policy restriction, or null when unrestricted",
		),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	expiresAt: z
		.string()
		.nullable()
		.describe(
			"ISO-8601 expiry after which the link stops redeeming; null links never expire",
		),
	revokedAt: z
		.string()
		.nullable()
		.describe(
			"Set when the link was revoked; a revoked link never redeems again",
		),
});

export type OsShareResourceType = z.infer<typeof OsShareResourceTypeSchema>;
export type OsShareRole = z.infer<typeof OsShareRoleSchema>;
export type OsShareRevisionMode = z.infer<typeof OsShareRevisionModeSchema>;
export type OsShareLink = z.infer<typeof OsShareLinkSchema>;

const createShareInput = z
	.object({
		resourceType: OsShareResourceTypeSchema.describe(
			"Resource kind for governed Gadget, workspace, or output sharing",
		),
		resourceId: z
			.string()
			.uuid()
			.describe("Resource UUID paired with resourceType"),
		role: OsShareRoleSchema.default("viewer"),
		revisionMode: OsShareRevisionModeSchema.default("living"),
		pinnedRevisionId: z
			.string()
			.uuid()
			.optional()
			.describe(
				"Required only for pinned Gadget/output links; Workspace pins capture a safe snapshot",
			),
		note: z
			.string()
			.trim()
			.max(240)
			.optional()
			.describe("Optional recipient-facing reason for granting this access"),
		expiresAt: z
			.string()
			.datetime({ offset: true })
			.optional()
			.describe(
				"Optional ISO-8601 expiry after which the link and every redemption session stop working",
			),
	})
	.superRefine((input, context) => {
		const resourceType = input.resourceType;
		if (resourceType === "output" && input.role !== "viewer") {
			context.addIssue({
				code: "custom",
				path: ["role"],
				message: "Output shares are read-only viewer links",
			});
		}
		if (resourceType && resourceType !== "output" && input.role === "viewer") {
			context.addIssue({
				code: "custom",
				path: ["role"],
				message: "Gadget and workspace shares use the use or build role",
			});
		}
		if (
			input.revisionMode === "pinned" &&
			resourceType !== "workspace" &&
			!input.pinnedRevisionId
		) {
			context.addIssue({
				code: "custom",
				path: ["pinnedRevisionId"],
				message: "Pinned Gadget and output shares require a revision id",
			});
		}
		if (input.revisionMode === "living" && input.pinnedRevisionId) {
			context.addIssue({
				code: "custom",
				path: ["pinnedRevisionId"],
				message: "Living shares cannot name a pinned revision",
			});
		}
	});

const listShareInput = z.object({
	resourceType: OsShareResourceTypeSchema.describe("Resource kind"),
	resourceId: z
		.string()
		.uuid()
		.describe("Resource UUID paired with resourceType"),
});

export const osSharesContract = oc
	.route({ tags: ["os-shares"], prefix: "/os-shares" })
	.errors(baseErrors)
	.router({
		shares: oc.router({
			create: oc
				.route({
					method: "POST",
					path: "/resources/{resourceType}/{resourceId}/shares",
					summary: "Create a governed Tedix OS share link",
					description:
						"Mints a role-aware living or pinned link. The returned token is the ONE-TIME plaintext capability; only its sha-256 hash persists. Outputs are viewer-only; Gadget and workspace links use use/build roles without transferring owner credentials or connections.",
				})
				.input(createShareInput)
				.output(
					z.object({
						share: OsShareLinkSchema,
						/** The one-time plaintext token; never retrievable again. */
						token: z.string(),
					}),
				),
			list: oc
				.route({
					method: "GET",
					path: "/resources/{resourceType}/{resourceId}/shares",
					summary: "List share links for a Tedix OS resource",
					description:
						"Returns every link minted for the output, newest first, including revoked and expired ones — the state fields say which still redeem.",
				})
				.input(listShareInput)
				.output(z.object({ items: z.array(OsShareLinkSchema) })),
			previewRevoke: oc
				.route({
					method: "GET",
					path: "/shares/{shareId}/revocation-impact",
					summary: "Preview live sessions affected by share-link revocation",
				})
				.input(z.object({ shareId: z.string().uuid() }))
				.output(
					z.object({
						share: OsShareLinkSchema,
						activeSessionCount: z.number().int().nonnegative(),
					}),
				),
			revoke: oc
				.route({
					method: "POST",
					path: "/shares/{shareId}/revoke",
					summary: "Revoke a Tedix OS share link",
					description:
						"Stamps revokedAt so the link never redeems again. Idempotent: revoking an already-revoked link keeps the original timestamp.",
				})
				.input(z.object({ shareId: z.string().uuid() }))
				.output(
					z.object({
						share: OsShareLinkSchema,
						revokedSessionCount: z.number().int().nonnegative(),
					}),
				),
			restrict: oc
				.route({
					method: "POST",
					path: "/shares/{shareId}/policy",
					summary: "Narrow a share link after a policy observation",
					description:
						"Sets a monotonic policy maximum role. The effective role may stay unchanged or tighten, but an existing ceiling can never be cleared or widened. Tightening revokes existing redemption sessions.",
				})
				.input(
					z.object({
						shareId: z.string().uuid(),
						maxRole: OsShareRoleSchema.describe(
							"New policy ceiling; it must be at or below both the authored role and any existing ceiling",
						),
						reason: z
							.string()
							.trim()
							.min(1)
							.max(1000)
							.describe(
								"Auditable reason for setting or reaffirming the ceiling",
							),
					}),
				)
				.output(
					z.object({
						share: OsShareLinkSchema,
						revokedSessionCount: z.number().int().nonnegative(),
					}),
				),
			delete: oc
				.route({
					method: "DELETE",
					path: "/shares/{shareId}",
					summary: "Permanently delete a revoked Tedix OS share link",
					description:
						"Requires os:admin and an already-revoked link. Deletes its hash-only redemption sessions; retained audit rows continue to name the stable share id.",
				})
				.input(z.object({ shareId: z.string().uuid() }))
				.output(z.object({ deleted: z.literal(true) })),
		}),
	});

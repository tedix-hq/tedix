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

/**
 * Who may open a link. `anyone_with_link` needs no account (today's guest
 * scope); `organization` needs a signed-in member of the link's organization;
 * `invited` needs a signed-in person on the link's invite list (a workspace
 * link also admits its collaborators).
 */
export const OsShareAccessSchema = z.enum([
	"anyone_with_link",
	"organization",
	"invited",
]);

/**
 * The permanent id in a share URL (`/s/<id>`): 22 base62 characters, random
 * and unguessable, stable for the link's life. Links minted before permanent
 * ids were backfilled with 22 hex characters, which this pattern also admits.
 */
export const OS_SHARE_PUBLIC_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/** One share link, backed by `os_share_links`. Never carries token material. */
export const OsShareLinkSchema = z.object({
	id: z.string().uuid(),
	publicId: z
		.string()
		.regex(OS_SHARE_PUBLIC_ID_PATTERN)
		.describe("Permanent id in the share URL; never the secret token"),
	url: z
		.string()
		.url()
		.describe(
			"The bookmarkable link on the organization's own OS host: https://<org>.os.tedix.dev/s/<publicId>/<title-slug>; only the id resolves",
		),
	organizationId: z.string(),
	resourceType: OsShareResourceTypeSchema,
	resourceId: z.string().uuid(),
	access: OsShareAccessSchema,
	role: OsShareRoleSchema,
	revisionMode: OsShareRevisionModeSchema,
	pinnedRevisionId: z
		.string()
		.uuid()
		.nullable()
		.describe(
			"Exact immutable revision for a pinned app/output link; null for living links and pinned Workspace snapshots",
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
	disabledAt: z
		.string()
		.nullable()
		.describe(
			"Set while the link is turned off: it stops redeeming but keeps its address, and turning it back on clears this and revives the same address",
		),
});

export type OsShareResourceType = z.infer<typeof OsShareResourceTypeSchema>;
export type OsShareRole = z.infer<typeof OsShareRoleSchema>;
export type OsShareRevisionMode = z.infer<typeof OsShareRevisionModeSchema>;
export type OsShareAccess = z.infer<typeof OsShareAccessSchema>;
export type OsShareLink = z.infer<typeof OsShareLinkSchema>;

/** One person on an `invited` link's list, by email or by Tedix user id. */
export const OsShareInviteeSchema = z.object({
	id: z.string().uuid(),
	shareLinkId: z.string().uuid(),
	email: z.string().nullable(),
	userId: z
		.string()
		.nullable()
		.describe("Tedix user id when the person already has an account"),
	name: z.string().nullable(),
	addedByKind: OsCreatedByKindSchema,
	addedById: z.string(),
	addedAt: z.string(),
});
export type OsShareInvitee = z.infer<typeof OsShareInviteeSchema>;

/**
 * `POST /os-shared/open` on the organization's OS host: the public route
 * behind `/s/<id>`. It is not an oRPC procedure because it must answer
 * signed-out visitors; the host proxy forwards the visitor's own session for
 * `organization` and `invited` links. A link resolves only on its own
 * organization's host; anywhere else, and for revoked, expired, unknown or
 * refused links, the answer is the same 404.
 */
export const OsShareOpenInputSchema = z.object({
	id: z.string().regex(OS_SHARE_PUBLIC_ID_PATTERN),
});
export const OsShareOpenResultSchema = z.object({
	needsSignIn: z
		.boolean()
		.describe(
			"True when the link needs a signed-in person and none was presented; sign in on this host, then reopen /s/<id>",
		),
	access: OsShareAccessSchema,
	organization: z
		.object({
			name: z.string(),
			logoUrl: z.string().nullable(),
			locale: z.string().nullable(),
			copy: z.record(z.string(), z.record(z.string(), z.string())),
		})
		.nullable(),
	/** Present only when the link opened. Same envelope as token redemption. */
	share: z
		.object({
			id: z.string().uuid(),
			publicId: z.string(),
			access: OsShareAccessSchema,
			resourceType: OsShareResourceTypeSchema,
			role: OsShareRoleSchema,
			effectiveRole: OsShareRoleSchema,
			revisionMode: OsShareRevisionModeSchema,
			note: z.string().nullable(),
			expiresAt: z.string().nullable(),
			createdAt: z.string(),
			createdByKind: OsCreatedByKindSchema,
			/** Display name of the person or agent who made the link, when known. */
			sharedByName: z.string().nullable(),
			/** The readable suffix of the link's address, from the shared title. */
			slug: z.string(),
			policyReason: z.string().nullable(),
			policyRestrictedAt: z.string().nullable(),
		})
		.optional(),
	resource: z.unknown().optional(),
	/**
	 * True when the caller's own session may manage this link (create, turn
	 * off or delete share links), so the page can offer them the Share dialog.
	 */
	canManage: z.boolean().optional(),
	/** A 12-hour session; keep it in sessionStorage under `tedix.os.share.<id>`. */
	sessionToken: z.string().optional(),
});
export type OsShareOpenInput = z.infer<typeof OsShareOpenInputSchema>;
export type OsShareOpenResult = z.infer<typeof OsShareOpenResultSchema>;

/**
 * `POST /os-shared/preview`: what a chat app or social site may show when
 * someone pastes `/s/<id>`. The OS Worker calls it for the document and
 * writes the answer into the page's Open Graph tags. Only a link a
 * signed-out stranger could open names its content; every other link, and
 * every unknown, revoked or refused id, gets the same generic answer, so the
 * preview never reveals more than opening the link would.
 */
export const OsSharePreviewSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("generic") }),
	z.object({
		kind: z.literal("content"),
		title: z.string(),
		description: z.string().nullable(),
		resourceType: OsShareResourceTypeSchema,
		organizationName: z.string(),
	}),
]);
export type OsSharePreview = z.infer<typeof OsSharePreviewSchema>;

export const OsReviewCardSchema = z.object({
	id: z.string().trim().min(1).max(100),
	title: z.string().trim().min(1).max(240),
	url: z
		.string()
		.url()
		.refine(
			(value) => new URL(value).protocol === "https:",
			"Use an HTTPS evidence link",
		),
	relevance: z.string().max(4000),
	draft: z.string().max(8000),
	evidence: z
		.array(
			z.object({
				label: z.string().min(1).max(100),
				url: z
					.string()
					.url()
					.refine(
						(value) => new URL(value).protocol === "https:",
						"Use HTTPS evidence links",
					),
			}),
		)
		.max(20)
		.default([]),
	effort: z.enum(["low", "medium", "high"]),
	checks: z.array(z.string().max(1000)).max(20),
});
export const OsReviewFeedbackSchema = z.object({
	cardId: z.string(),
	reviewerId: z.string(),
	revision: z.number().int().positive(),
	decision: z.enum(["needs_checking", "edit", "skip", "ready"]),
	editedReply: z.string().max(8000),
	reason: z.string().max(4000),
	updatedAt: z.string(),
});
export const OsReviewBatchSchema = z.object({
	id: z.string().uuid(),
	shareId: z.string().uuid(),
	title: z.string(),
	sourceOutputId: z.string().uuid(),
	sourceRevisionId: z.string().uuid(),
	createdById: z.string(),
	createdAt: z.string(),
	cards: z.array(OsReviewCardSchema),
});
export type OsReviewCard = z.infer<typeof OsReviewCardSchema>;
export type OsReviewBatch = z.infer<typeof OsReviewBatchSchema>;
export type OsReviewFeedback = z.infer<typeof OsReviewFeedbackSchema>;
const reviewSessionInput = z.object({
	shareId: z.string().uuid(),
	sessionToken: z.string().min(20).max(128),
});
const reviewGadgetInput = z.object({
	workspaceId: z.string().uuid().describe("Workspace that contains the app"),
	gadgetId: z
		.string()
		.uuid()
		.describe("App whose active review link binds the batch"),
});
const reviewFeedbackFields = {
	batchId: z.string().uuid(),
	cardId: z.string().min(1).max(100),
	expectedRevision: z.number().int().nonnegative(),
	decision: OsReviewFeedbackSchema.shape.decision,
	editedReply: z.string().max(8000),
	reason: z.string().max(4000),
};

const createShareInput = z
	.object({
		resourceType: OsShareResourceTypeSchema.describe(
			"Resource kind for governed App, workspace, or output sharing",
		),
		resourceId: z
			.string()
			.uuid()
			.describe("Resource UUID paired with resourceType"),
		role: OsShareRoleSchema.default("viewer"),
		access: OsShareAccessSchema.default("anyone_with_link"),
		revisionMode: OsShareRevisionModeSchema.default("living"),
		pinnedRevisionId: z
			.string()
			.uuid()
			.optional()
			.describe(
				"Required only for pinned app/output links; Workspace pins capture a safe snapshot",
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
				message: "App and workspace shares use the use or build role",
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
				message: "Pinned App and output shares require a revision id",
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

const inviteeScopeInput = z.object({ shareId: z.string().uuid() });

export const osSharesContract = oc
	.route({ tags: ["os-shares"], prefix: "/os-shares" })
	.errors(baseErrors)
	.router({
		reviews: oc.router({
			create: oc
				.route({
					method: "POST",
					path: "/reviews",
					summary: "Approve an immutable review batch",
				})
				.input(
					z
						.object({
							shareId: z.string().uuid(),
							sourceOutputId: z.string().uuid(),
							sourceRevisionId: z.string().uuid(),
							title: z.string().trim().min(1).max(240),
							cards: z.array(OsReviewCardSchema).min(1).max(50),
						})
						.superRefine((v, c) => {
							if (
								new Set(v.cards.map((card) => card.id)).size !== v.cards.length
							)
								c.addIssue({
									code: "custom",
									path: ["cards"],
									message: "Card ids must be unique",
								});
						}),
				)
				.output(z.object({ batch: OsReviewBatchSchema })),
			listFeedback: oc
				.route({
					method: "GET",
					path: "/reviews/feedback",
					summary: "Read saved feedback for an owner-approved batch",
				})
				.input(
					z
						.object({
							shareId: z.string().uuid(),
							batchId: z
								.string()
								.uuid()
								.optional()
								.describe(
									"An earlier round on this link; omitted reads the current (newest) round",
								),
						})
						.strict(),
				)
				.output(
					z.object({
						batch: OsReviewBatchSchema,
						feedback: z.array(OsReviewFeedbackSchema),
						rounds: z
							.array(
								z.object({
									id: z.string().uuid(),
									title: z.string(),
									createdAt: z.string(),
								}),
							)
							.describe("Every review round on this link, newest first"),
					}),
				),
			get: oc
				.route({
					method: "GET",
					path: "/reviews",
					summary: "Read a shared review batch",
				})
				.input(reviewSessionInput)
				.output(
					z.object({
						batch: OsReviewBatchSchema.nullable(),
						feedback: z.array(OsReviewFeedbackSchema),
					}),
				),
			saveFeedback: oc
				.route({
					method: "POST",
					path: "/reviews/feedback",
					summary: "Save your review feedback",
				})
				.input(reviewSessionInput.extend(reviewFeedbackFields))
				.output(z.object({ feedback: OsReviewFeedbackSchema })),
			getForGadget: oc
				.route({
					method: "GET",
					path: "/reviews/gadgets/{gadgetId}",
					summary: "Read your review of an app's active batch",
					description:
						"Workspace members see the same immutable batch an app's active review link shows recipients, with only their own saved feedback. Returns a null batch when no active review link is bound.",
				})
				.input(reviewGadgetInput.strict())
				.output(
					z.object({
						batch: OsReviewBatchSchema.nullable(),
						feedback: z.array(OsReviewFeedbackSchema),
					}),
				),
			saveGadgetFeedback: oc
				.route({
					method: "POST",
					path: "/reviews/gadgets/{gadgetId}/feedback",
					summary: "Save your review feedback from the workspace",
					description:
						"Writes the same per-reviewer, conflict-checked feedback record as the shared review link. Requires workspace access to the app and an active review link; never changes the source output.",
				})
				.input(reviewGadgetInput.extend(reviewFeedbackFields))
				.output(z.object({ feedback: OsReviewFeedbackSchema })),
		}),
		shares: oc.router({
			create: oc
				.route({
					method: "POST",
					path: "/resources/{resourceType}/{resourceId}/shares",
					summary: "Create a governed Tedix OS share link",
					description:
						"Mints a role-aware living or pinned link. The returned token is the ONE-TIME plaintext capability; only its sha-256 hash persists. Outputs are viewer-only; App and workspace links use use/build roles without transferring owner credentials or connections.",
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
				.output(
					z.object({
						items: z.array(OsShareLinkSchema),
						guestRefusal: z
							.object({
								slot: z.string(),
								reason: z.enum(["connection_grant", "unshared_output"]),
							})
							.nullable()
							.optional()
							.describe(
								"For an app that runs its own code: why people without a Tedix account cannot open it through a use link, or null when they can. Absent for other resources.",
							),
					}),
				),
			update: oc
				.route({
					method: "PATCH",
					path: "/shares/{shareId}",
					summary: "Change a share link's note, expiry, role or access",
					description:
						"Edits an active link in place: the link keeps working at the same permanent URL. Requires os:admin. Narrowing the role, tightening access, or bringing the expiry forward ends live redemption sessions; recipients reopen the same link at the new settings.",
				})
				.input(
					z
						.object({
							shareId: z.string().uuid(),
							role: OsShareRoleSchema.optional().describe(
								"New authored role; outputs stay viewer, App and workspace links use or build",
							),
							access: OsShareAccessSchema.optional().describe(
								"Who may open the link; tightening ends live sessions",
							),
							note: z
								.string()
								.trim()
								.max(240)
								.nullable()
								.optional()
								.describe("New recipient-facing note; null or empty clears it"),
							expiresAt: z
								.string()
								.datetime({ offset: true })
								.nullable()
								.optional()
								.describe(
									"New future ISO-8601 expiry; null makes the link never expire",
								),
						})
						.strict(),
				)
				.output(
					z.object({
						share: OsShareLinkSchema,
						revokedSessionCount: z.number().int().nonnegative(),
					}),
				),
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
			setDisabled: oc
				.route({
					method: "POST",
					path: "/shares/{shareId}/disabled",
					summary: "Turn a share link off or back on, keeping its address",
					description:
						"Unlike revocation, turning a link off is reversible: it stops redeeming and ends live sessions, but the address stays reserved and turning it back on revives the same address with no new id.",
				})
				.input(
					z
						.object({
							shareId: z.string().uuid(),
							disabled: z
								.boolean()
								.describe(
									"true turns the link off; false turns it back on at the same address",
								),
						})
						.strict(),
				)
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
					summary: "Permanently delete a Tedix OS share link",
					description:
						"Requires os:admin. Revokes the link if needed — the permanent-forever counterpart to turning it off — then deletes its row, so a new link mints a new address.",
				})
				.input(z.object({ shareId: z.string().uuid() }))
				.output(z.object({ deleted: z.literal(true) })),
			invitees: oc.router({
				list: oc
					.route({
						method: "GET",
						path: "/shares/{shareId}/invitees",
						summary: "List who an invited-only share link admits",
					})
					.input(inviteeScopeInput.strict())
					.output(z.object({ items: z.array(OsShareInviteeSchema) })),
				add: oc
					.route({
						method: "POST",
						path: "/shares/{shareId}/invitees",
						summary: "Invite a person to a share link",
						description:
							"Adds an email to the link's invite list. A matching Tedix account is bound by user id as well, so the person is admitted whichever identity their session carries. Adding the same email twice returns the existing row.",
					})
					.input(
						inviteeScopeInput
							.extend({
								email: z.string().trim().toLowerCase().email().max(320),
							})
							.strict(),
					)
					.output(z.object({ invitee: OsShareInviteeSchema })),
				remove: oc
					.route({
						method: "DELETE",
						path: "/shares/{shareId}/invitees/{inviteeId}",
						summary: "Remove a person from a share link",
						description:
							"Every session read rechecks the invite list, so removal takes effect on the person's next read.",
					})
					.input(
						inviteeScopeInput.extend({ inviteeId: z.string().uuid() }).strict(),
					)
					.output(z.object({ removed: z.boolean() })),
			}),
		}),
	});

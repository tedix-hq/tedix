import { z } from "zod";

export const EmbeddedTediSelectionPolicySchema = z
	.object({
		defaultTediId: z.uuid(),
		allowedTediIds: z.array(z.uuid()).min(1).max(100),
	})
	.refine((value) => value.allowedTediIds.includes(value.defaultTediId), {
		path: ["defaultTediId"],
		message: "The default tedi must be selectable",
	})
	.refine(
		(value) =>
			new Set(value.allowedTediIds).size === value.allowedTediIds.length,
		{
			path: ["allowedTediIds"],
			message: "Selectable tedis must be unique",
		},
	);
export type EmbeddedTediSelectionPolicy = z.infer<
	typeof EmbeddedTediSelectionPolicySchema
>;
export const EmbeddedTediChoiceSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1),
});
export const EmbeddedTediSelectionSchema = z.object({
	defaultTediId: z.uuid(),
	selectedTediId: z.uuid(),
	tedis: z.array(EmbeddedTediChoiceSchema).min(1).max(100),
});

/**
 * The model roster an embedded session may route a turn at.
 *
 * It is a PROJECTION of the one model catalog (`modelCatalog.list`) scoped to
 * the session's tedi, reduced to what a picker needs. Only models the catalog
 * marked `allowed` are ever listed, so a widget user cannot select past the
 * organization's entitlement or the org/tedi tier policy. The runtime edge
 * re-validates the chosen ref on every turn against the same projection: this
 * roster tells the UI what to draw, it is never the authority.
 *
 * `reasoning` carries the catalog's own capability flag, which decides whether
 * the thinking-effort control applies to that model at all — the runtime
 * rejects an explicit effort on a model that cannot take one on the wire.
 */
export const EmbeddedModelChoiceSchema = z.object({
	ref: z.string().min(1),
	label: z.string().min(1),
	reasoning: z.boolean(),
});
export type EmbeddedModelChoice = z.infer<typeof EmbeddedModelChoiceSchema>;

/** Effort levels a widget may offer. Mirrors `ModelGenerationSettings`. */
export const EmbeddedReasoningEffortSchema = z.enum([
	"none",
	"low",
	"medium",
	"high",
]);
export type EmbeddedReasoningEffort = z.infer<
	typeof EmbeddedReasoningEffortSchema
>;

export const EmbeddedModelSelectionSchema = z.object({
	defaultRef: z
		.string()
		.min(1)
		.nullable()
		.describe(
			"The ref that answers when the user picks nothing. Null on an AUTHORITY absence: the OS quick chat's no-pick default is a runtime Worker var this API cannot read, so naming a ref here would assert a routing decision this Worker does not make. A client renders 'automatic' for null — it is never a claim that no model answers.",
		),
	models: z.array(EmbeddedModelChoiceSchema).max(50),
	efforts: z.array(EmbeddedReasoningEffortSchema).max(4),
});
export type EmbeddedModelSelection = z.infer<
	typeof EmbeddedModelSelectionSchema
>;

const UserIdSchema = z.string().trim().min(1).max(200);
export const EmbeddedWidgetAccessPolicySchema = z.object({
	version: z.literal(1),
	tediSelection: EmbeddedTediSelectionPolicySchema.optional().describe(
		"Absent on existing installations: their persisted primary tedi remains the only permitted choice.",
	),
	enabled: z.boolean(),
	users: z.enum(["all", "selected"]),
	allowedUserIds: z.array(UserIdSchema).max(500),
	deniedUserIds: z.array(UserIdSchema).max(500),
});
export type EmbeddedWidgetAccessPolicy = z.infer<
	typeof EmbeddedWidgetAccessPolicySchema
>;
export const EmbeddedWidgetAccessConfigurationSchema = z.object({
	installationId: z.uuid(),
	tediSelection: EmbeddedTediSelectionPolicySchema.optional().describe(
		"Effective worker selection; absent when an installation has no primary worker or explicit policy.",
	),
	availableTedis: z
		.array(EmbeddedTediChoiceSchema)
		.optional()
		.describe(
			"Customer organization roster supplied by the configuration listing; omitted from save responses.",
		),
	businessName: z
		.string()
		.optional()
		.describe(
			"Customer organization name, when available in the installation directory.",
		),
	externalTenantId: z.string(),
	allowedOrigin: z.string(),
	status: z.enum(["active", "paused"]),
	revision: z.number().int().nonnegative(),
	policy: EmbeddedWidgetAccessPolicySchema,
	updatedAt: z
		.string()
		.nullable()
		.describe(
			"Null until a valid access policy has been saved for this installation.",
		),
	updatedBy: z
		.string()
		.nullable()
		.describe("Null when no valid saved policy has an attributable author."),
});
export const EmbeddedWidgetAccessDecisionSchema = z.object({
	allowed: z.boolean(),
	reason: z.enum([
		"allowed",
		"installation_paused",
		"access_disabled",
		"user_required",
		"user_excluded",
		"user_not_selected",
	]),
	revision: z.number().int().nonnegative(),
});
export const DEFAULT_EMBEDDED_WIDGET_ACCESS: EmbeddedWidgetAccessPolicy = {
	version: 1,
	enabled: true,
	users: "all",
	allowedUserIds: [],
	deniedUserIds: [],
};

/** Absence preserves existing active installations; malformed saved policies fail closed. */
export function readEmbeddedWidgetAccess(
	provenance: Record<string, unknown> | null | undefined,
) {
	const raw = provenance?.widgetAccess;
	if (raw === undefined)
		return {
			revision: 0,
			policy: DEFAULT_EMBEDDED_WIDGET_ACCESS,
			updatedAt: null,
			updatedBy: null,
		};
	const result = z
		.object({
			revision: z.number().int().positive(),
			policy: EmbeddedWidgetAccessPolicySchema,
			updatedAt: z.string(),
			updatedBy: z.string(),
		})
		.safeParse(raw);
	if (!result.success)
		return {
			revision: 0,
			policy: { ...DEFAULT_EMBEDDED_WIDGET_ACCESS, enabled: false },
			updatedAt: null,
			updatedBy: null,
		};
	return result.data;
}

export function evaluateEmbeddedWidgetAccess(
	configuration: {
		status: "active" | "paused";
		revision: number;
		policy: EmbeddedWidgetAccessPolicy;
	},
	hostUserId: string,
): z.infer<typeof EmbeddedWidgetAccessDecisionSchema> {
	const { policy, revision } = configuration;
	const reason =
		configuration.status !== "active"
			? "installation_paused"
			: !policy.enabled
				? "access_disabled"
				: !hostUserId
					? "user_required"
					: policy.deniedUserIds.includes(hostUserId)
						? "user_excluded"
						: policy.users === "selected" &&
							  !policy.allowedUserIds.includes(hostUserId)
							? "user_not_selected"
							: "allowed";
	return { allowed: reason === "allowed", reason, revision };
}

/** Missing selection preserves a persisted installation binding; malformed policy never grants access. */
export function providerWidgetTediSelection(installation: {
	primaryTediId: string;
	provenance?: Record<string, unknown> | null;
}): EmbeddedTediSelectionPolicy | null {
	const access = readEmbeddedWidgetAccess(installation.provenance);
	if (!access.policy.enabled) return null;
	return (
		access.policy.tediSelection ?? {
			defaultTediId: installation.primaryTediId,
			allowedTediIds: [installation.primaryTediId],
		}
	);
}
export function providerWidgetAllowsTedi(
	installation: {
		primaryTediId: string;
		provenance?: Record<string, unknown> | null;
	},
	tediId: string,
): boolean {
	return (
		providerWidgetTediSelection(installation)?.allowedTediIds.includes(
			tediId,
		) === true
	);
}

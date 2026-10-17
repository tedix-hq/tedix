import * as z from "zod";
import { ProviderExecutionIdentitySchema } from "./provider-execution";

export const DataResidencyModeSchema = z.enum(["unrestricted", "eu"]);
export const DataResidencyPolicySchema = z.object({
	mode: DataResidencyModeSchema,
	revision: z.number().int().nonnegative(),
	updatedAt: z.string().nullable(),
	updatedBy: z.string().nullable(),
});
export const SetDataResidencyInputSchema = z.strictObject({
	mode: DataResidencyModeSchema,
	expectedRevision: z.number().int().nonnegative(),
});
export const ResidencyProviderSchema = z
	.strictObject({
		memberKey: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
		revision: z.number().int().positive(),
		execution: ProviderExecutionIdentitySchema,
		modalities: z.array(z.enum(["text", "image"])).min(1),
		jurisdiction: z.enum(["eu", "global", "unknown"]),
		credentialRef: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
		evidenceRef: z.string().min(1).max(2000),
		expiresAt: z.iso.datetime(),
		enabled: z.boolean(),
	})
	.superRefine((member, ctx) => {
		const origin = member.execution.providerOrigin;
		if (origin) {
			const url = new URL(origin);
			if (
				url.protocol !== "https:" ||
				url.origin !== origin ||
				url.port ||
				url.username ||
				url.password
			)
				ctx.addIssue({
					code: "custom",
					message:
						"Use the exact HTTPS provider origin without path, userinfo or port",
				});
		}
		if (
			member.jurisdiction === "eu" &&
			(!origin || member.execution.autoRouting)
		)
			ctx.addIssue({
				code: "custom",
				message:
					"EU evidence requires a pinned provider origin and deployment; adaptive routes are ineligible",
			});
	});
export type ResidencyProvider = z.infer<typeof ResidencyProviderSchema>;
export type DataResidencyPolicy = z.infer<typeof DataResidencyPolicySchema>;

/** Read only model input structure; no prompt content is retained. */
export function modelInputModality(
	body: unknown,
): "text" | "image" | "unknown" {
	if (typeof body !== "string") return "unknown";
	try {
		const hasImage = (value: unknown): boolean => {
			if (!value || typeof value !== "object") return false;
			if (Array.isArray(value)) return value.some(hasImage);
			const record = value as Record<string, unknown>;
			return (
				["image", "input_image", "image_url"].includes(String(record.type)) ||
				Object.values(record).some(hasImage)
			);
		};
		return hasImage(JSON.parse(body)) ? "image" : "text";
	} catch {
		return "unknown";
	}
}

import "@orpc/openapi/extensions/route";
/**
 * Tedi Secrets Contract
 * oRPC contract for per-tedi encrypted secrets (API keys, bot tokens, etc.)
 *
 * Follows the same pattern as organization/app secrets but scoped to tedi instances.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TediIdParamSchema } from "../schemas/tedi";
import {
	SecretDeleteResponseSchema,
	SecretIdParamSchema,
	SecretListItemSchema,
	SecretNameSchema,
	SecretsListResponseSchema,
} from "./secrets";

export const tediSecretsContract = oc
	.route({ tags: ["tedi-secrets"], prefix: "/tedis/{tediId}/secrets" })
	.router({
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List tedi secrets",
				description: "List all secrets for a tedi (without decrypted values)",
			})
			.input(TediIdParamSchema)
			.output(SecretsListResponseSchema),

		set: oc
			.route({
				method: "PUT",
				path: "" as `/${string}`,
				summary: "Set tedi secret",
				description: "Create or update a tedi secret (upsert by name)",
			})
			.input(
				TediIdParamSchema.extend({
					name: SecretNameSchema,
					value: z.string().min(1).max(10000),
				}),
			)
			.output(SecretListItemSchema),

		copy: oc
			.route({
				method: "POST",
				path: "/copy",
				summary: "Copy tedi secret",
				description:
					"Copy one encrypted tedi secret to another same-tenant tedi without returning its plaintext value",
			})
			.input(
				TediIdParamSchema.extend({
					sourceTediId: z.uuid(),
					name: SecretNameSchema,
				}),
			)
			.output(SecretListItemSchema),

		delete: oc
			.route({
				method: "DELETE",
				path: "/{secretId}",
				summary: "Delete tedi secret",
				description: "Permanently delete a tedi secret",
			})
			.input(TediIdParamSchema.extend(SecretIdParamSchema.shape))
			.output(SecretDeleteResponseSchema),
	});

export type TediSecretsContract = typeof tediSecretsContract;

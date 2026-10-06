import { organizationsContract } from "@tedix/api-contract/contracts/organizations";
import {
	CreateApiKeyInputSchema,
	TENANT_DELEGABLE_API_KEY_SCOPES,
	type ApiKey,
} from "@tedix/api-contract/schemas/organization";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import * as z from "zod";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import {
	contractInputSchema,
	deriveToolSchema,
} from "@/lib/webmcp/derive-schema";

// Preparation is deliberately narrower than credential issuance. In particular,
// there is no confirm, token, rawKey, organizationId, or step-up resume input.
const draftSchema = CreateApiKeyInputSchema.pick({
	name: true,
	description: true,
	environment: true,
	scopes: true,
})
	.extend({
		name: CreateApiKeyInputSchema.shape.name.refine(
			(value) => value.trim().length > 0,
		),
		environment: CreateApiKeyInputSchema.shape.environment.unwrap(),
		scopes: z.array(z.enum(TENANT_DELEGABLE_API_KEY_SCOPES)).min(1),
	})
	.strict();
const keySchema = contractInputSchema(organizationsContract.rotateApiKey)
	.pick({ keyId: true })
	.strict();
const emptySchema = z.object({}).strict();
export type ApiKeyDraft = z.infer<typeof draftSchema>;
export interface ApiKeysWebMcpContext {
	organizationId: string;
	offset: number;
	limit: number;
	busy: boolean;
}
export interface ApiKeysWebMcpDeps {
	context: () => ApiKeysWebMcpContext;
	prepareCreate: (draft: ApiKeyDraft) => boolean;
	prepareAction: (action: {
		type: "rotate" | "revoke";
		id: string;
		name: string;
	}) => boolean;
	listKeys?: (
		input: { organizationId: string; offset: number; limit: number },
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ data: ApiKey[]; pagination: { total: number } }>;
}
let apiPromise: Promise<typeof import("@/lib/api")> | undefined;
async function listKeys(
	input: { organizationId: string; offset: number; limit: number },
	options?: WebMcpToolExecuteOptions,
) {
	apiPromise ??= import("@/lib/api");
	return (await apiPromise).osApi.organizations.listApiKeys(
		input,
		...(options?.signal ? ([options] as const) : ([] as const)),
	);
}
function metadata(key: ApiKey) {
	return {
		id: key.id,
		name: key.name,
		description: key.description,
		keyPreview: key.keyPreview,
		scopes: key.scopes,
		environment: key.environment,
		status: key.status,
		expiresAt: key.expiresAt,
		lastUsedAt: key.lastUsedAt,
	};
}
const link = "/admin/api-keys";
/** Tools never mint, rotate, revoke, approve, or return a credential. */
export function buildApiKeysWebMcpTools(
	deps: ApiKeysWebMcpDeps,
): WebMcpToolDef[] {
	const read = deps.listKeys ?? listKeys;
	const active = (
		before: ApiKeysWebMcpContext,
		options?: WebMcpToolExecuteOptions,
	) => {
		options?.signal?.throwIfAborted();
		const now = deps.context();
		if (
			now.organizationId !== before.organizationId ||
			now.offset !== before.offset
		)
			throw new Error("API keys page changed; inspect the current page again.");
	};
	return [
		{
			name: "list_api_keys",
			description:
				"Read API-key metadata on the currently visible page. No raw credentials. Use the page pagination to inspect other keys.",
			inputSchema: deriveToolSchema(emptySchema, {
				pick: [],
				additionalProperties: false,
			}),
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			execute: async (args, options) => {
				try {
					if (!emptySchema.safeParse(args).success)
						return webMcpError("This tool takes no arguments.");
					const context = deps.context();
					active(context, options);
					const result = await read(
						{
							organizationId: context.organizationId,
							offset: context.offset,
							limit: context.limit,
						},
						options,
					);
					active(context, options);
					return webMcpResult(
						{
							keys: result.data.map(metadata),
							total: result.pagination.total,
							offset: context.offset,
							limit: context.limit,
						},
						link,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "prepare_create_api_key",
			description:
				"Open a prefilled create-key dialog for human review. Requires explicit environment and tenant-delegable scopes. Does not create a key or perform reauthentication; the human must confirm in the UI.",
			inputSchema: deriveToolSchema(draftSchema, {
				pick: ["name", "description", "environment", "scopes"],
				additionalProperties: false,
			}),
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			execute: async (args, options) => {
				try {
					const parsed = draftSchema.safeParse(args);
					if (!parsed.success)
						return webMcpError(
							"Provide a valid name, environment, and nonempty tenant-delegable scopes; unsupported fields are rejected.",
						);
					options?.signal?.throwIfAborted();
					if (deps.context().busy || !deps.prepareCreate(parsed.data))
						return webMcpError(
							"Finish or cancel the existing API-key dialog first.",
						);
					return webMcpResult(
						{
							status: "awaiting_human_confirmation",
							operation: "create",
							credentialIssued: false,
						},
						link,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		...(["rotate", "revoke"] as const).map((operation): WebMcpToolDef => ({
			name: `prepare_${operation}_api_key`,
			description: `Open the human confirmation dialog to ${operation} an active API key on the currently visible page. Does not ${operation} the key. Rotation still requires reauthentication.`,
			inputSchema: deriveToolSchema(keySchema, {
				pick: ["keyId"],
				additionalProperties: false,
			}),
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			execute: async (args, options) => {
				try {
					const parsed = keySchema.safeParse(args);
					if (!parsed.success)
						return webMcpError(
							"Provide only a valid keyId from list_api_keys.",
						);
					const context = deps.context();
					active(context, options);
					if (context.busy)
						return webMcpError(
							"Finish or cancel the existing API-key dialog first.",
						);
					const result = await read(
						{
							organizationId: context.organizationId,
							offset: context.offset,
							limit: context.limit,
						},
						options,
					);
					active(context, options);
					const key = result.data.find((key) => key.id === parsed.data.keyId);
					if (!key)
						return webMcpError(
							"Key is not on the current page. Navigate to its page and inspect it first.",
						);
					if ((key.status ?? "active") !== "active")
						return webMcpError("Only active keys support this action.");
					if (
						deps.context().busy ||
						!deps.prepareAction({ type: operation, id: key.id, name: key.name })
					)
						return webMcpError(
							"Finish or cancel the existing API-key dialog first.",
						);
					return webMcpResult(
						{
							status: "awaiting_human_confirmation",
							operation,
							keyId: key.id,
							credentialChanged: false,
						},
						link,
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		})),
	];
}

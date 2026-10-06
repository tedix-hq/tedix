import {
	ConnectionInventoryInputSchema,
	ConnectionInventorySchema,
	type ConnectionInventory,
	type ConnectionInventoryInput,
} from "@tedix/api-contract/schemas/connections";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
} from "@tedix/webmcp-core/model-context";
import { webMcpResult } from "@tedix/webmcp-core/model-context";
import * as z from "zod";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import { deriveToolSchema } from "@/lib/webmcp/derive-schema";

const schema = ConnectionInventoryInputSchema.omit({ scope: true }).strict();
const detailSchema = schema.extend({
	providerId: ConnectionInventoryInputSchema.shape.providerId.unwrap(),
});
const serviceSchema = detailSchema.extend({
	appSlug: z.string().min(1).max(200).optional(),
});

export type ConnectionServiceHealth = {
	app: string;
	url: string;
	toolCount: number | null;
	allPassed: boolean;
	passCount: number;
	failCount: number;
	totalDurationMs: number;
	checks: Array<{
		name: string;
		passed: boolean;
		detail: string;
		durationMs: number;
		data?: Record<string, unknown>;
	}>;
};

export function resolveConnectionServiceTarget(
	row: ConnectionInventory["rows"][number],
	requestedSlug?: string,
): string {
	const slugs = [
		...new Set(row.references.map((reference) => reference.appSlug)),
	]
		.filter(Boolean)
		.sort();
	if (requestedSlug) {
		if (!slugs.includes(requestedSlug)) {
			throw new Error("The requested app does not reference this connection.");
		}
		return requestedSlug;
	}
	if (slugs.length === 0) {
		throw new Error("No referenced app service is available to check.");
	}
	if (slugs.length > 1) {
		throw new Error(
			"This connection is referenced by multiple app services. Provide appSlug.",
		);
	}
	return slugs[0]!;
}

export function buildConnectionsWebMcpTools(deps: {
	scope: "organization" | "personal";
	prepare?: (
		action: "connect" | "disconnect",
		row: ConnectionInventory["rows"][number],
	) => boolean;
	read?: (
		input: ConnectionInventoryInput,
		options?: WebMcpToolExecuteOptions,
	) => Promise<ConnectionInventory>;
	checkService?: (
		input: { appSlug: string },
		options?: WebMcpToolExecuteOptions,
	) => Promise<ConnectionServiceHealth>;
}): WebMcpToolDef[] {
	const read =
		deps.read ??
		(async (input, options) =>
			(await import("@/lib/api")).osApi.connections.getConnectionsOverview(
				input,
				...(options?.signal
					? ([{ signal: options.signal }] as const)
					: ([] as const)),
			));
	const checkService =
		deps.checkService ??
		(async ({ appSlug }, options) =>
			(await import("@/lib/api")).osDirectReadApi.mcpHealth.run(
				{ appSlug, authStrategy: "auto", tasksExtension: "ignore" },
				...(options?.signal
					? ([{ signal: options.signal }] as const)
					: ([] as const)),
			));
	return [
		{
			name: "list_connections",
			description:
				"Inspect accounts in this page's ownership scope, references and verification failures. Does not prove installation, usable access or provider health.",
		},
		{
			name: "explain_connection",
			description:
				"Explain one provider's account presence, ownership and app references in this page's scope. Account presence is not app installation or authorization.",
		},
		{
			name: "preview_disconnect_connection",
			description:
				"Read the app references that may be affected by disconnecting an account. This is an incomplete impact preview, not a permission check. Does not disconnect or confirm anything.",
		},
		{
			name: "check_connection_service",
			description:
				"Run a protocol-level health check against an app service that references this connection. Does not execute a provider API tool, inspect secrets, verify credential usability or prove effective access.",
		},
		{
			name: "prepare_connect_connection",
			description:
				"Open a connection review dialog. Does not start OAuth, store credentials, or confirm the action. A human must continue in the UI.",
		},
		{
			name: "prepare_disconnect_connection",
			description:
				"Open the disconnect confirmation dialog for a verified account. Does not remove a credential or confirm the action.",
		},
	].map(({ name, description }) => ({
		name,
		description,
		inputSchema: deriveToolSchema(
			name === "list_connections"
				? schema
				: name === "check_connection_service"
					? serviceSchema
					: detailSchema,
			{
				pick:
					name === "check_connection_service"
						? ["q", "providerId", "appSlug", "status", "limit", "offset"]
						: name === "list_connections"
							? ["q", "status", "limit", "offset"]
							: ["q", "providerId", "status", "limit", "offset"],
				additionalProperties: false,
			},
		),
		annotations: {
			readOnlyHint: !name.startsWith("prepare_"),
			untrustedContentHint: true,
		},
		execute: async (args, options) => {
			try {
				options?.signal?.throwIfAborted();
				const parsed = (
					name === "list_connections"
						? schema
						: name === "check_connection_service"
							? serviceSchema
							: detailSchema
				).parse(args);
				const inventoryInput: ConnectionInventoryInput = {
					scope: deps.scope,
					q: parsed.q,
					status: parsed.status,
					limit: parsed.limit,
					offset: parsed.offset,
					...("providerId" in parsed ? { providerId: parsed.providerId } : {}),
				};
				const result = ConnectionInventorySchema.parse(
					await read(inventoryInput, options),
				);
				options?.signal?.throwIfAborted();
				if (name === "check_connection_service") {
					const serviceInput = serviceSchema.parse(args);
					const row = result.rows.find(
						(row) => row.provider.appId === serviceInput.providerId,
					);
					if (!row || !row.referencesComplete) {
						throw new Error(
							"App references must be completely verified before checking a service.",
						);
					}
					const appSlug = resolveConnectionServiceTarget(
						row,
						serviceInput.appSlug,
					);
					const service = await checkService({ appSlug }, options);
					options?.signal?.throwIfAborted();
					return webMcpResult(
						{
							providerId: row.provider.appId,
							appSlug,
							service,
							credentialState: row.accountState,
							credentialUsability: "not_checked",
							effectiveAccess: row.access,
							providerApiHealth: row.health,
						},
						deps.scope === "organization"
							? "/admin/connections"
							: "/account/connections",
					);
				}
				if (name.startsWith("prepare_")) {
					const row = result.rows.find(
						(row) => row.provider.appId === parsed.providerId,
					);
					if (
						!row ||
						row.accountState === "unknown" ||
						(name === "prepare_disconnect_connection" &&
							(row.accountState === "restricted" || !row.connection))
					)
						throw new Error(
							"Inspect a verified account before preparing this change.",
						);
					if (
						!deps.prepare?.(
							name === "prepare_connect_connection" ? "connect" : "disconnect",
							row,
						)
					)
						throw new Error(
							"The page cannot prepare this action. Check your permissions and close any existing dialog.",
						);
					return webMcpResult(
						{ status: "awaiting_human_confirmation", changed: false },
						deps.scope === "organization"
							? "/admin/connections"
							: "/account/connections",
					);
				}
				return webMcpResult(
					{
						...result,
						...(name === "preview_disconnect_connection"
							? {
									effect:
										"Disconnecting removes the selected credential. Referencing apps may stop working; fallback credentials and consumer permissions have not been evaluated.",
									confirmationRequired: true,
									changed: false,
								}
							: {}),
					},
					deps.scope === "organization"
						? "/admin/connections"
						: "/account/connections",
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	}));
}

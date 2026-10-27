import { ORPCError } from "@orpc/server";
import {
	EmbeddedTediSelectionPolicySchema,
	type EmbeddedTediSelectionPolicy,
} from "@tedix/api-contract/schemas/embedded-widget-access";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import type { BaseContext } from "../rpc/orpc";

export async function resolveEmbeddedTediSelection(
	context: BaseContext,
	organizationId: string,
	policy: EmbeddedTediSelectionPolicy | null | undefined,
	selectedTediId?: string,
	options: {
		/**
		 * The OS quick chat of an organization that never published widget
		 * tedis: every active tedi of the organization is selectable and the
		 * tedi the host already cleared access for is the default. External
		 * hosts keep the explicit policy requirement.
		 */
		unconfiguredFallback?: "organization";
	} = {},
) {
	const parsed = EmbeddedTediSelectionPolicySchema.safeParse(policy);
	const active = (
		await getTedisByOrganization(context.db, organizationId)
	).filter((row) => row.status === "active" && !row.retiredAt);
	const selection = parsed.success
		? parsed.data
		: options.unconfiguredFallback === "organization" &&
			  selectedTediId &&
			  active.some((row) => row.id === selectedTediId)
			? {
					defaultTediId: selectedTediId,
					allowedTediIds: active.map((row) => row.id),
				}
			: null;
	if (!selection)
		throw new ORPCError("FORBIDDEN", {
			message: "Configure the widget's selectable tedis and default first",
		});
	const id = selectedTediId ?? selection.defaultTediId;
	if (!selection.allowedTediIds.includes(id))
		throw new ORPCError("FORBIDDEN", {
			message: "This tedi is not available in this widget",
		});
	const rows = active.filter((row) =>
		selection.allowedTediIds.includes(row.id),
	);
	const tedi = rows.find((row) => row.id === id);
	if (!tedi)
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "The selected tedi is unavailable",
			data: { reason: "worker_unavailable", retryable: true },
		});
	return {
		tedi,
		tediSelection: {
			defaultTediId: selection.defaultTediId,
			selectedTediId: id,
			tedis: rows.map((row) => ({
				id: row.id,
				name: row.displayName || row.name,
			})),
		},
	};
}
export async function validateEmbeddedTediSelection(
	context: BaseContext,
	organizationId: string,
	policy: EmbeddedTediSelectionPolicy,
) {
	const rows = await getTedisByOrganization(context.db, organizationId);
	if (
		policy.allowedTediIds.some(
			(id) =>
				!rows.some(
					(row) => row.id === id && row.status === "active" && !row.retiredAt,
				),
		)
	)
		throw new ORPCError("BAD_REQUEST", {
			message: "Choose active tedis belonging to this organization",
		});
}

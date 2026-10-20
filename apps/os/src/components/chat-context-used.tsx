/** Context-used summary items and inspector dialog for a chat turn. */
import { Info } from "@phosphor-icons/react";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { useMemo, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { type ChatContext } from "@/components/chat-transcript";

export type ContextUsedItem = { label: string; value: string };

export function recordOrNull(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Secret-free provenance projected from the latest canonical run. This is an
 * allowlist, never a metadata dump: credential-shaped and unknown keys cannot
 * enter the UI.
 */
export function contextUsedItems(
	runs: readonly HomeRun[],
	input: { workspaceId?: string; context?: ChatContext } = {},
): ContextUsedItem[] {
	const latest = [...runs].sort(
		(a, b) =>
			Date.parse(b.updatedAt ?? b.createdAt) -
			Date.parse(a.updatedAt ?? a.createdAt),
	)[0];
	if (!latest) return [];
	const metadata = recordOrNull(latest.metadata);
	const workspace = recordOrNull(metadata?.workspaceContext);
	const workpiece = recordOrNull(workspace?.workpiece);
	const route = recordOrNull(metadata?.kernelRoute);
	const manifest = recordOrNull(metadata?.contextManifest);
	const manifestSources = Array.isArray(manifest?.sources)
		? manifest.sources
				.map(recordOrNull)
				.filter((source): source is Record<string, unknown> => source !== null)
				.map((source) => {
					const name = nonEmptyString(source.name);
					const count = typeof source.count === "number" ? source.count : null;
					return name && count !== null ? `${name}: ${count}` : null;
				})
				.filter((source): source is string => source !== null)
		: [];
	const historyCompaction = recordOrNull(manifest?.historyCompaction);
	const modelRef =
		nonEmptyString(metadata?.modelRef) ?? nonEmptyString(route?.modelRef);
	const workspaceIdFromRun = nonEmptyString(workspace?.workspaceId);
	const workspaceName = nonEmptyString(workspace?.workspaceName);
	const workspaceLabel =
		workspaceName ??
		(input.context?.kind === "workspace" ? input.context.label : null) ??
		input.workspaceId ??
		workspaceIdFromRun;
	const items: Array<ContextUsedItem | null> = [
		{ label: "Organization", value: latest.organizationId },
		workspaceLabel ? { label: "Workspace", value: workspaceLabel } : null,
		input.context && input.context.kind !== "workspace"
			? { label: "Workpiece", value: input.context.label }
			: nonEmptyString(workpiece?.id)
				? {
						label: "Workpiece",
						value: `${nonEmptyString(workpiece?.kind) ?? "resource"}: ${nonEmptyString(workpiece?.id)}`,
					}
				: null,
		modelRef ? { label: "Model", value: modelRef } : null,
		nonEmptyString(route?.routeKind)
			? { label: "Route", value: nonEmptyString(route?.routeKind)! }
			: null,
		nonEmptyString(metadata?.routerVersion)
			? {
					label: "Router version",
					value: nonEmptyString(metadata?.routerVersion)!,
				}
			: null,
		latest.delegatedTediId
			? { label: "Delegated tedi", value: latest.delegatedTediId }
			: null,
		manifestSources.length
			? { label: "Context sources", value: manifestSources.join(" → ") }
			: null,
		typeof manifest?.inputTokens === "number"
			? { label: "Model input", value: `${manifest.inputTokens} tokens` }
			: null,
		typeof latest.usage?.reasoningTokens === "number"
			? {
					label: "Reasoning usage",
					value: `${latest.usage.reasoningTokens} tokens`,
				}
			: null,
		typeof manifest?.budgetTokens === "number"
			? { label: "Context budget", value: `${manifest.budgetTokens} tokens` }
			: null,
		historyCompaction
			? {
					label: "History compaction",
					value: `${historyCompaction.compactedMessages ?? 0} messages compacted; ${historyCompaction.retainedMessages ?? 0} retained (${historyCompaction.source ?? "unknown"})`,
				}
			: { label: "History compaction", value: "Not applied" },
		nonEmptyString(metadata?.workItemId)
			? { label: "Work Item", value: nonEmptyString(metadata?.workItemId)! }
			: null,
	];
	return items.filter((item): item is ContextUsedItem => item !== null);
}

export function ContextUsedInspector({
	runs,
	workspaceId,
	context,
}: {
	runs: readonly HomeRun[];
	workspaceId?: string;
	context?: ChatContext;
}) {
	const [open, setOpen] = useState(false);
	const items = useMemo(
		() => contextUsedItems(runs, { workspaceId, context }),
		[runs, workspaceId, context],
	);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Button
				size="sm"
				variant="outline"
				icon={<Info size={14} />}
				disabled={items.length === 0}
				onClick={() => setOpen(true)}
			>
				Context used
			</Button>
			<DialogContent size="base">
				<DialogHeader>
					<DialogTitle>Context used</DialogTitle>
					<DialogDescription>
						Canonical, secret-free context recorded for the latest Kernel run.
					</DialogDescription>
				</DialogHeader>
				<dl className="grid gap-3">
					{items.map((item) => (
						<div key={item.label} className="grid gap-0.5">
							<Text as="dt" role="label" tone="secondary">
								{item.label}
							</Text>
							<Text as="dd" role="body" className="m-0 break-all">
								{item.value}
							</Text>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}

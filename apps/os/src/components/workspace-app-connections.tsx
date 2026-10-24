import { useQuery } from "@tanstack/react-query";
import type {
	OsGadgetManifest,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Collection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { availabilityLabel } from "@/components/workspace-resources-panel";
import { WorkspaceListRow } from "@/components/workspace-list-row";
import {
	canvasGadgetDetailQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

/** One resource an app declares, joined to what the workspace attached for it. */
export type AppConnectionRow = {
	slot: string;
	label: string;
	operations: readonly string[];
	resource: OsWorkspaceResource | null;
	status: "connected" | "needs_connection" | "not_attached";
};

function slotLabel(slot: string): string {
	const words = slot.replace(/_+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The app's declared resources (`resourceGrants`), each matched to the active
 * workspace resource filling the same slot. The app can reach only these, and
 * only with the listed operations.
 */
export function appConnectionRows(
	manifest: OsGadgetManifest | null | undefined,
	resources: readonly OsWorkspaceResource[],
): AppConnectionRow[] {
	return (manifest?.resourceGrants ?? []).map((grant) => {
		const resource =
			resources.find(
				(candidate) =>
					candidate.slot === grant.slot && candidate.status === "active",
			) ?? null;
		return {
			slot: grant.slot,
			label: resource?.name ?? slotLabel(grant.slot),
			operations: grant.operations,
			resource,
			status: !resource
				? "not_attached"
				: !resource.availability || resource.availability.status === "available"
					? "connected"
					: "needs_connection",
		};
	});
}

const STATUS_BADGE: Record<
	AppConnectionRow["status"],
	{ variant: "secondary" | "destructive" | "outline" }
> = {
	connected: { variant: "secondary" },
	needs_connection: { variant: "destructive" },
	not_attached: { variant: "outline" },
};

function statusLabel(row: AppConnectionRow): string {
	if (row.status === "not_attached") return "Nothing attached";
	return availabilityLabel(row.resource?.availability?.status);
}

/**
 * What a workspace app uses, in plain words: one row per declared resource
 * with how the code refers to it, what it may do, and whether it is ready.
 * Connect opens the workspace's connected-apps list, where the account
 * behind a resource is connected or reconnected.
 */
export function WorkspaceAppConnections({
	workspaceId,
	gadgetId,
	onConnect,
}: {
	workspaceId: string;
	gadgetId: string;
	onConnect: () => void;
}) {
	const detail = useQuery(
		canvasGadgetDetailQueryOptions(workspaceId, gadgetId),
	);
	const resources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const manifest = detail.data?.currentRevision?.manifest;
	const rows = appConnectionRows(manifest, resources.data?.items ?? []);
	const capabilities = manifest?.capabilities ?? [];
	return (
		<section className="grid gap-3" data-app-connections>
			<SectionEyebrow
				title="Used by this app"
				count={detail.data ? rows.length : undefined}
				actions={
					<Button size="sm" variant="outline" onClick={onConnect}>
						Connect an app
					</Button>
				}
			/>
			{detail.data && rows.length === 0 ? (
				<Text as="p" role="body" tone="secondary" className="m-0">
					This app uses no external resources. Declare one under{" "}
					<code>resourceGrants</code> in manifest.json.
				</Text>
			) : null}
			{rows.length > 0 ? (
				<Collection aria-label="Resources this app uses">
					{rows.map((row) => (
						<WorkspaceListRow
							key={row.slot}
							data-app-connection={row.slot}
							className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="min-w-0 flex-1">
								<Text as="p" role="body" className="m-0 truncate">
									{row.label}
								</Text>
								<Text
									as="p"
									role="label"
									tone="secondary"
									className="m-0 truncate"
								>
									Referenced in code as <code>{row.slot}</code> · Can{" "}
									{row.operations.join(", ")}
								</Text>
								{row.resource?.availability?.reason &&
								row.status === "needs_connection" ? (
									<Text
										as="p"
										role="label"
										tone="error"
										className="mt-1 mb-0 leading-relaxed"
									>
										{row.resource.availability.reason}
									</Text>
								) : null}
							</div>
							<div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
								<Badge variant={STATUS_BADGE[row.status].variant}>
									{statusLabel(row)}
								</Badge>
								{row.status === "needs_connection" ? (
									<Button size="sm" variant="secondary" onClick={onConnect}>
										Connect
									</Button>
								) : null}
							</div>
						</WorkspaceListRow>
					))}
				</Collection>
			) : null}
			{capabilities.length > 0 ? (
				<Text as="p" role="label" tone="secondary" className="m-0">
					It also calls these Tedix tools:{" "}
					{capabilities.map((capability, index) => (
						<span key={capability}>
							{index > 0 ? ", " : null}
							<code>{capability}</code>
						</span>
					))}
					.
				</Text>
			) : null}
		</section>
	);
}

import { LinkBreak, PlugsConnected, Robot } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	WORKSPACE_CONNECTION_RESOURCE,
	WORKSPACE_TEDI_RESOURCE,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { workspaceResourcesQueryOptions } from "@/lib/os-query-options";

function isRunner(resource: OsWorkspaceResource) {
	return (
		resource.providerId === "tedix" &&
		(resource.resourceType === WORKSPACE_TEDI_RESOURCE.resourceType ||
			resource.resourceType === WORKSPACE_CONNECTION_RESOURCE.resourceType)
	);
}

/**
 * "Tedis and connections" in a workspace's Resources: the tedis that run its
 * linked skills and the connections those skills use, linked with the skills.
 * Unlinking removes only the reference; the tedi or connection is unchanged.
 * Hidden when the workspace has none.
 */
export function WorkspaceRunners({ workspaceId }: { workspaceId: string }) {
	const query = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const rows = (query.data?.items ?? []).filter(isRunner);
	if (rows.length === 0) return null;
	const tedis = rows.filter(
		(row) => row.resourceType === WORKSPACE_TEDI_RESOURCE.resourceType,
	);
	const connections = rows.filter(
		(row) => row.resourceType === WORKSPACE_CONNECTION_RESOURCE.resourceType,
	);
	return (
		<section
			aria-label="Tedis and connections"
			className="canvas-resource-section canvas-resource-runners"
		>
			<SectionEyebrow
				title="Tedis and connections"
				count={rows.length}
				variant="console"
			/>
			<Text as="p" role="label" tone="secondary" className="m-0">
				Who runs this workspace's skills, and the connections they use.
			</Text>
			<ul className="m-0 grid list-none gap-0.5 p-0">
				{[...tedis, ...connections].map((row) => (
					<li key={row.id} className="min-w-0">
						<RunnerRow resource={row} workspaceId={workspaceId} />
					</li>
				))}
			</ul>
		</section>
	);
}

function RunnerRow({
	resource,
	workspaceId,
}: {
	resource: OsWorkspaceResource;
	workspaceId: string;
}) {
	const queryClient = useQueryClient();
	const isTedi = resource.resourceType === WORKSPACE_TEDI_RESOURCE.resourceType;
	const Icon = isTedi ? Robot : PlugsConnected;
	const unlink = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.resources.remove({
				workspaceId,
				resourceId: resource.id,
				expectedUpdatedAt: resource.updatedAt,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			}),
	});
	return (
		<div
			className="flex min-w-0 items-center gap-3 py-2"
			data-workspace-runner={resource.resourceType}
		>
			<Icon aria-hidden size={18} className="shrink-0 text-kumo-subtle" />
			<div className="grid min-w-0 flex-1 gap-0.5">
				<Text as="p" role="body" className="m-0 truncate">
					{resource.name}
				</Text>
				<Text as="p" role="label" tone="secondary" className="m-0 truncate">
					{isTedi ? "Tedi" : `Connection · ${resource.providerResourceId}`}
				</Text>
				{unlink.isError && (
					<Text as="p" role="label" tone="error" className="m-0">
						{unlink.error.message}
					</Text>
				)}
			</div>
			<Button
				size="xs"
				variant="ghost"
				icon={<LinkBreak aria-hidden size={14} />}
				aria-label={`Unlink ${resource.name} from this workspace`}
				disabled={unlink.isPending}
				onClick={() => unlink.mutate()}
			>
				Unlink
			</Button>
		</div>
	);
}

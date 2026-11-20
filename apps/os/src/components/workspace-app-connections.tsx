import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
	OsGadgetManifest,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Alert } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Collection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { Switch } from "@/components/kumo/switch";
import type { AppRuntimeTrigger } from "@tedix/api-contract/schemas/os-app-runtime";
import { absoluteTime, relativeTime } from "@/lib/time";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/cron-schedule";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { availabilityLabel } from "@/components/workspace-resources-panel";
import { WorkspaceListRow } from "@/components/workspace-list-row";
import { osApi } from "@/lib/api";
import {
	canvasGadgetDetailQueryOptions,
	osQuery,
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
 * The name to save for a renamed connection: trimmed, or null when there is
 * nothing to save (empty, unchanged, or longer than a name may be).
 */
export function connectionRenameName(
	current: string,
	draft: string,
): string | null {
	const name = draft.trim();
	return name && name !== current && name.length <= 120 ? name : null;
}

/**
 * What a workspace app uses, in plain words: one row per declared resource
 * with how the code refers to it, what it may do, and whether it is ready.
 * Connect opens the workspace's connected-apps list, where the account
 * behind a resource is connected or reconnected. Rename changes the name
 * the workspace shows for a resource; Remove takes it out of the workspace,
 * for every app that used it, and leaves the connected account alone.
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
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState<{
		slot: string;
		action: "rename" | "remove";
	} | null>(null);
	const [draft, setDraft] = useState("");
	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
		});
	const rename = useMutation({
		mutationFn: (input: {
			resourceId: string;
			name: string;
			expectedUpdatedAt: string;
		}) => osApi.osWorkspaces.resources.rename({ workspaceId, ...input }),
		onSuccess: () => setEditing(null),
		onSettled: refresh,
	});
	const remove = useMutation({
		mutationFn: (input: { resourceId: string; expectedUpdatedAt: string }) =>
			osApi.osWorkspaces.resources.remove({ workspaceId, ...input }),
		onSuccess: () => setEditing(null),
		onSettled: refresh,
	});
	const busy = rename.isPending || remove.isPending;
	const start = (row: AppConnectionRow, action: "rename" | "remove") => {
		rename.reset();
		remove.reset();
		setDraft(row.label);
		setEditing({ slot: row.slot, action });
	};
	return (
		<section className="grid gap-3" data-app-connections>
			<WorkspaceAppTriggers workspaceId={workspaceId} gadgetId={gadgetId} />
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
					{rows.map((row) => {
						const resource = row.resource;
						const action = editing?.slot === row.slot ? editing.action : null;
						const newName = connectionRenameName(row.label, draft);
						return (
							<WorkspaceListRow
								key={row.slot}
								data-app-connection={row.slot}
								className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0 flex-1">
									{resource && action === "rename" ? (
										<form
											className="flex flex-wrap items-center gap-1.5"
											onSubmit={(event) => {
												event.preventDefault();
												if (!newName) return;
												rename.mutate({
													resourceId: resource.id,
													name: newName,
													expectedUpdatedAt: resource.updatedAt,
												});
											}}
										>
											<Input
												autoFocus
												size="sm"
												aria-label={`New name for ${row.label}`}
												className="min-w-40 flex-1"
												maxLength={120}
												value={draft}
												onChange={(event) => setDraft(event.target.value)}
											/>
											<Button
												type="submit"
												size="sm"
												disabled={busy || !newName}
											>
												Save
											</Button>
											<Button
												type="button"
												size="sm"
												variant="ghost"
												onClick={() => setEditing(null)}
											>
												Cancel
											</Button>
										</form>
									) : (
										<Text as="p" role="body" className="m-0 truncate">
											{row.label}
										</Text>
									)}
									<Text
										as="p"
										role="label"
										tone="secondary"
										className="m-0 truncate"
									>
										Referenced in code as <code>{row.slot}</code> · Can{" "}
										{row.operations.join(", ")}
									</Text>
									{resource?.availability?.reason &&
									row.status === "needs_connection" ? (
										<Text
											as="p"
											role="label"
											tone="error"
											className="mt-1 mb-0 leading-relaxed"
										>
											{resource.availability.reason}
										</Text>
									) : null}
									{action === "remove" ? (
										<Text
											as="p"
											role="label"
											tone="secondary"
											className="mt-1 mb-0 leading-relaxed"
										>
											Remove {row.label} from this workspace? Apps here stop
											reaching it. The connected account stays connected.
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
									{resource && action === "remove" ? (
										<>
											<Button
												size="sm"
												variant="destructive"
												disabled={busy}
												onClick={() =>
													remove.mutate({
														resourceId: resource.id,
														expectedUpdatedAt: resource.updatedAt,
													})
												}
											>
												Remove
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setEditing(null)}
											>
												Keep
											</Button>
										</>
									) : null}
									{resource && !action ? (
										<>
											<Button
												size="sm"
												variant="ghost"
												aria-label={`Rename ${row.label}`}
												disabled={busy}
												onClick={() => start(row, "rename")}
											>
												Rename
											</Button>
											<Button
												size="sm"
												variant="ghost"
												aria-label={`Remove ${row.label}`}
												disabled={busy}
												onClick={() => start(row, "remove")}
											>
												Remove
											</Button>
										</>
									) : null}
								</div>
							</WorkspaceListRow>
						);
					})}
				</Collection>
			) : null}
			{rename.isError || remove.isError ? (
				<Alert
					variant="destructive"
					description={
						rename.isError
							? "The connection could not be renamed. It may have changed since you opened this page. Try again."
							: "The connection could not be removed. It may have changed since you opened this page. Try again."
					}
				/>
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

function automaticRunWhen(trigger: AppRuntimeTrigger): string {
	switch (trigger.kind) {
		case "schedule":
			return `On a schedule · next scheduled time ${absoluteTime(nextSkillScheduleFireAt(trigger.cron, new Date()))}`;
		case "webhook":
			return "When a webhook arrives";
		case "interaction":
			return "When someone uses the app";
		case "skill":
			return "When the linked skill finishes";
	}
}

export function WorkspaceAppTriggers({
	workspaceId,
	gadgetId,
}: {
	workspaceId: string;
	gadgetId: string;
}) {
	const input = { workspaceId, gadgetId };
	const query = useQuery({
		...osQuery.osAppRuntime.listTriggers.queryOptions({ input }),
		retry: false,
	});
	const client = useQueryClient();
	const toggle = useMutation({
		mutationFn: (choice: { triggerId: string; enabled: boolean }) =>
			osApi.osAppRuntime.setTriggerEnabled({ ...input, ...choice }),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.osAppRuntime.listTriggers.key(),
			}),
	});
	if (!query.data?.items.length) return null;
	return (
		<section aria-label="Automatic runs" className="grid gap-3">
			<SectionEyebrow title="Automatic runs" count={query.data.items.length} />
			<Collection aria-label="Automatic runs for this app">
				{query.data.items.map(({ trigger, enabled, lastRunAt }, index) => (
					<WorkspaceListRow
						key={trigger.id}
						className="items-center justify-between gap-3"
					>
						<div className="min-w-0 flex-1">
							<Text as="p" role="body" className="m-0">
								{automaticRunWhen(trigger)}
							</Text>
							<Text as="p" role="label" tone="secondary" className="m-0">
								{lastRunAt ? (
									<time dateTime={lastRunAt} title={absoluteTime(lastRunAt)}>
										Last ran {relativeTime(lastRunAt)}
									</time>
								) : (
									"Has not run yet"
								)}
							</Text>
							{trigger.kind === "schedule" && !enabled ? (
								<Text as="p" role="label" tone="secondary" className="m-0">
									Off until you turn it on.
								</Text>
							) : null}
						</div>
						<Switch
							aria-label={`Automatic run ${index + 1}: ${automaticRunWhen(trigger)}`}
							checked={enabled}
							disabled={toggle.isPending}
							onCheckedChange={(checked) =>
								toggle.mutate({ triggerId: trigger.id, enabled: checked })
							}
						/>
					</WorkspaceListRow>
				))}
			</Collection>
			{toggle.isError ? (
				<Alert
					variant="destructive"
					description="The automatic run could not be changed. Refresh and try again."
				/>
			) : null}
		</section>
	);
}

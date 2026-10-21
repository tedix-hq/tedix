import { SettingsRow } from "@/components/settings-row";
import { Label } from "@/components/kumo/label";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { osQuery, activeWorkspacesQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Switch } from "@/components/kumo/switch";
import { Checkbox } from "@/components/kumo/checkbox";
import { Button } from "@/components/kumo/button";
import { toast } from "@/components/kumo/toast";
export function TediConsoleAccess({ tediId }: { tediId: string }) {
	const context = useOsOperationalContext();
	const admin =
		context.isSuccess &&
		context.data?.authority.authType === "user" &&
		["owner", "admin", "tenant-admin"].includes(
			context.data.authority.role ?? "",
		);
	if (!admin) return null;
	return <ConsoleAccessForm key={tediId} tediId={tediId} />;
}

function ConsoleAccessForm({ tediId }: { tediId: string }) {
	const queryClient = useQueryClient();
	const options = osQuery.tediConsole.getGrant.queryOptions({
		input: { tediId },
	});
	const grant = useQuery(options);
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const [draft, setDraft] = useState<{
		source: typeof grant.data;
		enabled: boolean;
		workspaceIds: string[];
	} | null>(null);
	const current = draft?.source === grant.data ? draft : grant.data;
	const enabled = current?.enabled ?? false;
	const workspaceIds = (current?.workspaceIds ?? []).filter((id) =>
		workspaces.data?.items.some((workspace) => workspace.id === id),
	);
	const readsReady =
		grant.isSuccess &&
		!grant.isFetching &&
		!grant.isPlaceholderData &&
		workspaces.isSuccess &&
		!workspaces.isFetching &&
		!workspaces.isPlaceholderData;
	const save = useMutation({
		...osQuery.tediConsole.setGrant.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: options.queryKey });
			toast.success("Console access saved; previous sessions revoked");
		},
		onError: () => toast.error("Console access could not be saved"),
	});
	const disabled = !readsReady || save.isPending;
	const canSave = !disabled && (!enabled || workspaceIds.length > 0);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Console access</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{grant.isPending || grant.isFetching ? (
					<p role="status" className="text-kumo-subtle">
						Loading console access settings…
					</p>
				) : null}
				{grant.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							Console access settings are unavailable. Read them again before
							saving.
						</AlertDescription>
						<Button
							variant="outline"
							className="mt-3"
							disabled={grant.isFetching}
							onClick={() => void grant.refetch()}
						>
							Retry console access settings
						</Button>
					</Alert>
				) : null}
				<SettingsRow
					title={
						<Label htmlFor="console-access-enabled">
							Allow console access (read-only)
						</Label>
					}
					description="The tedi signs in as itself. Choose the Workspaces it may read. Console sessions cannot write or approve changes."
				>
					<Switch
						id="console-access-enabled"
						checked={enabled}
						disabled={disabled}
						onCheckedChange={(value) =>
							setDraft({ source: grant.data, enabled: value, workspaceIds })
						}
					/>
				</SettingsRow>
				{workspaces.isPending || workspaces.isFetching ? (
					<p role="status" className="text-kumo-subtle">
						Loading Workspaces…
					</p>
				) : null}
				{workspaces.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							Workspaces are unavailable. Read them again before saving.
						</AlertDescription>
						<Button
							variant="outline"
							className="mt-3"
							disabled={workspaces.isFetching}
							onClick={() => void workspaces.refetch()}
						>
							Retry Workspaces
						</Button>
					</Alert>
				) : null}
				{workspaces.isSuccess && !workspaces.data.items.length ? (
					<p className="text-kumo-subtle">
						No active Workspaces are available. Console access needs at least
						one Workspace when enabled.
					</p>
				) : null}
				<div className="space-y-2 [&_label]:min-h-11! [&_label]:min-w-0 [&_label]:break-words">
					{workspaces.data?.items.map((workspace) => (
						<Checkbox
							key={workspace.id}
							label={workspace.name}
							checked={workspaceIds.includes(workspace.id)}
							disabled={!enabled || disabled}
							onCheckedChange={(checked) =>
								setDraft({
									source: grant.data,
									enabled,
									workspaceIds: checked
										? [...workspaceIds, workspace.id]
										: workspaceIds.filter((id) => id !== workspace.id),
								})
							}
						/>
					))}
				</div>
				{save.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							Console access could not be saved. Your selections are kept; try
							saving again.
						</AlertDescription>
					</Alert>
				) : null}
				<Button
					disabled={!canSave}
					onClick={() => {
						if (canSave) save.mutate({ tediId, enabled, workspaceIds });
					}}
				>
					Save console access
				</Button>
			</CardContent>
		</Card>
	);
}

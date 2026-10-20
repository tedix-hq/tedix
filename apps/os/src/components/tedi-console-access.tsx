import { SettingsRow } from "@/components/settings-row";
import { Label } from "@/components/kumo/label";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
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
		context.data?.authority.authType === "user" &&
		["owner", "admin", "tenant-admin"].includes(
			context.data.authority.role ?? "",
		);
	const queryClient = useQueryClient();
	const options = osQuery.tediConsole.getGrant.queryOptions({
		input: { tediId },
	});
	const grant = useQuery({ ...options, enabled: admin });
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(),
		enabled: admin,
	});
	const [enabled, setEnabled] = useState(false);
	const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
	useEffect(() => {
		if (grant.data) {
			setEnabled(grant.data.enabled);
			setWorkspaceIds(grant.data.workspaceIds);
		}
	}, [grant.data]);
	const save = useMutation({
		...osQuery.tediConsole.setGrant.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: options.queryKey });
			toast.success("Console access saved; previous sessions revoked");
		},
		onError: () => toast.error("Console access could not be saved"),
	});
	if (!admin) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Console access</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
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
						disabled={!grant.data || save.isPending}
						onCheckedChange={setEnabled}
					/>
				</SettingsRow>
				{workspaces.data?.items.map((workspace) => (
					<Checkbox
						key={workspace.id}
						label={workspace.name}
						checked={workspaceIds.includes(workspace.id)}
						disabled={!enabled || save.isPending}
						onCheckedChange={(checked) =>
							setWorkspaceIds((ids) =>
								checked
									? [...ids, workspace.id]
									: ids.filter((id) => id !== workspace.id),
							)
						}
					/>
				))}
				{grant.isError || workspaces.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							Console access settings are unavailable.
						</AlertDescription>
					</Alert>
				) : null}
				<Button
					disabled={
						!grant.data ||
						save.isPending ||
						(enabled && (workspaces.isError || !workspaceIds.length))
					}
					onClick={() => save.mutate({ tediId, enabled, workspaceIds })}
				>
					Save console access
				</Button>
			</CardContent>
		</Card>
	);
}

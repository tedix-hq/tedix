import {
	ConnectionAllowedResourcesSchema,
	type ConnectionInventoryRow,
} from "@tedix/api-contract/schemas/connections";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import { Switch } from "@/components/kumo/switch";
import { Textarea } from "@/components/kumo/textarea";
import { osQuery } from "@/lib/os-query-options";

export function ConnectionResourceLimitsEditor({
	row,
	canManage,
}: {
	row: ConnectionInventoryRow;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const supported =
		/github/i.test(row.provider.name) ||
		row.allowedResources?.some((r) => r.resourceType === "github_repository");
	const input = {
		providerId: row.provider.appId,
		...(row.connectionInstanceId ? { id: row.connectionInstanceId } : {}),
	};
	const options = osQuery.connections.getAllowedResources.queryOptions({
		input,
	});
	const limits = useQuery({ ...options, enabled: Boolean(supported) });
	const [draft, setDraft] = useState<{
		source: typeof limits.data;
		limited: boolean;
		text: string;
	} | null>(null);
	const current = draft?.source === limits.data ? draft : null;
	const limited = current?.limited ?? limits.data?.allowedResources != null;
	const text =
		current?.text ??
		limits.data?.allowedResources?.map((r) => r.resourceId).join("\n") ??
		"";
	const parsed = ConnectionAllowedResourcesSchema.safeParse(
		text
			.split(/\r?\n/)
			.map((id) => id.trim())
			.filter(Boolean)
			.map((resourceId) => ({ resourceType: "github_repository", resourceId })),
	);
	const save = useMutation({
		...osQuery.connections.setAllowedResources.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: options.queryKey });
			await queryClient.invalidateQueries({
				queryKey: osQuery.connections.getConnectionsOverview.key(),
			});
			setDraft(null);
		},
	});
	if (!supported) return null;
	const disabled =
		!canManage || save.isPending || !limits.isSuccess || limits.isFetching;
	const set = (change: { limited?: boolean; text?: string }) => {
		save.reset();
		setDraft({ source: limits.data, limited, text, ...change });
	};
	return (
		<div className="grid min-w-0 gap-3 border-t border-kumo-line pt-4">
			<div className="flex flex-wrap items-center gap-3">
				<Switch
					className="min-h-6 min-w-11"
					aria-label={`Limit repositories for ${row.accountLabel ?? row.provider.name}`}
					checked={limited}
					disabled={disabled}
					onCheckedChange={(checked) => set({ limited: checked })}
				/>
				<span>
					{limited
						? "Only these repositories"
						: "All repositories this account can access"}
				</span>
			</div>
			<p className="m-0 text-kumo-subtle">
				{row.connectionInstanceId
					? "Organization-wide limits still apply to this account."
					: "These limits apply to every organization account for this connection."}
			</p>
			{limited ? (
				<>
					<Textarea
						aria-label="Allowed repositories"
						placeholder={"example/repo-x\nexample/repo-z"}
						value={text}
						disabled={disabled}
						onChange={(e) => set({ text: e.target.value })}
					/>
					<p className="m-0 text-kumo-subtle">
						One owner/repository per line. An empty list blocks every
						repository. Only supported operations can use a limited connection.
					</p>
					{!parsed.success ? (
						<p role="alert">Enter repository names as owner/repository.</p>
					) : null}
				</>
			) : null}
			{limits.isError ? (
				<p role="alert">
					Resource limits are unavailable.{" "}
					<Button onClick={() => void limits.refetch()}>
						Retry resource limits
					</Button>
				</p>
			) : null}
			{save.isError ? (
				<p role="alert">
					Resource limits could not be saved. Your changes are still here; try
					again.
				</p>
			) : null}
			{save.isSuccess ? <p role="status">Resource limits saved.</p> : null}
			<Button
				className="w-fit"
				disabled={disabled || !draft || (limited && !parsed.success)}
				onClick={() => {
					if (limited && !parsed.success) return;
					save.mutate({
						...input,
						allowedResources: limited && parsed.success ? parsed.data : null,
					});
				}}
			>
				{save.isPending ? "Saving…" : "Save resource limits"}
			</Button>
		</div>
	);
}

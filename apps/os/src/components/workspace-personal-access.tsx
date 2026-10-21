import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersonalAccessLevelValue } from "@tedix/api-contract/schemas/os-workspace-schedules";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { personalAccessLevel } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Alert } from "@/components/kumo/alert";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workspaceSchedulesQueryOptions,
} from "@/lib/os-query-options";

const PERSONAL_ACCESS_LABELS: Record<PersonalAccessLevelValue, string> = {
	none: "No access",
	read: "Read",
	organise:
		"Read + organise (archive, label, unsubscribe; never sends or deletes)",
};

const RANK = { none: 0, read: 1, organise: 2 } as const;

/**
 * What this Workspace's skills may do with the viewer's own attached account:
 * nothing, read it, or read and organise it. One choice covers every skill the
 * Workspace runs that uses the account; it never sends or deletes. Only the
 * account's owner can change it; the server enforces that.
 */
export function WorkspacePersonalAccess({
	workspaceId,
	resource,
}: {
	workspaceId: string;
	resource: OsWorkspaceResource;
}) {
	const queryClient = useQueryClient();
	const grants = useQuery({
		...osQuery.personalResourceDelegations.list.queryOptions({
			input: { limit: 100 },
		}),
		retry: false,
	});
	const now = new Date().toISOString();
	const level = (grants.data ?? [])
		.filter(
			(grant) =>
				grant.workspaceId === workspaceId &&
				grant.resourceId === resource.id &&
				!grant.revokedAt &&
				grant.expiresAt > now,
		)
		.map((grant) => personalAccessLevel(grant.operations))
		.reduce<PersonalAccessLevelValue>(
			(best, next) => (RANK[next] > RANK[best] ? next : best),
			"none",
		);
	const change = useMutation({
		mutationFn: (next: PersonalAccessLevelValue) =>
			osApi.osWorkspaces.schedules.setPersonalAccess({
				workspaceId,
				resourceId: resource.id,
				level: next,
			}),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQuery.personalResourceDelegations.list.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: workspaceSchedulesQueryOptions(workspaceId).queryKey,
				}),
			]),
	});
	if (grants.isPending) return null;
	const shown = change.isPending ? change.variables : level;
	return (
		<div className="mt-2 grid gap-1" data-workspace-personal-access>
			<Text as="p" role="label" tone="secondary" className="m-0">
				What this workspace's skills may do with it
			</Text>
			<Select
				value={shown}
				onValueChange={(value) => {
					if (value && value !== level)
						change.mutate(value as PersonalAccessLevelValue);
				}}
				disabled={change.isPending}
			>
				<SelectTrigger aria-label="Access for this workspace's skills">
					<SelectValue>{PERSONAL_ACCESS_LABELS[shown]}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{(["none", "read", "organise"] as const).map((value) => (
						<SelectItem key={value} value={value}>
							{PERSONAL_ACCESS_LABELS[value]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{change.isError && (
				<Alert variant="destructive" description={change.error.message} />
			)}
		</div>
	);
}

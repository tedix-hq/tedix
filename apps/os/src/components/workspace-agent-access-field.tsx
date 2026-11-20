import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import {
	APPROVAL_MODES,
	type ApprovalMode,
	workspaceHighestApprovalMode,
	workspaceMachineAccess,
} from "@tedix/api-contract/schemas/workspace-agent-access";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { APPROVAL_MODE_TEXT } from "@/components/workspace-chat-approval-mode";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";

/**
 * What the agent and tedis may do in this workspace's chat. Saves straight
 * away, like the icon; the server checks the person's build access.
 */
export function WorkspaceAgentAccessField({
	workspace,
}: {
	workspace: OsWorkspace;
}) {
	const queryClient = useQueryClient();
	const [failure, setFailure] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (
			change:
				| { machineAccess: boolean }
				| { highestApprovalMode: ApprovalMode },
		) =>
			osApi.osWorkspaces.workspaces.setAgentAccess({
				workspaceId: workspace.id,
				...change,
			}),
		onSuccess: async () => {
			setFailure(null);
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
		},
		onError: (error) =>
			setFailure(
				error instanceof Error && error.message
					? error.message
					: "The setting could not be saved.",
			),
	});
	const shared = workspace.visibility !== "private";
	const highest = workspaceHighestApprovalMode(workspace);

	return (
		<div className="grid gap-3">
			<div className="grid gap-1">
				<Switch
					label="Let the agent and tedis use your computer here"
					checked={workspaceMachineAccess(workspace)}
					disabled={save.isPending}
					onCheckedChange={(machineAccess) => save.mutate({ machineAccess })}
				/>
				<Text role="caption" tone="secondary">
					{shared
						? "Only the computer of the person who sent the message is used, and they approve every step on it, reading included."
						: "Your computer is used only for messages you send yourself, never for scheduled or app-started ones."}
				</Text>
			</div>
			<div className="grid gap-2">
				<Text as="span" role="label" weight="medium">
					Most freedom members may give the agent
				</Text>
				<Select
					value={highest}
					onValueChange={(mode) =>
						save.mutate({ highestApprovalMode: mode as ApprovalMode })
					}
					disabled={save.isPending}
				>
					<SelectTrigger
						aria-label="Most freedom members may give the agent"
						size="sm"
					>
						<SelectValue>{APPROVAL_MODE_TEXT[highest].label}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{APPROVAL_MODES.map((mode) => (
							<SelectItem key={mode} value={mode}>
								{APPROVAL_MODE_TEXT[mode].label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Text role="caption" tone="secondary">
					Each person picks how often the agent asks them, under the message
					box, up to this level.
				</Text>
			</div>
			{failure ? (
				<Text aria-atomic="true" aria-live="assertive" tone="error">
					{failure}
				</Text>
			) : null}
		</div>
	);
}

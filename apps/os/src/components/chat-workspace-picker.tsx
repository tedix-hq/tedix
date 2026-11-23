import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuRadioItemIndicator,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

const personalInput = { input: { create: false } };

/**
 * The workspace a /chat conversation runs in, shown beside the composer like a
 * project in other chat apps. On a new chat the person can pick which of their
 * own private workspaces new chats go to; an existing chat stays where it is
 * and only links to its workspace.
 */
export function ChatWorkspacePicker({
	workspaceId,
	isNewChat,
}: {
	workspaceId: string;
	isNewChat: boolean;
}) {
	const queryClient = useQueryClient();
	const personal = useQuery({
		...osQuery.osWorkspaces.workspaces.personal.queryOptions(personalInput),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const choices = personal.data?.choices ?? [];
	const listed = choices.find((choice) => choice.id === workspaceId);
	const fetched = useQuery({
		...osQuery.osWorkspaces.workspaces.get.queryOptions({
			input: { workspaceId },
		}),
		enabled: !listed,
	});
	const name = listed?.name ?? fetched.data?.workspace.name ?? "Workspace";
	const choose = useMutation({
		mutationFn: (id: string) =>
			osApi.osWorkspaces.workspaces.choosePersonal({ workspaceId: id }),
		onSuccess: async ({ workspace }) => {
			queryClient.setQueryData(
				osQuery.osWorkspaces.workspaces.personal.queryKey(personalInput),
				(current: typeof personal.data) =>
					current ? { ...current, workspace } : current,
			);
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
			toast.success(`New chats now go to ${workspace.name}`);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "The chat workspace wasn't changed")),
	});
	const canSwitch = isNewChat && choices.length > 1;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="workspace-chat-meta-button"
						aria-label={`Workspace: ${name}`}
						disabled={choose.isPending}
					>
						<span className="truncate">{name}</span>
					</Button>
				}
			/>
			<DropdownMenuContent>
				{canSwitch ? (
					<>
						<DropdownMenuGroup>
							<DropdownMenuLabel>New chats go to</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={workspaceId}
								onValueChange={(next) => {
									if (typeof next === "string" && next !== workspaceId)
										choose.mutate(next);
								}}
							>
								{choices.map((choice) => (
									<DropdownMenuRadioItem
										closeOnClick
										key={choice.id}
										value={choice.id}
									>
										{choice.name}
										<DropdownMenuRadioItemIndicator />
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
					</>
				) : (
					<DropdownMenuGroup>
						<DropdownMenuLabel>
							{isNewChat
								? "New chats go to your private workspace"
								: "This chat is saved in"}
						</DropdownMenuLabel>
					</DropdownMenuGroup>
				)}
				<DropdownMenuLinkItem href={`/workspace/${workspaceId}`}>
					Open {name}
				</DropdownMenuLinkItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

import { CheckCircle, Circle, ListChecks } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { OsRouterLink } from "@/components/kumo/link-provider";
import { SidebarMenu, SidebarMenuButton } from "@/components/kumo/sidebar";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	dispatcherHealthQueryOptions,
	osQuery,
	userConnectionsQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";

interface GetStartedStep {
	id: string;
	title: string;
	description: string;
	to: string;
	done: boolean;
}

/**
 * The remaining first steps, read from what the organization already has
 * rather than from stored ticks. Null while the person has finished them all,
 * hidden the list, or not yet been through the welcome.
 */
function useGetStartedSteps(): GetStartedStep[] | null {
	const profile = useQuery(userProfileQueryOptions());
	const enabled =
		profile.data?.welcomeCompleted === true &&
		profile.data.getStartedHidden !== true;
	const read = { enabled, staleTime: 60_000, retry: false };
	const conversations = useQuery({
		...osQuery.kernelRuntime.listConversations.queryOptions({
			input: { includeArchived: true, limit: 1 },
		}),
		...read,
	});
	const connections = useQuery({ ...userConnectionsQueryOptions(), ...read });
	const computers = useQuery({ ...dispatcherHealthQueryOptions(), ...read });
	if (
		!enabled ||
		conversations.isPending ||
		connections.isPending ||
		computers.isPending
	)
		return null;
	const steps = [
		{
			id: "question",
			title: "Ask your first question",
			description: "Start a chat and ask Tedix to research, draft or plan.",
			to: "/chat",
			done: (conversations.data?.conversations.length ?? 0) > 0,
		},
		{
			id: "tools",
			title: "Connect your tools",
			description:
				"Add an app and connect your account so agents can work with it.",
			to: "/explore/apps",
			done: (connections.data?.data.length ?? 0) > 0,
		},
		{
			id: "computer",
			title: "Set up this computer",
			description:
				"Let Tedix work with the coding agents on your computer and run tasks there.",
			to: "/install",
			done: (computers.data?.data.length ?? 0) > 0,
		},
	];
	return steps.every((step) => step.done) ? null : steps;
}

/** The sidebar entry that reopens the list until every step is done. */
export function GetStartedEntry({ onOpen }: { onOpen: () => void }) {
	const steps = useGetStartedSteps();
	if (!steps) return null;
	const done = steps.filter((step) => step.done).length;
	const progress = `${done} of ${steps.length}`;
	return (
		<SidebarMenu aria-label="Get started">
			<SidebarMenuButton
				icon={ListChecks}
				onClick={onOpen}
				tooltip={`Get started: ${progress} done`}
			>
				Get started
				<span className="ml-auto text-kumo-subtle tabular-nums group-data-[state=collapsed]/sidebar:hidden">
					{progress}
				</span>
			</SidebarMenuButton>
		</SidebarMenu>
	);
}

export function GetStartedChecklist({ onClose }: { onClose: () => void }) {
	const queryClient = useQueryClient();
	const steps = useGetStartedSteps();
	const hide = useMutation({
		mutationFn: () =>
			osApi.userProfile.completeWelcome({ hideChecklist: true }),
		onSuccess: () => {
			queryClient.setQueryData(userProfileQueryOptions().queryKey, (profile) =>
				profile ? { ...profile, getStartedHidden: true } : profile,
			);
			onClose();
		},
	});
	// Reopening continues at the first step that still needs action.
	const next = steps?.find((step) => !step.done);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Get started</DialogTitle>
					<DialogDescription>
						{steps
							? "Each step is ticked once it is done. Pick up where you left off."
							: "You're ready. Every step is done."}
					</DialogDescription>
				</DialogHeader>
				<ul className="m-0 grid list-none gap-1 p-0">
					{steps?.map((step) => (
						<li key={step.id}>
							<OsRouterLink
								className="flex items-start gap-3 rounded-md px-2 py-2 text-kumo-default no-underline hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-focus"
								onClick={onClose}
								to={step.to}
							>
								{step.done ? (
									<CheckCircle
										aria-label="Done"
										className="mt-0.5 shrink-0 text-kumo-success"
										size={18}
										weight="fill"
									/>
								) : (
									<Circle
										aria-label="Not done yet"
										className="mt-0.5 shrink-0 text-kumo-subtle"
										size={18}
									/>
								)}
								<span className="grid gap-0.5">
									<Text as="span" weight="medium">
										{step.title}
									</Text>
									<Text as="span" role="label" tone="secondary">
										{step.description}
									</Text>
								</span>
							</OsRouterLink>
						</li>
					))}
				</ul>
				{hide.isError ? (
					<p role="alert">
						The list was not hidden. Check your connection and try again.
					</p>
				) : null}
				<DialogFooter>
					<Button
						disabled={hide.isPending}
						onClick={() => hide.mutate()}
						variant="ghost"
					>
						Hide this list
					</Button>
					{next ? (
						<Button onClick={onClose} render={<OsRouterLink to={next.to} />}>
							Continue: {next.title}
						</Button>
					) : (
						<Button onClick={onClose}>Close</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

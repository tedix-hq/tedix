import { useQuery } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import type { ReactNode } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import {
	canvasOutputsQueryOptions,
	osQuery,
	workspaceCollaboratorsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

const UNAVAILABLE = "Not available";
const LOADING = <Loader size="sm" aria-label="Loading" />;

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 max-sm:grid-cols-1">
			<Text as="dt" role="label" tone="secondary">
				{label}
			</Text>
			<Text as="dd" role="body" className="m-0 break-words">
				{children}
			</Text>
		</div>
	);
}

function count(value: number, one: string, many: string): string {
	return `${value.toLocaleString("en")} ${value === 1 ? one : many}`;
}

/**
 * The facts about a workspace, readable without opening it: who owns it, when
 * it was created and last changed, and how much is in it.
 */
export function WorkspaceInfoDialog({
	workspace,
	onOpenChange,
}: {
	workspace: OsWorkspace;
	onOpenChange: (open: boolean) => void;
}) {
	const access = useQuery(workspaceCollaboratorsQueryOptions(workspace.id));
	const files = useQuery(canvasOutputsQueryOptions(workspace.id));
	// The newest recorded change: a saved file, a chat message or an agent run.
	const latest = useQuery(
		osQuery.osWorkspaces.workspaces.activity.queryOptions({
			input: { workspaceId: workspace.id, limit: 1 },
		}),
	);
	const lastActive = latest.isPending
		? null
		: (latest.data?.items[0]?.occurredAt ?? workspace.updatedAt);
	const conversations = workspace.summary?.usage.conversationCount;

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>About {workspace.name}</DialogTitle>
					<DialogDescription>
						{workspace.description ||
							"A workspace keeps related conversations, documents and Work together."}
					</DialogDescription>
				</DialogHeader>
				<dl aria-label="Workspace information" className="m-0 grid gap-3">
					<Fact label="Owner">
						{access.isPending
							? LOADING
							: (access.data?.ownerName ?? UNAVAILABLE)}
					</Fact>
					<Fact label="Who can see it">
						{workspace.visibility === "private"
							? "Only the owner and people it is shared with"
							: "Everyone in the organization"}
					</Fact>
					<Fact label="Created">{absoluteTime(workspace.createdAt)}</Fact>
					<Fact label="Last active">
						{lastActive ? (
							<span title={absoluteTime(lastActive)}>
								{relativeTime(lastActive)}
							</span>
						) : (
							LOADING
						)}
					</Fact>
					<Fact label="Files">
						{files.isPending
							? LOADING
							: files.data
								? files.data.truncated
									? `More than ${count(files.data.items.length, "file", "files")}`
									: count(files.data.items.length, "file", "files")
								: UNAVAILABLE}
					</Fact>
					<Fact label="Conversations">
						{conversations === undefined
							? "Not counted yet"
							: count(conversations, "conversation", "conversations")}
					</Fact>
				</dl>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

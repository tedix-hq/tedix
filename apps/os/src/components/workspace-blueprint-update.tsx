import { ArrowCircleUp } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsBlueprintUpgradeReport,
	OsWorkspace,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { blueprintDetailQueryOptions, osQuery } from "@/lib/os-query-options";

type Candidate = { id: string; revision: number };

/**
 * The newer published version of the blueprint this workspace was made from,
 * or null when it is up to date, hand-made, or the owner already chose to
 * stay on this version after looking at that same update.
 */
export function blueprintUpdateCandidate(
	workspace: Pick<
		OsWorkspace,
		"sourceBlueprintRevisionNumber" | "blueprintDecision"
	>,
	current:
		| { id: string; revision: number; publishedAt: string | null }
		| null
		| undefined,
): Candidate | null {
	const pinned = workspace.sourceBlueprintRevisionNumber;
	if (!current || pinned === null || current.publishedAt === null) return null;
	if (current.revision <= pinned) return null;
	const decision = workspace.blueprintDecision;
	if (
		decision?.decision === "stay_pinned" &&
		decision.reviewedRevisionId === current.id
	) {
		return null;
	}
	return { id: current.id, revision: current.revision };
}

const APP_CHANGE: Record<string, string> = {
	added: "New app",
	changed: "Updated app",
	removed: "Removed app (archived, not deleted)",
};

const REQUIREMENT_CHANGE: Record<string, string> = {
	added: "Now needs",
	removed: "No longer needs",
	repinned: "Needs a different version of",
};

/** Plain-language lines for what an update changes. */
export function blueprintUpdateChanges(
	report: Pick<
		OsBlueprintUpgradeReport,
		"gadgetChanges" | "requirementChanges"
	>,
): string[] {
	return [
		...report.gadgetChanges.flatMap((row) =>
			APP_CHANGE[row.change] ? [`${APP_CHANGE[row.change]}: ${row.name}`] : [],
		),
		...report.requirementChanges.flatMap((row) =>
			REQUIREMENT_CHANGE[row.change]
				? [`${REQUIREMENT_CHANGE[row.change]} ${row.subject}`]
				: [],
		),
	];
}

/** The update this workspace's blueprint offers, if any, with the blueprint's name. */
export function useBlueprintUpdate(workspace: OsWorkspace | undefined) {
	const blueprintId = workspace?.sourceBlueprintId ?? null;
	const blueprint = useQuery({
		...blueprintDetailQueryOptions(blueprintId ?? ""),
		// Hand-made workspaces never ask for a blueprint.
		enabled: blueprintId !== null,
		retry: false,
	});
	const candidate =
		workspace && blueprint.data
			? blueprintUpdateCandidate(workspace, blueprint.data.currentRevision)
			: null;
	return candidate && blueprint.data
		? { candidate, blueprintName: blueprint.data.blueprint.name }
		: null;
}

/** Header marker; at phone width it hides and the workspace menu carries it. */
export function BlueprintUpdateButton({
	compact,
	revision,
	blueprintName,
	onOpen,
}: {
	compact: boolean;
	revision: number;
	blueprintName: string;
	onOpen: () => void;
}) {
	return (
		<Button
			size="sm"
			variant={compact ? "ghost" : "secondary"}
			className={compact ? "hidden sm:inline-flex" : undefined}
			title={`Version ${revision} of ${blueprintName} is available`}
			onClick={onOpen}
			data-blueprint-update
		>
			<ArrowCircleUp size={14} /> Update available
		</Button>
	);
}

export function BlueprintUpdateDialog({
	workspace,
	blueprintName,
	candidate,
	onOpenChange,
}: {
	workspace: OsWorkspace;
	blueprintName: string;
	candidate: Candidate;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const preview = useQuery(
		osQuery.osWorkspaces.workspaces.previewBlueprintUpgrade.queryOptions({
			input: {
				workspaceId: workspace.id,
				candidateRevisionId: candidate.id,
			},
			retry: false,
		}),
	);
	const decide = useMutation({
		mutationFn: (decision: "apply" | "stay_pinned") =>
			osApi.osWorkspaces.workspaces.decideBlueprintUpgrade({
				workspaceId: workspace.id,
				decision,
				candidateRevisionId: candidate.id,
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQuery.osWorkspaces.key(),
			});
			onOpenChange(false);
		},
	});
	const report = preview.data?.report;
	const changes = report ? blueprintUpdateChanges(report) : [];
	const pinned = workspace.sourceBlueprintRevisionNumber;
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Update to version {candidate.revision}?</DialogTitle>
					<DialogDescription>
						This workspace was made from {blueprintName}, version {pinned}.
						Updating changes its apps to match version {candidate.revision}.
						Your documents, app data and chats stay as they are.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3" data-blueprint-update-preview>
					{preview.isPending ? (
						<Text role="label" tone="secondary" className="m-0">
							Checking what changes…
						</Text>
					) : preview.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Couldn't check this update</AlertTitle>
							<AlertDescription>
								{(preview.error as Error).message}
							</AlertDescription>
						</Alert>
					) : (
						<>
							<Text as="h3" role="label" tone="strong" className="m-0">
								What changes
							</Text>
							{changes.length > 0 ? (
								<ul className="m-0 grid gap-1 pl-5 text-kumo-default text-sm">
									{changes.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							) : (
								<Text role="label" tone="secondary" className="m-0">
									Nothing you use changes.
								</Text>
							)}
							{report && report.blockingReasons.length > 0 ? (
								<Alert variant="destructive">
									<AlertTitle>This update can't be applied yet</AlertTitle>
									<AlertDescription>
										<ul className="m-0 grid gap-1 pl-5">
											{report.blockingReasons.map((reason) => (
												<li key={reason}>{reason}</li>
											))}
										</ul>
									</AlertDescription>
								</Alert>
							) : null}
							{report && report.consentReasons.length > 0 ? (
								<Alert>
									<AlertTitle>Someone will need to approve</AlertTitle>
									<AlertDescription>
										<ul className="m-0 grid gap-1 pl-5">
											{report.consentReasons.map((reason) => (
												<li key={reason}>{reason}</li>
											))}
										</ul>
									</AlertDescription>
								</Alert>
							) : null}
						</>
					)}
					{decide.isError ? (
						<Alert variant="destructive">
							<AlertTitle>
								{decide.variables === "apply"
									? "Update not applied"
									: "Choice not saved"}
							</AlertTitle>
							<AlertDescription>
								{(decide.error as Error).message}
							</AlertDescription>
						</Alert>
					) : null}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={!report || decide.isPending}
						loading={decide.isPending && decide.variables === "stay_pinned"}
						onClick={() => decide.mutate("stay_pinned")}
					>
						Stay on version {pinned}
					</Button>
					<Button
						disabled={!report?.applyAllowed || decide.isPending}
						loading={decide.isPending && decide.variables === "apply"}
						onClick={() => decide.mutate("apply")}
					>
						Apply update
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Empty } from "@/components/kumo/empty";
import { SearchInput } from "@/components/kumo/search-input";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	skillCatalogQueryOptions,
	workspaceResourcesQueryOptions,
	workspaceSkillSuggestionsQueryOptions,
	workspaceSchedulesQueryOptions,
} from "@/lib/os-query-options";

const SEARCH_LIMIT = 20;

const REASON_LABEL = {
	factory_project: "Its factory belongs to this workspace",
	wrote_outputs: "It wrote this workspace's files",
} as const;

/**
 * Link a skill to the workspace: first the skills its own data says run it
 * (its factory projects and the skills that wrote its files), linked in one
 * step, then any organization skill by search. Linking changes neither the
 * skill nor its schedule.
 */
export function WorkspaceSkillLinkDialog({
	open,
	onOpenChange,
	workspaceId,
	linkedSkillIds,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	linkedSkillIds: readonly string[];
}) {
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const query = search.trim();
	const suggestions = useQuery({
		...workspaceSkillSuggestionsQueryOptions(workspaceId),
		enabled: open,
	});
	const catalog = useQuery({
		...skillCatalogQueryOptions({
			limit: SEARCH_LIMIT,
			offset: 0,
			...(query ? { query } : {}),
		}),
		enabled: open,
		placeholderData: keepPreviousData,
	});
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({
				queryKey: workspaceSchedulesQueryOptions(workspaceId).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: workspaceSkillSuggestionsQueryOptions(workspaceId).queryKey,
			}),
		]);
	const linkOne = useMutation({
		mutationFn: (skillId: string) =>
			osApi.osWorkspaces.schedules.link({ workspaceId, skillId }),
		onSuccess: refresh,
	});
	const linkSuggested = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.schedules.linkFactorySkills({
				workspaceId,
				dryRun: false,
			}),
		onSuccess: refresh,
	});
	const linked = new Set(linkedSkillIds);
	const pending = (suggestions.data?.items ?? []).filter(
		(item) => item.status === "would_link" && !linked.has(item.skillId),
	);
	const error = linkOne.error ?? linkSuggested.error;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="base">
				<DialogHeader>
					<DialogTitle>Link a skill</DialogTitle>
					<DialogDescription>
						A linked skill shows here with its schedule and runs. Linking does
						not change the skill or when it runs.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-6" data-workspace-skill-link-dialog>
					{pending.length > 0 && (
						<section className="grid gap-3" aria-label="Suggested skills">
							<SectionEyebrow
								title="Suggested for this workspace"
								count={pending.length}
								variant="console"
								actions={
									<Button
										size="sm"
										variant="secondary"
										disabled={linkSuggested.isPending}
										onClick={() => linkSuggested.mutate()}
									>
										{pending.length === 1
											? "Link it"
											: `Link all ${pending.length}`}
									</Button>
								}
							/>
							<ul className="m-0 grid list-none gap-1 p-0">
								{pending.map((item) => (
									<li key={item.skillId} className="grid min-w-0 gap-0.5 py-1">
										<Text as="p" role="body" className="m-0 truncate">
											{item.name}
										</Text>
										<Text as="p" role="label" tone="secondary" className="m-0">
											{REASON_LABEL[item.reason]}
										</Text>
									</li>
								))}
							</ul>
						</section>
					)}
					<section className="grid gap-3" aria-label="All skills">
						<SearchInput
							aria-label="Search skills"
							placeholder="Search skills"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
						{catalog.isPending && <ListSkeleton rows={3} rowClassName="h-9" />}
						{catalog.isError && (
							<Text as="p" role="label" tone="error" className="m-0">
								Skills are unavailable: {catalog.error.message}
							</Text>
						)}
						{catalog.data && catalog.data.entries.length === 0 && (
							<Empty
								appearance="inline"
								title={query ? "No skills match your search" : "No skills yet"}
							/>
						)}
						{catalog.data && catalog.data.entries.length > 0 && (
							<ul className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
								{catalog.data.entries.map((skill) => {
									const isLinked = linked.has(skill.id);
									return (
										<li
											key={skill.id}
											className="flex min-w-0 items-center gap-3 py-1"
										>
											<div className="grid min-w-0 flex-1 gap-0.5">
												<Text as="p" role="body" className="m-0 truncate">
													{skill.title}
												</Text>
												{skill.description && (
													<Text
														as="p"
														role="label"
														tone="secondary"
														className="m-0 truncate"
													>
														{skill.description}
													</Text>
												)}
											</div>
											<Button
												size="sm"
												variant={isLinked ? "ghost" : "secondary"}
												disabled={isLinked || linkOne.isPending}
												aria-label={
													isLinked
														? `${skill.title} is linked`
														: `Link ${skill.title}`
												}
												onClick={() => linkOne.mutate(skill.id)}
											>
												{isLinked ? "Linked" : "Link"}
											</Button>
										</li>
									);
								})}
							</ul>
						)}
					</section>
					{error && (
						<Text
							as="p"
							role="label"
							tone="error"
							className="m-0"
							aria-live="polite"
						>
							{error.message}
						</Text>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

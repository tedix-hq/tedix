import type { ConnectionConsumerGrants } from "@tedix/api-contract/schemas/connections";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import { Switch } from "@/components/kumo/switch";
import {
	osQuery,
	skillCatalogQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";

const DIRECTORY_LIMIT = 100;

type Draft = {
	source: ConnectionConsumerGrants | undefined;
	mode: ConnectionConsumerGrants["mode"];
	tediIds: string[];
	skills: Array<{ id: string; revision: number }>;
};

function includesSkill(
	skills: Draft["skills"],
	skill: { id: string; revision: number },
) {
	return skills.some(
		(item) => item.id === skill.id && item.revision === skill.revision,
	);
}

export function ConnectionConsumerGrantsEditor({
	providerId,
	connectionInstanceId,
	accountLabel,
	canManage,
}: {
	providerId: string;
	connectionInstanceId?: string;
	accountLabel?: string;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const input = {
		providerId,
		...(connectionInstanceId ? { connectionInstanceId } : {}),
	};
	const options = osQuery.connections.getConsumerGrants.queryOptions({ input });
	const grants = useQuery(options);
	const tedis = useQuery(tediRosterQueryOptions(DIRECTORY_LIMIT));
	const skills = useQuery(skillCatalogQueryOptions(DIRECTORY_LIMIT));
	const [draft, setDraft] = useState<Draft | null>(null);
	const current = draft?.source === grants.data ? draft : null;
	const mode = current?.mode ?? grants.data?.mode ?? "all";
	const tediIds =
		current?.tediIds ??
		(grants.data?.mode === "selected" ? grants.data.tediIds : []);
	const selectedSkills =
		current?.skills ??
		(grants.data?.mode === "selected" ? grants.data.skills : []);
	const readsReady =
		grants.isSuccess &&
		!grants.isFetching &&
		tedis.isSuccess &&
		!tedis.isFetching &&
		skills.isSuccess &&
		!skills.isFetching;
	const save = useMutation({
		...osQuery.connections.setConsumerGrants.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: options.queryKey });
		},
	});
	const disabled = !canManage || !readsReady || save.isPending;
	const set = (next: Partial<Omit<Draft, "source">>) => {
		save.reset();
		setDraft({
			source: grants.data,
			mode,
			tediIds,
			skills: selectedSkills,
			...next,
		});
	};
	const roster = tedis.data?.data ?? [];
	const catalog = skills.data?.entries ?? [];
	const missingTediIds = tediIds.filter(
		(id) => !roster.some((tedi) => tedi.id === id),
	);
	const olderSkills = selectedSkills.filter(
		(selected) =>
			!catalog.some(
				(skill) =>
					skill.id === selected.id && skill.revision === selected.revision,
			),
	);
	const failedRead = grants.isError || tedis.isError || skills.isError;

	return (
		<div
			className="grid gap-3"
			data-connection-consumer-grants={connectionInstanceId ?? "default"}
		>
			<div className="flex min-h-8 flex-wrap items-center gap-3">
				<Switch
					aria-label={`Limit who can use ${accountLabel ?? providerId}`}
					checked={mode === "selected"}
					disabled={disabled}
					onCheckedChange={(checked) =>
						set({ mode: checked ? "selected" : "all" })
					}
				/>
				<span>
					{mode === "all"
						? "Everyone in the organization"
						: "Only selected tedis and skill revisions"}
				</span>
			</div>
			<p className="m-0 text-kumo-subtle type-tedix-label">
				A skill keeps access only to the exact revision selected here. If no one
				is selected, this connection cannot be used.
			</p>
			{grants.isPending || grants.isFetching ? (
				<p role="status" className="m-0 text-kumo-subtle">
					Loading access settings…
				</p>
			) : null}
			{failedRead ? (
				<Alert variant="destructive">
					<AlertDescription>
						Access settings are unavailable. Read them again before saving.
					</AlertDescription>
					<Button
						variant="outline"
						className="mt-3"
						disabled={
							grants.isFetching || tedis.isFetching || skills.isFetching
						}
						onClick={() => {
							void grants.refetch();
							void tedis.refetch();
							void skills.refetch();
						}}
					>
						Retry access settings
					</Button>
				</Alert>
			) : null}
			{mode === "selected" && (
				<div className="grid gap-4 sm:grid-cols-2">
					<fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
						<legend className="mb-1 font-medium">Tedis</legend>
						{roster.map((tedi) => (
							<Checkbox
								key={tedi.id}
								label={tedi.displayName?.trim() || tedi.name}
								checked={tediIds.includes(tedi.id)}
								disabled={disabled}
								onCheckedChange={(checked) =>
									set({
										tediIds: checked
											? [...tediIds, tedi.id]
											: tediIds.filter((id) => id !== tedi.id),
									})
								}
							/>
						))}
						{missingTediIds.map((id) => (
							<Checkbox
								key={id}
								label={`Unavailable tedi (${id})`}
								checked
								disabled={disabled}
								onCheckedChange={(checked) => {
									if (!checked)
										set({ tediIds: tediIds.filter((item) => item !== id) });
								}}
							/>
						))}
					</fieldset>
					<fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
						<legend className="mb-1 font-medium">Skill revisions</legend>
						{catalog.map((skill) => {
							const selected = { id: skill.id, revision: skill.revision };
							return (
								<Checkbox
									key={`${skill.id}:${skill.revision}`}
									label={`${skill.title} · revision ${skill.revision}`}
									checked={includesSkill(selectedSkills, selected)}
									disabled={disabled}
									onCheckedChange={(checked) =>
										set({
											skills: checked
												? [...selectedSkills, selected]
												: selectedSkills.filter(
														(item) =>
															item.id !== selected.id ||
															item.revision !== selected.revision,
													),
										})
									}
								/>
							);
						})}
						{olderSkills.map((selected) => {
							const title = catalog.find(
								(skill) => skill.id === selected.id,
							)?.title;
							return (
								<Checkbox
									key={`${selected.id}:${selected.revision}`}
									label={`${title ?? "Unavailable skill"} · revision ${selected.revision}`}
									checked
									disabled={disabled}
									onCheckedChange={(checked) => {
										if (!checked)
											set({
												skills: selectedSkills.filter(
													(item) =>
														item.id !== selected.id ||
														item.revision !== selected.revision,
												),
											});
									}}
								/>
							);
						})}
					</fieldset>
				</div>
			)}
			{!canManage ? (
				<p className="m-0 text-kumo-subtle type-tedix-label">
					Only an organization admin can change who may use this connection.
				</p>
			) : null}
			{save.isError ? (
				<Alert variant="destructive">
					<AlertDescription>
						Access settings could not be saved. Your selections are kept; try
						saving again.
					</AlertDescription>
				</Alert>
			) : null}
			{save.isSuccess ? <p role="status">Who can use this was saved.</p> : null}
			<Button
				size="sm"
				className="w-fit max-sm:min-h-11"
				disabled={disabled}
				onClick={() =>
					save.mutate({
						...input,
						policy:
							mode === "all"
								? { mode: "all" }
								: { mode: "selected", tediIds, skills: selectedSkills },
					})
				}
			>
				Save who can use this
			</Button>
		</div>
	);
}

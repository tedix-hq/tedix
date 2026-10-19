import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Link } from "@/components/kumo/link";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { osQuery, projectListQueryOptions } from "@/lib/os-query-options";

export function WorkItemCreate({ projectId }: { projectId?: string }) {
	const [open, setOpen] = useState(false);
	const [hasOpened, setHasOpened] = useState(false);
	return (
		<Collapsible
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (value) setHasOpened(true);
			}}
		>
			<CollapsibleTrigger>New Work item</CollapsibleTrigger>
			<CollapsibleContent keepMounted>
				{hasOpened && <WorkItemCreateForm projectId={projectId} />}
			</CollapsibleContent>
		</Collapsible>
	);
}

export function WorkItemCreateForm({
	projectId: initialProjectId,
}: {
	projectId?: string;
}) {
	const id = useId();
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [projectId, setProjectId] = useState(initialProjectId ?? "");
	const [projectName, setProjectName] = useState("");
	const [search, setSearch] = useState("");
	const projects = useQuery(projectListQueryOptions(100, { search }));
	const client = useQueryClient();
	const create = useMutation({
		mutationFn: () =>
			osApi.workItems.create({ title: title.trim(), description, projectId }),
		retry: false,
		onSuccess: () =>
			client.invalidateQueries({ queryKey: osQuery.workItems.key() }),
	});
	if (create.data) {
		return (
			<div className="grid gap-2 py-3" role="status">
				<Text>Work item created as proposed.</Text>
				<Link href={`/work/items/${create.data.id}`}>{create.data.title}</Link>
				<Text role="label" tone="secondary">
					{create.data.id}
				</Text>
			</div>
		);
	}
	return (
		<form
			className="grid max-w-xl gap-3 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (title.trim() && projectId && !create.isPending) create.mutate();
			}}
		>
			<Label htmlFor={`${id}-project-search`}>Find a project</Label>
			<Input
				id={`${id}-project-search`}
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				disabled={create.isPending}
			/>
			<Label htmlFor={`${id}-project`}>Project</Label>
			<Select
				value={projectId || null}
				onValueChange={(value) => {
					setProjectId(value ?? "");
					setProjectName(
						projects.data?.data.find((project) => project.id === value)?.name ??
							"",
					);
				}}
				disabled={create.isPending}
			>
				<SelectTrigger id={`${id}-project`}>
					<SelectValue placeholder="Choose a project">
						{projectName ||
							projects.data?.data.find((project) => project.id === projectId)
								?.name ||
							(projectId ? "Project from link" : undefined)}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{projects.data?.data.map((project) => (
						<SelectItem key={project.id} value={project.id}>
							{project.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{projects.isPending && <Text>Loading projects…</Text>}
			{projects.error && (
				<div role="alert">
					<Text tone="error">{projects.error.message}</Text>
				</div>
			)}
			{projects.data?.pagination.hasMore && (
				<Text tone="secondary">Search to find more projects.</Text>
			)}
			<Label htmlFor={`${id}-title`}>Title</Label>
			<Input
				id={`${id}-title`}
				value={title}
				onChange={(event) => setTitle(event.target.value)}
				maxLength={500}
				required
				disabled={create.isPending}
			/>
			<Label htmlFor={`${id}-description`}>Description</Label>
			<Textarea
				id={`${id}-description`}
				value={description}
				onChange={(event) => setDescription(event.target.value)}
				maxLength={10000}
				disabled={create.isPending}
			/>
			<Text tone="secondary">
				Creates proposed Work for review before execution.
			</Text>
			{create.error && (
				<div role="alert">
					<Text tone="error">
						{create.error.message} Check the project for an existing item before
						trying again.
					</Text>
				</div>
			)}
			<Button
				type="submit"
				disabled={!title.trim() || !projectId || create.isPending}
			>
				{create.isPending ? "Creating…" : "Create Work item"}
			</Button>
		</form>
	);
}

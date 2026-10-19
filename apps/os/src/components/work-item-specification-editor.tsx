import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectItem,
} from "@/components/kumo/select";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";

export function WorkItemSpecificationEditor({ item }: { item: WorkItem }) {
	const [title, setTitle] = useState(item.title);
	const [description, setDescription] = useState(item.description ?? "");
	const [priority, setPriority] = useState(item.priority);
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: () =>
			osApi.workItems.updateSpecification({
				id: item.id,
				title: title.trim(),
				description,
				priority,
				expectedWorkItemVersion: item.version,
			}),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
	});
	return (
		<Collapsible>
			<CollapsibleTrigger>Edit task details</CollapsibleTrigger>
			<CollapsibleContent>
				<form
					className="grid gap-3 py-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (title.trim() && !save.isPending) save.mutate();
					}}
				>
					<Label htmlFor={`work-title-${item.id}`}>Title</Label>
					<Input
						id={`work-title-${item.id}`}
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						maxLength={500}
						required
						disabled={save.isPending}
					/>
					<Label htmlFor={`work-description-${item.id}`}>Description</Label>
					<Textarea
						id={`work-description-${item.id}`}
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						maxLength={10000}
						disabled={save.isPending}
					/>
					<Label htmlFor={`work-priority-${item.id}`}>Priority</Label>
					<Select
						value={priority}
						onValueChange={(value) => {
							if (value) setPriority(value);
						}}
						disabled={save.isPending}
					>
						<SelectTrigger id={`work-priority-${item.id}`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(["low", "medium", "high", "critical"] as const).map((value) => (
								<SelectItem key={value} value={value}>
									{value}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{save.error ? <p role="alert">{save.error.message}</p> : null}
					{save.isSuccess ? <p role="status">Task details saved.</p> : null}
					<Button type="submit" disabled={!title.trim() || save.isPending}>
						{save.isPending ? "Saving…" : "Save task details"}
					</Button>
				</form>
			</CollapsibleContent>
		</Collapsible>
	);
}

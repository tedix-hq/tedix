import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
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
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { sentenceCase } from "@/lib/format";
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
			<CollapsibleDefaultTrigger>Edit task details</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent>
				<form
					className="grid gap-3 py-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (title.trim() && !save.isPending) save.mutate();
					}}
				>
					<Label htmlFor={`work-title-${item.id}`}>
						<span id={`work-title-label-${item.id}`}>Title</span>
					</Label>
					<Input
						id={`work-title-${item.id}`}
						aria-labelledby={`work-title-label-${item.id}`}
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						maxLength={500}
						required
						disabled={save.isPending}
					/>
					<Label htmlFor={`work-description-${item.id}`}>
						<span id={`work-description-label-${item.id}`}>Description</span>
					</Label>
					<Textarea
						id={`work-description-${item.id}`}
						aria-labelledby={`work-description-label-${item.id}`}
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						maxLength={10000}
						disabled={save.isPending}
					/>
					<Label htmlFor={`work-priority-${item.id}`}>
						<span id={`work-priority-label-${item.id}`}>Priority</span>
					</Label>
					<Select
						value={priority}
						items={{
							low: "Low",
							medium: "Medium",
							high: "High",
							critical: "Critical",
						}}
						onValueChange={(value) => {
							if (value) setPriority(value);
						}}
						disabled={save.isPending}
					>
						<SelectTrigger
							id={`work-priority-${item.id}`}
							aria-labelledby={`work-priority-label-${item.id}`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(["low", "medium", "high", "critical"] as const).map((value) => (
								<SelectItem key={value} value={value}>
									{sentenceCase(value)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{save.error ? (
						<Alert variant="destructive">
							<AlertDescription>{save.error.message}</AlertDescription>
						</Alert>
					) : null}
					{save.isSuccess ? (
						<Text as="p" role="label" tone="secondary" aria-live="polite">
							Task details saved.
						</Text>
					) : null}
					<Button type="submit" disabled={!title.trim() || save.isPending}>
						{save.isPending ? "Saving…" : "Save task details"}
					</Button>
				</form>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}

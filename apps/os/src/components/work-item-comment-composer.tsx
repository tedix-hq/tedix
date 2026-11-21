import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Label } from "@/components/kumo/label";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { osQuery, workItemDetailQueryOptions } from "@/lib/os-query-options";

export function WorkItemCommentComposer({
	itemId,
	onPosted,
}: {
	itemId: string;
	onPosted?: () => void;
}) {
	const [body, setBody] = useState("");
	const fieldId = useId();
	const client = useQueryClient();
	const comment = useMutation({
		mutationFn: (text: string) =>
			osApi.workItems.addComment({ id: itemId, body: text }),
		onSuccess: async () => {
			setBody("");
			await Promise.all([
				client.invalidateQueries({
					queryKey: workItemDetailQueryOptions(itemId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: osQuery.workItems.key(),
				}),
			]);
			onPosted?.();
		},
	});
	return (
		<form
			className="grid gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (body.trim() && !comment.isPending) comment.mutate(body.trim());
			}}
		>
			<Label htmlFor={fieldId}>
				{onPosted ? "Your update" : "Add a comment"}
			</Label>
			<Textarea
				id={fieldId}
				value={body}
				onChange={(event) => setBody(event.target.value)}
				maxLength={10000}
				disabled={comment.isPending}
				placeholder="Share an update or ask a question"
			/>
			{comment.error ? (
				<p role="alert">{comment.error.message}. Your draft is saved here.</p>
			) : null}
			<Button
				loading={comment.isPending}
				type="submit"
				disabled={!body.trim() || comment.isPending}
			>
				{onPosted ? "Post update" : "Post comment"}
			</Button>
		</form>
	);
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Label } from "@/components/kumo/label";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { osQuery, workItemDetailQueryOptions } from "@/lib/os-query-options";

export function WorkItemCommentComposer({
	itemId,
	onPosted,
	reply = false,
}: {
	itemId: string;
	onPosted?: () => void;
	reply?: boolean;
}) {
	const [body, setBody] = useState("");
	const fieldId = useId();
	const client = useQueryClient();
	const comment = useMutation({
		mutationFn: (text: string) =>
			osApi.workItems.addComment({
				id: itemId,
				body: text,
				...(reply ? { metadata: { activityKind: "reply" } } : {}),
			}),
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
			className={
				reply
					? "grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
					: "grid gap-3"
			}
			onSubmit={(event) => {
				event.preventDefault();
				if (body.trim() && !comment.isPending) comment.mutate(body.trim());
			}}
		>
			<Label htmlFor={fieldId} className={reply ? "sr-only" : undefined}>
				{onPosted ? "Your update" : "Add a comment"}
			</Label>
			<Textarea
				id={fieldId}
				value={body}
				onChange={(event) => setBody(event.target.value)}
				maxLength={10000}
				disabled={comment.isPending}
				className={
					reply ? "min-h-11 max-h-32 rounded-2xl text-base" : undefined
				}
				rows={reply ? 1 : undefined}
				placeholder={
					reply ? "Add a comment…" : "Share an update or ask a question"
				}
			/>
			{comment.error ? (
				<p
					role="alert"
					className={reply ? "col-span-full row-start-2" : undefined}
				>
					{comment.error.message}. Your draft is saved here.
				</p>
			) : null}
			<Button
				className={reply ? "size-11 shrink-0 rounded-full p-0" : undefined}
				loading={comment.isPending}
				type="submit"
				disabled={!body.trim() || comment.isPending}
			>
				{reply ? (
					<>
						<PaperPlaneTilt aria-hidden size={20} />
						<span className="sr-only">Post comment</span>
					</>
				) : onPosted ? (
					"Post update"
				) : (
					"Post comment"
				)}
			</Button>
		</form>
	);
}

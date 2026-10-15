import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/kumo/input";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

const MAX_TITLE = 120;

/**
 * The open output's name, editable in place. Enter or leaving the field
 * renames it with the same mutation the Outputs library uses; Escape or an
 * empty name keeps the current one.
 */
export function CanvasOutputTitle({
	outputId,
	title,
	disabled = false,
}: {
	outputId: string;
	title: string;
	disabled?: boolean;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState(title);
	const cancelled = useRef(false);
	useEffect(() => setDraft(title), [title]);
	const rename = useMutation({
		...osQuery.osWorkspaces.outputs.rename.mutationOptions(),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() }),
		onError: () => setDraft(title),
	});
	const commit = () => {
		if (cancelled.current) {
			cancelled.current = false;
			setDraft(title);
			return;
		}
		const next = draft.trim().slice(0, MAX_TITLE);
		if (!next || next === title) {
			setDraft(title);
			return;
		}
		setDraft(next);
		rename.mutate({ outputId, title: next });
	};
	return (
		<Input
			aria-label="Document title"
			className="canvas-document-title-input"
			size="sm"
			value={draft}
			maxLength={MAX_TITLE}
			disabled={disabled || rename.isPending}
			title={rename.error ? "The name could not be saved." : draft}
			aria-invalid={rename.isError || undefined}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				} else if (event.key === "Escape") {
					cancelled.current = true;
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

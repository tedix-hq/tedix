import { Check, Copy } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ChatExecutionDetailsButton } from "@/components/chat-execution-sheet";
import { Button } from "@/components/kumo/button";
import { toast } from "@/components/kumo/toast";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { cn } from "@/lib/utils";

export function ChatMessageActions({
	content,
	runId,
	latest = false,
}: {
	content: string;
	runId?: string | null;
	latest?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (reset.current) clearTimeout(reset.current);
		},
		[],
	);
	return (
		<span
			data-slot="chat-message-actions"
			className={cn(
				"inline-flex items-center gap-2 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 coarse:opacity-100 motion-reduce:transition-none",
				latest ? "opacity-100" : "opacity-0",
			)}
		>
			{content ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={copied ? "Copied" : "Copy"}
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(content);
										setCopied(true);
										toast.success("Copied");
										if (reset.current) clearTimeout(reset.current);
										reset.current = setTimeout(() => setCopied(false), 2000);
									} catch {
										toast.error("Could not copy response");
									}
								}}
								icon={copied ? <Check size={16} /> : <Copy size={16} />}
							/>
						}
					/>
					<TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
				</Tooltip>
			) : null}
			{runId ? <ChatExecutionDetailsButton runId={runId} /> : null}
		</span>
	);
}

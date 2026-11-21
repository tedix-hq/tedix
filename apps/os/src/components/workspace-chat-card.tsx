import type { ComponentProps, ReactNode } from "react";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { cn } from "@/lib/utils";

/**
 * The one card of the chat thread: approvals, a tedi's approval, an account
 * to connect, a coding run and the waiting tray. A head with an icon, a
 * title and a status; a body; a row of actions.
 */
export function ChatCard({
	icon,
	title,
	status,
	meta,
	actions,
	attention = false,
	className,
	children,
	...props
}: Omit<ComponentProps<"section">, "title"> & {
	icon?: ReactNode;
	title: ReactNode;
	/** A badge beside the title. */
	status?: ReactNode;
	/** One quiet line under the title. */
	meta?: ReactNode;
	actions?: ReactNode;
	/** Waiting for the person: drawn with the brand line. */
	attention?: boolean;
}) {
	return (
		<Surface
			tier="panel"
			render={<section {...props} />}
			className={cn("workspace-chat-card", className)}
			data-attention={attention || undefined}
		>
			<div className="workspace-chat-card-head">
				{icon ? (
					<span aria-hidden className="workspace-chat-card-icon">
						{icon}
					</span>
				) : null}
				<div className="workspace-chat-card-title">
					<Text as="strong" role="label">
						{title}
					</Text>
					{meta ? (
						<Text as="span" role="caption" tone="secondary">
							{meta}
						</Text>
					) : null}
				</div>
				{status}
			</div>
			{children}
			{actions ? (
				<div className="workspace-chat-card-actions">{actions}</div>
			) : null}
		</Surface>
	);
}

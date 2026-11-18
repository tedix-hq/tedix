import { BellSlash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { workspaceMuteState } from "@tedix/api-contract/schemas/web-push";
import { useEffect, useState } from "react";
import { osQuery } from "@/lib/os-query-options";
import { cn } from "@/lib/utils";
import { workspaceMuteLabel } from "@/lib/workspace-mute";

/** The longest wait a browser timer takes. */
const MAX_TIMER_MS = 2_000_000_000;

/**
 * Whether the person muted a workspace, and until when (null: until they
 * unmute it). A timed mute ends on screen when its time passes, without a
 * reload.
 */
export function useWorkspaceMuteState(workspaceId: string | undefined) {
	const push = useQuery({
		...osQuery.webPush.getStatus.queryOptions({ input: {} }),
		enabled: !!workspaceId,
	});
	const [, setTick] = useState(0);
	const state = workspaceMuteState(
		push.data?.preferences,
		workspaceId,
		Date.now(),
	);
	const { until } = state;
	useEffect(() => {
		if (!until) return;
		const timer = setTimeout(
			() => setTick((tick) => tick + 1),
			Math.min(Math.max(Date.parse(until) - Date.now(), 0) + 50, MAX_TIMER_MS),
		);
		return () => clearTimeout(timer);
	}, [until]);
	return { ...state, preferences: push.data?.preferences };
}

/** A small crossed-out bell on a workspace the person muted. */
export function WorkspaceMutedIcon({
	workspaceId,
	className,
}: {
	workspaceId: string;
	className?: string;
}) {
	const { muted, until } = useWorkspaceMuteState(workspaceId);
	if (!muted) return null;
	const label = workspaceMuteLabel(until, new Date());
	return (
		<span
			aria-label={label}
			className={cn("inline-flex shrink-0 text-kumo-subtle", className)}
			data-workspace-muted=""
			role="img"
			title={`${label}. Approval requests still reach you.`}
		>
			<BellSlash aria-hidden size={12} />
		</span>
	);
}

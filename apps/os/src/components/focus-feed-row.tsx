import { useEffect, useRef } from "react";
import { Bell, EyeSlash, PushPin, ThumbsDown } from "@phosphor-icons/react";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import type {
	FocusItem,
	FocusSignal,
} from "@tedix/api-contract/utils/focus-feed";
import { FeedCard } from "./focus-feed-card";
import { FocusRowActions } from "./focus-row-actions";
import { FocusDecisionRow } from "./focus-decision-row";

export function FocusRow({
	item,
	actor,
	project,
	busy,
	onReact,
	onWork,
	signal,
	budgeted,
	session,
	events,
	enabled,
	ignoredAfterMs,
}: {
	item: FocusItem;
	actor: string;
	project?: string;
	busy: boolean;
	onReact: Parameters<typeof FeedCard>[0]["onReact"];
	onWork: Parameters<typeof FeedCard>[0]["onWork"];
	signal: (
		item: ActivityFeedItem,
		reaction: FocusSignal,
		extra?: Record<string, string | number | boolean | null>,
	) => Promise<boolean>;
	budgeted: boolean;
	session: { id: string; openedAt: number };
	events: LearningInteractionEvent[];
	enabled: boolean;
	ignoredAfterMs: number;
}) {
	const root = useRef<HTMLDivElement>(null);
	const report = useRef(signal);
	report.current = signal;
	const context = useRef({ events, budgeted });
	context.current = { events, budgeted };
	const initialAbove = useRef(false);
	const engaged = useRef(false);
	useEffect(() => {
		const node = root.current;
		if (!enabled || !node || typeof IntersectionObserver === "undefined")
			return;
		const box = node.getBoundingClientRect();
		initialAbove.current =
			context.current.budgeted &&
			box.top >= 0 &&
			box.bottom <= window.innerHeight;
		let start = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let recorded = false;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting && document.visibilityState === "visible") {
					start = Date.now();
					if (!recorded) {
						recorded = true;
						void report.current(item, "impression", {
							aboveFold: initialAbove.current,
							budgeted: context.current.budgeted,
						});
						const previous = context.current.events.filter(
							(e) =>
								e.targetId === item.id &&
								e.metadata?.reaction === "impression" &&
								e.metadata?.sessionId !== session.id,
						);
						const opened = context.current.events.some(
							(e) => e.targetId === item.id && e.metadata?.reaction === "open",
						);
						if (previous.length >= 1 && !opened)
							timer = setTimeout(() => {
								if (!engaged.current && document.visibilityState === "visible")
									void report.current(item, "ignored_twice");
							}, ignoredAfterMs);
					}
				} else if (start) {
					const elapsed = Date.now() - start;
					start = 0;
					clearTimeout(timer);
					if (elapsed >= 1000)
						void report.current(item, "dwell", { elapsedMs: elapsed });
				}
			},
			{ threshold: 0.5 },
		);
		observer.observe(node);
		return () => {
			observer.disconnect();
			clearTimeout(timer);
			if (start && Date.now() - start >= 1000)
				void report.current(item, "dwell", { elapsedMs: Date.now() - start });
		};
	}, [item.id, session.id, enabled, ignoredAfterMs]);
	function open() {
		engaged.current = true;
		void signal(item, "open", {
			aboveFold: initialAbove.current,
			elapsedMs: Date.now() - session.openedAt,
			needsAction: item.needsAction,
		});
		if (item.needsAction)
			sessionStorage.setItem(
				"tedix-focus-origin",
				JSON.stringify({
					sessionId: session.id,
					openedAt: session.openedAt,
					itemId: item.id,
					source: item.source,
					workItemId: item.workItemId,
					at: Date.now(),
				}),
			);
	}
	const rowActions = [
		{ label: "Pin", reaction: "pin", Icon: PushPin },
		{ label: "Hide", reaction: "hide", Icon: EyeSlash },
		{ label: "Not important", reaction: "not_important", Icon: ThumbsDown },
		{ label: "Tell me earlier", reaction: "tell_me_earlier", Icon: Bell },
	] as const;
	function react(reaction: FocusSignal) {
		engaged.current = true;
		void signal(item, reaction);
	}
	const actions = rowActions.map(({ label, reaction, Icon }) => ({
		label,
		Icon,
		onClick: () => react(reaction),
	}));

	return (
		<div
			ref={root}
			tabIndex={-1}
			role="listitem"
			data-focus-row={item.id}
			className="focus-row"
			onClickCapture={(e) => {
				if (e.target instanceof Element && e.target.closest("a")) open();
			}}
		>
			{item.needsAction ? (
				<FocusDecisionRow item={item} actor={actor} project={project} />
			) : (
				<FeedCard
					item={item}
					actor={actor}
					project={project}
					busy={busy}
					onReact={onReact}
					onWork={onWork}
					rowActions={actions}
				/>
			)}
			{item.because && <p className="focus-because">{item.because}</p>}
			{item.needsAction && <FocusRowActions actions={actions} />}
		</div>
	);
}

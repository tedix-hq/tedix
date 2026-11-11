import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Keeps a piece of the screen running after the place that showed it goes
 * away, so coming back is instant. A workspace app is the reason: its frame
 * holds a loaded editor and unsaved state, and rebuilding it on every tab
 * switch costs a second.
 *
 * Each kept piece renders through a portal into its own element. A slot moves
 * that element into view; when the slot unmounts the element is parked,
 * hidden, with the content still mounted. Moving an element normally reloads
 * any frame inside it, so pieces are only kept where the browser can move one
 * without that (`moveBefore`). Elsewhere a slot renders its content in place,
 * exactly as before.
 */
interface KeepAliveStore {
	show(id: string, node: ReactNode, slot: HTMLElement): void;
	park(id: string): void;
}

const KeepAliveContext = createContext<KeepAliveStore | null>(null);

/** How many hidden pieces stay alive before the oldest is dropped. */
const MAX_PARKED = 4;

type Movable = HTMLElement & {
	moveBefore?: (node: Node, child: Node | null) => void;
};

const canMove = () =>
	typeof Element !== "undefined" && "moveBefore" in Element.prototype;

interface Entry {
	host: HTMLElement;
	node: ReactNode;
	usedAt: number;
	shown: boolean;
}

export function KeepAliveProvider({ children }: { children: ReactNode }) {
	const entries = useRef(new Map<string, Entry>());
	const parking = useRef<HTMLDivElement>(null);
	const clock = useRef(0);
	const [, render] = useState(0);

	const store = useMemo<KeepAliveStore>(
		() => ({
			show(id, node, slot) {
				let entry = entries.current.get(id);
				if (!entry) {
					const host = document.createElement("div");
					// The slot lays out the content; the host is only a handle.
					host.style.display = "contents";
					host.dataset.keepAlive = id;
					entry = { host, node, usedAt: 0, shown: true };
					entries.current.set(id, entry);
					slot.append(host);
				} else if (entry.host.parentElement !== slot) {
					(slot as Movable).moveBefore?.(entry.host, null);
				}
				entry.node = node;
				entry.shown = true;
				entry.usedAt = ++clock.current;
				render((n) => n + 1);
			},
			park(id) {
				const entry = entries.current.get(id);
				const lot = parking.current as Movable | null;
				if (!entry) return;
				entry.shown = false;
				if (lot?.moveBefore && entry.host.isConnected)
					lot.moveBefore(entry.host, null);
				else entries.current.delete(id);
				const parked = [...entries.current]
					.filter(([, item]) => !item.shown)
					.sort(([, a], [, b]) => b.usedAt - a.usedAt);
				for (const [key, item] of parked.slice(MAX_PARKED)) {
					entries.current.delete(key);
					item.host.remove();
				}
				render((n) => n + 1);
			},
		}),
		[],
	);

	return (
		<KeepAliveContext.Provider value={store}>
			{children}
			<div ref={parking} hidden data-keep-alive-parking />
			{[...entries.current].map(([id, entry]) =>
				createPortal(entry.node, entry.host, id),
			)}
		</KeepAliveContext.Provider>
	);
}

/**
 * Show `children` here and keep them alive under `id` after this slot
 * unmounts. A later slot with the same id picks the running content back up.
 */
export function KeepAliveSlot({
	id,
	children,
	...props
}: {
	id: string;
	children: ReactNode;
} & Omit<React.ComponentProps<"div">, "id" | "children">) {
	const store = useContext(KeepAliveContext);
	const kept = store !== null && canMove();
	const slot = useRef<HTMLDivElement>(null);
	const show = useCallback(
		(node: ReactNode) => {
			if (kept && slot.current) store.show(id, node, slot.current);
		},
		[kept, store, id],
	);
	// Every render hands the latest content to the kept piece.
	useLayoutEffect(() => {
		show(children);
	});
	useLayoutEffect(() => {
		if (!kept) return;
		return () => store.park(id);
	}, [kept, store, id]);
	return (
		<div ref={slot} {...props}>
			{kept ? null : children}
		</div>
	);
}

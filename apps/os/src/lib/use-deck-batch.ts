import { DEFAULT_DECK_ROUTING } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	useEffect,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import * as z from "zod";

const BatchSchema = z.object({
	key: z.string(),
	ids: z.array(z.string()).max(100),
	dismissed: z.array(z.string()).max(100),
});
type Batch = z.infer<typeof BatchSchema>;
const BATCH_CHANGED = "tedix:deck-batch-changed";

export function deckBatchKey(
	workspaceId: string | undefined,
	personId: string | undefined,
	projectId: string | undefined,
	windowKey: string,
) {
	return `value-v${DEFAULT_DECK_ROUTING.version}:${workspaceId ?? "preview"}:${personId}:${projectId ?? "all"}:${windowKey}`;
}

/** Badges observe the Deck's existing saved list without creating or deciding cards. */
export function useSavedDeckBatch(key: string) {
	const encoded = useSyncExternalStore(
		(listener) => {
			window.addEventListener(BATCH_CHANGED, listener);
			window.addEventListener("storage", listener);
			return () => {
				window.removeEventListener(BATCH_CHANGED, listener);
				window.removeEventListener("storage", listener);
			};
		},
		() => {
			try {
				return sessionStorage.getItem(`decision-deck:${key}`);
			} catch {
				return null;
			}
		},
		() => null,
	);
	try {
		const parsed = BatchSchema.safeParse(JSON.parse(encoded ?? "null"));
		return parsed.success && parsed.data.key === key ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Storage remembers the visit's finite list, never permission to perform an action. */
export function useDeckBatch(
	key: string,
	candidates: string[],
	capacity: number,
	ready: boolean,
) {
	const [batch, setBatch] = useState<Batch | null>(null);
	const candidateKey = JSON.stringify(candidates);
	useLayoutEffect(() => {
		setBatch((current) => {
			let savedBatch = current?.key === key ? current : null;
			if (!savedBatch) {
				try {
					const saved = BatchSchema.safeParse(
						JSON.parse(
							sessionStorage.getItem(`decision-deck:${key}`) ?? "null",
						),
					);
					if (saved.success && saved.data.key === key) savedBatch = saved.data;
				} catch {}
			}
			if (savedBatch) {
				if (!ready || savedBatch.ids.length >= capacity) return savedBatch;
				const ids = [
					...new Set([
						...savedBatch.ids,
						...(JSON.parse(candidateKey) as string[]),
					]),
				].slice(0, capacity);
				return ids.length === savedBatch.ids.length
					? savedBatch
					: { ...savedBatch, ids };
			}
			if (!ready) return null;
			return {
				key,
				ids: (JSON.parse(candidateKey) as string[]).slice(0, capacity),
				dismissed: [],
			};
		});
	}, [key, candidateKey, capacity, ready]);
	useEffect(() => {
		if (batch?.key !== key) return;
		try {
			sessionStorage.setItem(`decision-deck:${key}`, JSON.stringify(batch));
			window.dispatchEvent(new Event(BATCH_CHANGED));
		} catch {}
	}, [batch, key]);
	return {
		batch: batch?.key === key ? batch : null,
		dismiss: (id: string) =>
			setBatch((value) =>
				value?.key === key
					? { ...value, dismissed: [...new Set([...value.dismissed, id])] }
					: value,
			),
	};
}

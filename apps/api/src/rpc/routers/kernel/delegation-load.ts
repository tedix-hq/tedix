import {
	DEFAULT_DELEGATION_CONCURRENCY,
	type TediCapabilityCard,
} from "./tedi-capabilities";

/** Active delegated runs per target tedi id. */
export type DelegationLoad = ReadonlyMap<string, number>;

/**
 * Unsettled rows older than this no longer count as load. The orphan sweep
 * settles a dropped child and its Home run within minutes, so anything older
 * is a stale row, not work the tedi is carrying.
 */
export const DELEGATION_LOAD_WINDOW_MS = 6 * 60 * 60_000;

export interface DelegationCapacity {
	active: number;
	limit: number;
}

export function delegationCapacity(
	card: TediCapabilityCard,
	load: DelegationLoad,
): DelegationCapacity {
	return {
		active: load.get(card.tediId) ?? 0,
		limit: card.delegationConcurrency ?? DEFAULT_DELEGATION_CONCURRENCY,
	};
}

export function mentionsLabel(content: string, label: string): boolean {
	const words = ` ${content.toLocaleLowerCase()} `;
	const needle = label.trim().toLocaleLowerCase();
	if (needle.length < 3) return false;
	for (let from = 0; ;) {
		const index = words.indexOf(needle, from);
		if (index < 0) return false;
		const before = words[index - 1] ?? " ";
		const after = words[index + needle.length] ?? " ";
		if (!/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after))
			return true;
		from = index + needle.length;
	}
}

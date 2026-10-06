/**
 * Runtime-neutral dedup persistence contracts.
 *
 * Keep this contract free of runtime imports. Each runtime injects the durable
 * store appropriate to its own persistence boundary.
 */

export interface DedupStore {
	has(hash: string): Promise<boolean>;
	add(hash: string): Promise<void>;
	/** Optional bulk init. When present, brain-bridge calls it at startup. */
	loadAll?(): Promise<Set<string>>;
	/** Optional bulk persist after a batch. */
	flush?(): Promise<void>;
}

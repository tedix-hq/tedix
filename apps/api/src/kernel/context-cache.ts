/**
 * Kernel — per-org TTL cache for the slow-changing context-assembly inputs.
 *
 * Every Home turn re-reads the same org configuration from D1 (tedi roster,
 * apps, workflow catalogue, skill labels, policy packs, …) although it changes
 * on the order of hours. The org's `KernelDO` is one instance per org
 * (`idFromName(organizationId)`) and stays active, so a Map on its isolate is
 * the natural home for a short cache. The cache never decides WHAT is shown —
 * the same query functions fill it — only how often D1 is re-read.
 *
 * Three rules keep it safe:
 *   - A write path that changes a cached input calls
 *     {@link invalidateKernelContextCache} (routers) → `KernelDO.invalidateContextCache`
 *     → {@link KernelContextCache.invalidate}, which bumps the org's version so
 *     the next turn misses. A config change is therefore visible on the next
 *     turn, not after the TTL.
 *   - On a read failure a stale entry is served for up to {@link STALE_MAX_MS}
 *     only if no write invalidated it. Otherwise the error propagates so the
 *     caller's fail-soft fallback applies.
 *   - Nothing derived from the caller's identity or authorization is cached;
 *     callers key per-user/per-workspace rows explicitly and never cache
 *     authorized documents.
 *
 * Hits, misses and stale serves are recorded on a per-turn {@link CacheTrace}
 * that assembly stamps into `metadata.contextManifest.cache`.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { KernelDO } from "./kernel-do";

export const CONTEXT_CACHE_TTL_MS = 10 * 60_000;
/** Longest a stale entry may be served when the fresh read fails. */
export const STALE_MAX_MS = 60 * 60_000;
/** Bound for the inline (non-DO) isolate; a DO holds one org. */
const MAX_ORGS = 64;

export interface CacheTrace {
	hits: string[];
	misses: string[];
	/** Keys served from a stale entry because the fresh read failed. */
	stale: string[];
}

export function createCacheTrace(): CacheTrace {
	return { hits: [], misses: [], stale: [] };
}

interface Entry {
	value: unknown;
	fetchedAt: number;
	version: number;
	inFlight?: Promise<unknown>;
}

interface OrgEntries {
	version: number;
	entries: Map<string, Entry>;
}

export class KernelContextCache {
	private readonly orgs = new Map<string, OrgEntries>();

	constructor(
		private readonly options: {
			ttlMs?: number;
			staleMaxMs?: number;
			now?: () => number;
		} = {},
	) {}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private org(organizationId: string): OrgEntries {
		let org = this.orgs.get(organizationId);
		if (!org) {
			if (this.orgs.size >= MAX_ORGS) {
				const oldest = this.orgs.keys().next().value;
				if (oldest !== undefined) this.orgs.delete(oldest);
			}
			org = { version: 0, entries: new Map() };
			this.orgs.set(organizationId, org);
		}
		return org;
	}

	/**
	 * Resolve `key` for the org: a fresh entry resolves immediately; otherwise
	 * `fetch` runs (deduplicated across concurrent readers) and, if it fails
	 * with a stale entry still inside {@link STALE_MAX_MS}, the stale value is
	 * served instead of rethrowing.
	 */
	async read<T>(
		organizationId: string,
		key: string,
		fetch: () => Promise<T>,
		trace?: CacheTrace,
	): Promise<T> {
		const org = this.org(organizationId);
		const ttl = this.options.ttlMs ?? CONTEXT_CACHE_TTL_MS;
		const staleMax = this.options.staleMaxMs ?? STALE_MAX_MS;
		const now = this.now();
		const existing = org.entries.get(key);
		const fresh =
			existing !== undefined &&
			existing.fetchedAt > 0 &&
			existing.version === org.version &&
			now - existing.fetchedAt < ttl;
		if (fresh) {
			trace?.hits.push(key);
			return existing.value as T;
		}
		trace?.misses.push(key);
		if (existing?.inFlight && existing.version === org.version) {
			return existing.inFlight as Promise<T>;
		}
		const version = org.version;
		// Each refresh owns its entry: a pre-invalidation read must never replace
		// or clear a newer generation's value or in-flight promise.
		const entry: Entry = {
			value: existing?.version === version ? existing.value : undefined,
			fetchedAt: existing?.version === version ? existing.fetchedAt : 0,
			version,
		};
		org.entries.set(key, entry);
		entry.inFlight = (async () => {
			try {
				const value = await fetch();
				entry.value = value;
				entry.fetchedAt = this.now();
				return value;
			} catch (error) {
				if (
					entry.version === org.version &&
					entry.fetchedAt > 0 &&
					this.now() - entry.fetchedAt < staleMax
				) {
					trace?.stale.push(key);
					return entry.value as T;
				}
				throw error;
			} finally {
				entry.inFlight = undefined;
			}
		})();
		return entry.inFlight as Promise<T>;
	}

	/** Make every entry of the org miss and disallow its stale fallback. */
	invalidate(organizationId: string): void {
		const org = this.orgs.get(organizationId);
		if (org) org.version += 1;
	}

	/** Test-only: forget every org. */
	clear(): void {
		this.orgs.clear();
	}
}

const sharedCache = new KernelContextCache();

/** The isolate-wide cache the org `KernelDO` reads through. */
export function getKernelContextCache(): KernelContextCache {
	return sharedCache;
}

/**
 * Tell the org's `KernelDO` that a cached input changed. Fire-and-forget and
 * never throws: a missing binding or a failed RPC only means the change
 * becomes visible after the TTL instead of on the next turn. Routers call this
 * after the write commits; `waitUntil` keeps it alive past the response.
 */
export function invalidateKernelContextCache(
	context: {
		env: unknown;
		waitUntil?: (promise: Promise<unknown>) => void;
	},
	organizationId: string,
	reason: string,
): void {
	const kernel = (context.env as { KERNEL?: DurableObjectNamespace<KernelDO> })
		.KERNEL;
	if (!kernel || typeof kernel.idFromName !== "function") return;
	let call: Promise<void>;
	try {
		const stub = kernel.get(kernel.idFromName(organizationId));
		call = Promise.resolve(stub.invalidateContextCache(reason)).then(
			() => undefined,
		);
	} catch (error) {
		console.warn({
			component: "kernel.context",
			event: "cache_invalidation_failed",
			reason,
			exception: safeExceptionTopology(error),
		});
		return;
	}
	const settled = call.catch((error: unknown) => {
		console.warn({
			component: "kernel.context",
			event: "cache_invalidation_failed",
			reason,
			exception: safeExceptionTopology(error),
		});
	});
	if (context.waitUntil) context.waitUntil(settled);
}

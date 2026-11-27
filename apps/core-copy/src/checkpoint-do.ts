import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

/**
 * Single-object checkpoint store for the paced copy. One named instance holds
 * every checkpoint and per-table progress document as key/value pairs; the
 * copy is sequential, so one object keeps checkpoint writes strongly
 * consistent without a KV namespace id in the ops overlay.
 */
export class CheckpointDO extends DurableObject<Env> {
	async get(key: string): Promise<string | null> {
		const value = await this.ctx.storage.get(key);
		return typeof value === "string" ? value : null;
	}

	async put(key: string, value: string): Promise<void> {
		await this.ctx.storage.put(key, value);
	}

	/** Drops every checkpoint, receipt and the run state (POST /reset). */
	async clear(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

/**
 * The live in-memory store and the per-session maps that handlers mutate.
 * `resetLocalFixtures` in `../local-fixtures.ts` restores them.
 */

import type {
	ConnectionAllowedResources,
	ConnectionConsumerGrants,
} from "@tedix/api-contract/schemas/connections";
import type { RunSteeringMessage } from "@tedix/api-contract/schemas/kernel-runtime";
import type { AppRuntimeFiles } from "@tedix/api-contract/schemas/os-app-runtime";
import { fid, ORG_ID, T0 } from "./core";
import { seedState } from "./seed-state";

export let state = seedState();

export function setState(value: typeof state): void {
	state = value;
}

/**
 * Stands in for the SHA-256 the API stores with app files: 64 hex characters
 * that depend only on the files' content. Handlers here are synchronous, so
 * this is a plain string hash, not a digest.
 */
export function localFilesHash(files: AppRuntimeFiles): string {
	const text = JSON.stringify(files);
	let out = "";
	for (let seed = 0; seed < 8; seed++) {
		let hash = (0x811c9dc5 ^ seed) >>> 0;
		for (let index = 0; index < text.length; index++)
			hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
		out += hash.toString(16).padStart(8, "0");
	}
	return out;
}
/** Images stored with sample files, by `<outputId>:<reference>`. */
export const localOutputAssets = new Map<string, string>();
/** Automation drafts proposed in this session; the Versions page tests and activates them. */
export const runSteeringMessages = new Map<string, RunSteeringMessage[]>();
// Staged OAuth connect tickets: each redeems once, like the API's ticket row.
export const localConnectTickets = new Map<
	string,
	{
		appId: string;
		scope: "tenant" | "user";
		connectionInstanceId: string | null;
		redeemed: boolean;
	}
>();
export const localConnectionResourceLimits = new Map<
	string,
	ConnectionAllowedResources | null
>();
export const localConnectionConsumerGrants = new Map<
	string,
	ConnectionConsumerGrants
>();
installWorkViewFixtures();

export function installWorkViewFixtures(): void {
	for (const [index, name, entry] of [
		[0, "Projects", "portfolio"],
		[1, "Agents", "agents"],
		[2, "Office", "office"],
		[3, "Outbound", "outbound-review"],
	] as const) {
		const gadgetId = fid("49", 0x20 + index);
		const revisionId = fid("50", 0x20 + index);
		if (state.gadgets.some((gadget) => gadget.name === name)) continue;
		state.gadgets.push({
			id: gadgetId,
			organizationId: ORG_ID,
			workspaceId: state.workspaces[0]!.id,
			name,
			description: `${name} sample Work view`,
			status: "active",
			currentRevisionId: revisionId,
			sourceBlueprintRevisionId: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T0,
			updatedAt: T0,
		});
		state.gadgetRevisions.push({
			id: revisionId,
			organizationId: ORG_ID,
			gadgetId,
			revision: 1,
			manifest: {
				capabilities: [],
				entry: `tedix:app/${entry}`,
				...(index > 0 ? { config: { version: 1 } } : {}),
				navigation: { board: true },
			},
			sourceArtifactRef: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T0,
		});
	}
}

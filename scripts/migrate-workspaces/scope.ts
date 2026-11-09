/**
 * A run limited to named workspaces (`--scope org/ws,org/ws`): the data move
 * goes one customer at a time. Without a scope every workspace moves.
 */
import type { WorkspaceRef } from "./source";

export function refKey(ref: WorkspaceRef): string {
	return `${ref.organizationId}/${ref.workspaceId}`;
}

export class Scope {
	readonly keys: ReadonlySet<string>;
	readonly organizations: ReadonlySet<string>;

	constructor(refs: readonly WorkspaceRef[]) {
		if (refs.length === 0)
			throw new Error("a scope names at least one workspace");
		this.keys = new Set(refs.map(refKey));
		this.organizations = new Set(refs.map((ref) => ref.organizationId));
	}

	/** `org/ws[,org/ws...]` */
	static parse(value: string): Scope {
		return new Scope(
			value.split(",").map((entry) => {
				const [organizationId, workspaceId, ...rest] = entry.trim().split("/");
				if (!organizationId || !workspaceId || rest.length)
					throw new Error(
						`--scope takes organization/workspace pairs, not "${entry}"`,
					);
				return { organizationId, workspaceId };
			}),
		);
	}

	includes(ref: WorkspaceRef): boolean {
		return this.keys.has(refKey(ref));
	}
}

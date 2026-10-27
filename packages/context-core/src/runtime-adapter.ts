/** Canonical Tedix identity; an execution host must never mint a replacement. */
export interface RuntimeTurnScope {
	readonly orgId: string;
	readonly tediId: string;
	readonly runId: string;
	readonly sessionKey: string;
}

export interface RuntimeTurnControl {
	/** Kernel-owned admission/cancellation check. Call again before effects. */
	assertActive(): Promise<void>;
}

/**
 * Payload is a tenant-authorized projection, not the canonical state store.
 * Identity, memory, habits, responsibilities and trust history remain Tedix
 * state. Credentials and human approvals stay behind scoped parent services.
 * Adapters may retain derived execution checkpoints only in tenant-owned storage.
 */
export interface RuntimeAdapter<Input, Output> {
	readonly id: string;
	readonly scope: RuntimeTurnScope;
	execute(input: Input, control: RuntimeTurnControl): Promise<Output>;
}

/** A returned execution is not proof of tool effects or Work completion. */
export interface RuntimeAdapterReceipt extends RuntimeTurnScope {
	readonly adapterId: string;
	readonly outcome: "returned";
}

export function assertRuntimeTurnScope(
	expected: RuntimeTurnScope,
	actual: RuntimeTurnScope,
): void {
	for (const key of ["orgId", "tediId", "runId", "sessionKey"] as const) {
		if (!expected[key] || expected[key] !== actual[key])
			throw new Error(`Runtime adapter ${key} mismatch`);
	}
}

export async function executeRuntimeAdapterTurn<Input, Output>(input: {
	adapter: RuntimeAdapter<Input, Output>;
	scope: RuntimeTurnScope;
	payload: Input;
	control: RuntimeTurnControl;
}): Promise<{ output: Output; receipt: RuntimeAdapterReceipt }> {
	const scope = Object.freeze({ ...input.scope });
	const adapterId = input.adapter.id;
	assertRuntimeTurnScope(scope, input.adapter.scope);
	await input.control.assertActive();
	const output = await input.adapter.execute(input.payload, input.control);
	await input.control.assertActive();
	return {
		output,
		receipt: { ...scope, adapterId, outcome: "returned" },
	};
}

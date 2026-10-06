import {
	observationCanonical,
	observeRetainedWorkflow,
	invokeRetainedDescendantCallback,
	relayRetainedDescendantCallback,
} from "./retained-descendant-workflow-observation";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import { TediBudgetsSchema } from "@tedix/api-contract/schemas/tedi";
import { DoInferenceBudgetStore } from "./inference-budget-store-do";
import type { DoSqlRunner } from "./brain-bridge-do";
import type { PiStepReceipt } from "./pi-turn-accounting";
import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
} from "./runtime-admission-do";
import { secureEqual } from "@tedix/worker-kit/request-auth";
import {
	inspectCutoverParent,
	cutoverInventoryPageQuery,
	type CutoverInventoryPage,
	operateStoredCutover,
	passiveCutoverInspection,
	passiveRegisteredCutover,
	type PassiveRegisteredCutover,
	type PassiveCutoverInspection,
} from "./pi-cutover-admin";

/** Storage-only cutover receiver and observation port; no Agent or Pi lifecycle. */
export class RawCutoverDO extends DurableObject<Cloudflare.Env> {
	#rootObservationFacts() {
		const admission = readStoredRuntimeAdmission(
			this.ctx.storage,
			this.ctx.id.toString(),
		);
		if (
			!admission?.owner.tediId ||
			!admission.owner.orgId ||
			!["held", "quarantined", "retired"].includes(admission.state) ||
			this.ctx.storage.kv.get("cf_agents_is_facet") === true
		)
			throw new Error("retained callback custody unavailable");
		const stateRow = this.ctx.storage.sql
			.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			)
			.toArray();
		if (stateRow.length !== 1)
			throw new Error("retained callback owner unavailable");
		const state: unknown = JSON.parse(stateRow[0]!.state);
		if (!state || typeof state !== "object" || Array.isArray(state))
			throw new Error("retained callback owner unavailable");
		const owner = state as Record<string, unknown>;
		if (
			owner.tediId !== admission.owner.tediId ||
			owner.orgId !== admission.owner.orgId
		)
			throw new Error("retained callback owner changed");
		if (owner.aigMetadata !== undefined && owner.aigMetadata !== null) {
			const metadata = z
				.object({ tediId: z.string().optional(), orgId: z.string().optional() })
				.parse(owner.aigMetadata);
			if (
				(metadata.tediId !== undefined && metadata.tediId !== owner.tediId) ||
				(metadata.orgId !== undefined && metadata.orgId !== owner.orgId)
			)
				throw new Error("retained callback owner changed");
		}
		const storedName = this.ctx.storage.kv.get("__ps_name"),
			name = this.ctx.id.name ?? storedName;
		if (
			typeof name !== "string" ||
			!name ||
			(storedName !== undefined && storedName !== name)
		)
			throw new Error("retained callback name unavailable");
		return { admission, state: stateRow[0]!.state, name };
	}
	async #verifyObservationRoot(recheck: () => void, pin?: { name?: string }) {
		const facts = this.#rootObservationFacts();
		const { resolveTediRuntimeIdentity } =
			await import("@tedix/db/queries/tedi-runtime-bootstrap");
		recheck();
		const owner = await resolveTediRuntimeIdentity(
			this.env.DB,
			facts.admission.owner.tediId!,
			true,
		);
		recheck();
		const canonical = await resolveTediRuntimeIdentity(
			this.env.DB,
			facts.admission.owner.tediId!,
			true,
		);
		recheck();
		if (pin) {
			if (pin.name !== undefined && canonical?.isolateAgentId !== pin.name)
				throw new Error("retained callback canonical custody changed");
			if (
				typeof canonical?.isolateAgentId !== "string" ||
				!canonical.isolateAgentId
			)
				throw new Error("retained callback canonical custody changed");
			pin.name ??= canonical.isolateAgentId;
		}
		if (
			owner?.id !== facts.admission.owner.tediId ||
			owner.orgId !== facts.admission.owner.orgId ||
			canonical?.id !== facts.admission.owner.tediId ||
			canonical.orgId !== facts.admission.owner.orgId ||
			this.env.TEDI_AGENT.idFromName(facts.name).toString() !==
				this.ctx.id.toString()
		)
			throw new Error("retained callback canonical custody changed");
		if (canonical.isolateAgentId !== facts.name) {
			const { verifyRetainedRootCustody } =
				await import("./retained-root-custody");
			recheck();
			await verifyRetainedRootCustody(
				this.env,
				{
					tediId: facts.admission.owner.tediId!,
					orgId: facts.admission.owner.orgId!,
					objectId: this.ctx.id.toString(),
					objectName: facts.name,
					generation: facts.admission.generation,
					currentName: canonical.isolateAgentId!,
				},
				recheck,
				this.ctx.storage,
			);
		}
	}
	async #observationOnly<T>(operation: () => Promise<T>): Promise<T> {
		const outcome = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				return { ok: true as const, value: await operation() };
			} catch {
				return { ok: false as const };
			}
		});
		if (!outcome.ok) throw new Error("Retained workflow observation rejected");
		return outcome.value;
	}
	/** Pinned Agents getAgentByName calls this RPC; it must not start a lifecycle. */
	async __unsafe_ensureInitialized(props?: unknown): Promise<void> {
		return this.#observationOnly(async () => {
			if (props !== undefined)
				throw new Error("retained callback props denied");
			const captured = observationCanonical(this.#rootObservationFacts());
			const recheck = () => {
				if (observationCanonical(this.#rootObservationFacts()) !== captured)
					throw new Error("retained callback epoch changed");
			};
			await this.#verifyObservationRoot(recheck);
			recheck();
		});
	}
	/** Private unqualified observation; never calls the SDK callback handler. */
	async _workflow_handleCallback(input: unknown): Promise<void> {
		const pin: { name?: string } = {};
		return this.#observationOnly(() =>
			observeRetainedWorkflow(this.ctx, this.env, input, {
				facts: () => this.#rootObservationFacts(),
				verify: (recheck) => this.#verifyObservationRoot(recheck, pin),
			}),
		);
	}
	/** Pinned SDK facet-origin port. The method whitelist is enforced before traversal. */
	async _cf_invokeAgentPath(
		path: unknown,
		method: unknown,
		args: unknown,
	): Promise<void> {
		return this.#observationOnly(() =>
			invokeRetainedDescendantCallback(this.ctx, this.env, path, method, args),
		);
	}
	/** Authenticated internal receipt relay; actual Raw class identity supplies the receiver marker. */
	async _retainedDescendantWorkflowObservation(input: unknown): Promise<void> {
		return this.#observationOnly(() =>
			relayRetainedDescendantCallback(this.ctx, this.env, input),
		);
	}
	async #snapshot(page: CutoverInventoryPage) {
		return inspectCutoverParent(
			this.ctx.storage,
			this.ctx.id.toString(),
			page,
			undefined,
			"raw-cutover-v1",
		);
	}
	async inventory(
		token: string,
		page: CutoverInventoryPage = { offset: 0, limit: 200 },
	) {
		if (!(await secureEqual(token, this.env.SECRETS_MASTER_KEY)))
			throw new Error("Cutover inventory unauthorized");
		const parsedPage = cutoverInventoryPageQuery(
			new URLSearchParams({
				offset: String(page.offset),
				limit: String(page.limit),
				...(page.expectedInspectionHash === undefined
					? {}
					: { expectedInspectionHash: page.expectedInspectionHash }),
				...(page.expectedHash === undefined
					? {}
					: { expectedHash: page.expectedHash }),
			}),
		);
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				return { value: await this.#snapshot(parsedPage) };
			} catch (error) {
				return { error };
			}
		});
		if ("error" in result) throw result.error;
		return result.value;
	}
	/** Reconcile incurred usage for an immutable original claim; never reserve or dispatch. */
	async recordPiStep(input: PiStepReceipt) {
		const outcome = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				const admission = readStoredRuntimeAdmission(
					this.ctx.storage,
					this.ctx.id.toString(),
				);
				if (!admission?.owner.tediId || !admission.owner.orgId)
					throw new Error("Original receipt custody unavailable");
				const row = this.ctx.storage.sql
					.exec<{ state: string }>(
						"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
					)
					.toArray()[0];
				const stored: unknown = row ? JSON.parse(row.state) : null;
				if (!stored || typeof stored !== "object" || Array.isArray(stored))
					throw new Error("Stored receipt custody unavailable");
				const state = stored as Record<string, unknown>;
				if (
					state.tediId !== admission.owner.tediId ||
					state.orgId !== admission.owner.orgId ||
					this.ctx.storage.kv.get("cf_agents_is_facet") === true
				)
					throw new Error("Original root receipt custody mismatch");
				const helper = new RuntimeAdmissionDO(
					this.ctx.storage,
					admission.owner,
				);
				await helper.assertOriginalClaim({ runId: input.runId });
				const limits = TediBudgetsSchema.parse(state.budgets ?? {});
				const runner: DoSqlRunner = {
					sql: <T>(
						strings: TemplateStringsArray,
						...values: (string | number | boolean | null)[]
					) =>
						this.ctx.storage.sql
							.exec(
								strings.join("?"),
								...values.map((value) =>
									typeof value === "boolean" ? Number(value) : value,
								),
							)
							.toArray() as T[],
				};
				return {
					ok: true as const,
					value: new DoInferenceBudgetStore(runner).recordStep(
						input.runId,
						input.stepId,
						input.actualTokens,
						limits,
					),
				};
			} catch (error) {
				return { ok: false as const, error };
			}
		});
		if (!outcome.ok) throw new Error("Original inference receipt rejected");
		return outcome.value;
	}
	async inspectStoredCutover(input: PassiveCutoverInspection) {
		return passiveCutoverInspection(
			this.ctx,
			this.env,
			input,
			"raw-cutover-v1",
		);
	}
	async operateRegisteredStoredCutover(input: PassiveRegisteredCutover) {
		return passiveRegisteredCutover(this.ctx, this.env, input);
	}

	async fetch(request: Request): Promise<Response> {
		return operateStoredCutover({
			ctx: this.ctx,
			env: this.env,
			request,
			receiver: "raw-cutover-v1",
		});
	}
}

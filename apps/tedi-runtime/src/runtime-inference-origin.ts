/** Private source assertions, never capabilities, billing metadata or provider attestation. */
import { createHash } from "node:crypto";
import {
	assertProviderDispatchReady,
	type ProviderBeforeDispatch,
} from "@tedix/workers-ai/gateway-transport";
import type { AdmissionOwner } from "./runtime-admission";
import type { AcceptedRuntimeTurn } from "./runtime-admission-do";

export interface NativeOriginPathHop {
	className: string;
	name: string;
}
export interface NativeRootOrigin {
	generation: number;
	owner: AdmissionOwner;
	objectName: string;
	className: "AgentTediDO";
	path: [];
}
export interface NativeSelectedOrigin {
	generation: number;
	owner: AdmissionOwner;
	className: string;
	identityName: string;
	facetName: string | null;
	path: NativeOriginPathHop[];
}
export type RuntimeInferenceOrigin =
	| {
			kind: "accepted_native";
			root: NativeRootOrigin & { accepted: AcceptedRuntimeTurn };
			selected: NativeSelectedOrigin & { accepted: AcceptedRuntimeTurn };
			operation: {
				parentRunId: string;
				operationId: string;
				sessionKey: string;
				parentGeneration: number;
			} | null;
			configurationHash: string | null;
	  }
	| {
			kind: "unselected_native";
			root: NativeRootOrigin;
			selected: NativeSelectedOrigin;
			configurationHash: string;
	  };
export type NativeRootProof = NativeRootOrigin & {
	accepted?: AcceptedRuntimeTurn;
};
const captures = new WeakMap<ProviderBeforeDispatch, RuntimeInferenceOrigin>();
const logicalSendBefore = new WeakMap<ProviderBeforeDispatch, number>();
const LOGICAL_SEND_WINDOW_MS = 10 * 60 * 1000;
export function inferenceOriginHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function equal(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function acceptedIdentity(
	owner: AdmissionOwner,
	accepted: AcceptedRuntimeTurn,
): void {
	if (
		owner.orgId !== accepted.owner.orgId ||
		owner.tediId !== accepted.owner.tediId ||
		owner.objectId !== accepted.owner.objectId ||
		!Number.isSafeInteger(accepted.generation) ||
		accepted.generation < 1 ||
		!accepted.runId ||
		!accepted.sessionKey ||
		!accepted.principalId ||
		!/^[a-f0-9]{64}$/.test(accepted.inputHash) ||
		!/^[a-f0-9]{64}$/.test(accepted.requestHash)
	)
		throw new Error("Private inference accepted identity invalid");
}
/** Full source input is checked locally; the assertion retains only its original hash. */
export function privateInferenceOriginGuard(
	origin: RuntimeInferenceOrigin,
	recheck: ProviderBeforeDispatch,
	selectedFullInput?: string,
): ProviderBeforeDispatch {
	const captured = structuredClone(origin);
	if (
		!captured.root.owner.orgId ||
		!captured.root.owner.tediId ||
		!/^[a-f0-9]{64}$/.test(captured.root.owner.objectId) ||
		!captured.root.objectName ||
		captured.root.path.length ||
		captured.root.className !== "AgentTediDO" ||
		captured.selected.owner.orgId !== captured.root.owner.orgId ||
		captured.selected.owner.tediId !== captured.root.owner.tediId ||
		!/^[a-f0-9]{64}$/.test(captured.selected.owner.objectId) ||
		!captured.selected.identityName ||
		!captured.selected.className
	)
		throw new Error("Private inference native custody invalid");
	const leafClasses = [
		"ConversationFacet",
		"JudgeSessionFacet",
		"SynthesisSessionFacet",
	];
	if (captured.selected.className === "AgentTediDO") {
		if (
			captured.selected.facetName !== null ||
			captured.selected.path.length ||
			captured.selected.identityName !== captured.root.objectName ||
			captured.selected.owner.objectId !== captured.root.owner.objectId
		)
			throw new Error("Private inference root custody changed");
	} else {
		const hop = captured.selected.path.at(-1);
		if (
			captured.selected.owner.objectId === captured.root.owner.objectId ||
			!leafClasses.includes(captured.selected.className) ||
			!captured.selected.facetName ||
			!hop ||
			hop.className !== captured.selected.className ||
			hop.name !== captured.selected.facetName
		)
			throw new Error("Private inference leaf custody changed");
	}
	if (captured.kind === "accepted_native") {
		if (
			captured.configurationHash !== null &&
			!/^[a-f0-9]{64}$/.test(captured.configurationHash)
		)
			throw new Error("Private inference configuration hash invalid");
		acceptedIdentity(captured.root.owner, captured.root.accepted);
		if (
			captured.root.generation !== captured.root.accepted.generation ||
			captured.selected.generation !== captured.selected.accepted.generation
		)
			throw new Error("Private inference generation changed");
		acceptedIdentity(captured.selected.owner, captured.selected.accepted);
		if (
			selectedFullInput === undefined ||
			createHash("sha256").update(selectedFullInput).digest("hex") !==
				captured.selected.accepted.inputHash
		)
			throw new Error("Private inference original full input changed");
		if (
			captured.root.accepted.sessionKey !==
				captured.selected.accepted.sessionKey ||
			captured.root.accepted.principalId !==
				captured.selected.accepted.principalId
		)
			throw new Error("Private inference original principal/session changed");
		if (captured.operation) {
			const operation = captured.operation;
			const hop = captured.selected.path.at(-1);
			if (
				!hop ||
				hop.className !== captured.selected.className ||
				hop.name !== captured.selected.facetName
			)
				throw new Error("Private inference native path changed");
			if (
				operation.parentRunId !== captured.root.accepted.runId ||
				operation.operationId !== captured.selected.accepted.runId ||
				operation.sessionKey !== captured.selected.accepted.sessionKey ||
				operation.sessionKey !== captured.root.accepted.sessionKey ||
				operation.parentGeneration !== captured.root.accepted.generation ||
				captured.selected.facetName === null ||
				!captured.selected.path.length
			)
				throw new Error("Private inference original operation changed");
		} else if (
			!equal(captured.root.accepted, captured.selected.accepted) ||
			captured.root.owner.objectId !== captured.selected.owner.objectId ||
			captured.selected.facetName !== null ||
			captured.selected.path.length
		)
			throw new Error("Private inference root-only claim changed");
	} else if (
		captured.root.generation !== 0 ||
		captured.selected.generation !== 0 ||
		!/^[a-f0-9]{64}$/.test(captured.configurationHash) ||
		Object.hasOwn(captured.root, "accepted") ||
		Object.hasOwn(captured.selected, "accepted") ||
		Object.hasOwn(captured, "operation")
	)
		throw new Error("Unselected inference cannot assert an accepted claim");
	const guard: ProviderBeforeDispatch = () => {
		assertProviderDispatchReady(recheck);
	};
	captures.set(guard, captured);
	logicalSendBefore.set(guard, Date.now() + LOGICAL_SEND_WINDOW_MS);
	return guard;
}
/** Copies expose only asserted identity and hashes, not private full input or live authority. */
export function readPrivateInferenceOrigin(
	guard: ProviderBeforeDispatch | undefined,
): RuntimeInferenceOrigin | null {
	const origin = guard && captures.get(guard);
	return origin ? structuredClone(origin) : null;
}
/** One request owns one immutable assertion; no factory-wide latest receipt or global turn. */
export function requestInferenceOriginGuard(
	guard: ProviderBeforeDispatch | undefined,
): ProviderBeforeDispatch {
	const origin = guard && captures.get(guard);
	if (!guard || !origin)
		throw new Error("Paid inference requires private native origin capture");
	const sendBefore = logicalSendBefore.get(guard);
	if (sendBefore === undefined)
		throw new Error("Private inference logical deadline absent");
	const own: ProviderBeforeDispatch = () => {
		assertProviderDispatchReady(guard);
		if (Date.now() >= sendBefore)
			throw new Error("Private inference logical send deadline expired");
	};
	captures.set(own, structuredClone(origin));
	logicalSendBefore.set(own, sendBefore);
	assertProviderDispatchReady(own);
	return own;
}
/** This request's original API window can only narrow the private logical window. */
export function admittedInferenceDispatchGuard(
	guard: ProviderBeforeDispatch,
	apiSendBefore: string,
	signal?: AbortSignal | null,
): ProviderBeforeDispatch {
	const logical = logicalSendBefore.get(guard);
	const api = Date.parse(apiSendBefore);
	if (logical === undefined || !Number.isFinite(api))
		throw new Error("Inference dispatch window invalid");
	const sendBefore = Math.min(logical, api);
	return () => {
		assertProviderDispatchReady(guard);
		signal?.throwIfAborted();
		if (Date.now() >= sendBefore)
			throw new Error("Execution admission expired before send");
	};
}

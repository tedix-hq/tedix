import { strict as assert } from "node:assert";
import {
	cancelWorkstationProcess,
	cancelWorkstationProcessAdapter,
	execWorkstation,
	execWorkstationAdapter,
	platformDomainForTediEnv,
	readWorkstationProcess,
	readWorkstationProcessAdapter,
	readWorkstationStatus,
	readWorkstationStatusAdapter,
	reconcileWorkstation,
	releaseWorkstation,
	releaseWorkstationAdapter,
	requestWorkstation,
	requestWorkstationAdapter,
	startWorkstationProcess,
	startWorkstationProcessAdapter,
	tediHostForSlug,
	operateComputerFiles,
} from "./workstation";

import {
	createWorkstationSnapshot,
	createWorkstationLease,
} from "@tedix/api-contract/schemas/workstation";

// The current /provision route returns the persisted server envelope with 202.
function canonicalProvision(input: Record<string, unknown> = {}) {
	const seats = [
		{
			permissionScopes: [],
			role: "lead" as const,
			slug: "cto",
			tediId: "tedi-1",
		},
	];
	const workstation = createWorkstationSnapshot({
		organizationId: "org-1",
		profileId: "general",
		seats,
		status: "provisioning",
		workstationId: "ws_server_issued",
	});
	const workstationLease = createWorkstationLease({
		organizationId: "org-1",
		profileId: "general",
		seats,
		workstationId: workstation.id,
		leaseId: "wl_server_issued",
		createdAt: "2026-09-18T00:00:00.000Z",
		status: "provisioning",
		kernelRunId:
			typeof input.kernelRunId === "string" ? input.kernelRunId : null,
		workItemId: typeof input.workItemId === "string" ? input.workItemId : null,
		metadata: {
			executionId:
				typeof input.executionId === "string" ? input.executionId : null,
		},
	});
	return {
		accepted: true,
		ok: true,
		ready: false,
		status: "provisioning",
		workstation,
		workstationLease,
		workstationPersistence: { status: "persisted" },
	};
}

assert.equal(platformDomainForTediEnv("production"), "tedix.dev");
// staging is retired: any non-production env resolves to the dev domain.
assert.equal(platformDomainForTediEnv("staging"), "tedix.tech");
assert.equal(platformDomainForTediEnv("development"), "tedix.tech");
assert.equal(tediHostForSlug("cto", "production"), "cto.tedi.tedix.dev");

let seenRequest: Request | undefined;
const env = {
	ENVIRONMENT: "production",
	TEDI_SERVICE: {
		fetch: async (request: Request) => {
			seenRequest = request;
			return Response.json({ ok: true, ready: true });
		},
	} as unknown as Fetcher,
};

const response = await requestWorkstationAdapter(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ reason: "need repo shell" },
	{ timeoutMs: 1_000 },
);

assert.deepEqual(response, { ok: true, ready: true });
assert.ok(seenRequest);
const request = seenRequest;
assert.equal(request.method, "POST");
assert.equal(request.url, "https://tedi/api/admin/workstation/provision");
assert.equal(request.headers.get("X-Service-Binding"), "true");
assert.equal(request.headers.get("X-Tedix-Workstation"), "true");
assert.equal(request.headers.get("X-Tedix-Host"), "cto.tedi.tedix.dev");
assert.equal(request.headers.get("X-Tedix-Tedi-Id"), "tedi-1");
assert.equal(request.headers.get("X-Tedix-Org-Id"), "org-1");
assert.deepEqual(await request.json(), { reason: "need repo shell" });

seenRequest = undefined;
assert.deepEqual(
	await releaseWorkstation(
		env,
		{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
		{
			leaseId: "lease-task-1",
			cwd: "/home/tedi/workstation/repo",
			preserveChanges: true,
			reason: "proof complete",
			traceId: "trace-release-1",
			workstationId: "workstation-task-1",
		},
	),
	{ ok: true, ready: true },
);
assert.ok(seenRequest);
const releaseRequest = seenRequest as Request;
assert.equal(releaseRequest.url, "https://tedi/api/admin/workstation/release");
assert.deepEqual(await releaseRequest.json(), {
	leaseId: "lease-task-1",
	cwd: "/home/tedi/workstation/repo",
	preserveChanges: true,
	reason: "proof complete",
	traceId: "trace-release-1",
	workstationId: "workstation-task-1",
});
assert.equal(typeof releaseWorkstationAdapter, "function");

seenRequest = undefined;
const statusResponse = (await readWorkstationStatus(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		leaseId: "lease-task-1",
		workstationId: "workstation-task-1",
	},
)) as Record<string, unknown>;
assert.equal(statusResponse.ok, true);
assert.equal(statusResponse.leaseId, "lease-task-1");
assert.equal(statusResponse.workstationId, "workstation-task-1");
assert.ok(seenRequest);
const statusRequest = seenRequest as Request;
assert.equal(statusRequest.url, "https://tedi/api/admin/workstation/status");
assert.deepEqual(await statusRequest.json(), {
	leaseId: "lease-task-1",
	workstationId: "workstation-task-1",
});
assert.equal(typeof readWorkstationStatusAdapter, "function");

seenRequest = undefined;
await reconcileWorkstation(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		leaseId: "lease-task-1",
		workstationId: "workstation-task-1",
	},
);
assert.ok(seenRequest);
const reconcileRequest = seenRequest as Request;
assert.equal(reconcileRequest.url, "https://tedi/api/admin/workstation/wake");
assert.deepEqual(await reconcileRequest.json(), {
	leaseId: "lease-task-1",
	workstationId: "workstation-task-1",
});

const provisionEnv = {
	...env,
	TEDI_SERVICE: {
		fetch: async (request: Request) => {
			seenRequest = request;
			return Response.json(canonicalProvision(await request.clone().json()), {
				status: 202,
			});
		},
	} as unknown as Fetcher,
};

const workstationResponse = (await requestWorkstation(
	provisionEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		executionId: "execution-1",
		kernelRunId: "kernel-run-1",
		objective: "change code in the Tedix repo",
		profileId: "general",
		reason: "need repo shell",
		requiredCapabilities: ["repo", "shell", "git"],
	},
	{ timeoutMs: 1_000 },
)) as Record<string, unknown>;

assert.equal(workstationResponse.ok, true);
assert.equal(workstationResponse.profileId, "general");
assert.ok(workstationResponse.workstationLease);
assert.equal(
	workstationResponse.workstationId,
	(workstationResponse.workstation as Record<string, unknown>).id,
);
assert.equal(
	workstationResponse.leaseId,
	(workstationResponse.workstationLease as Record<string, unknown>).id,
);
assert.equal(
	(workstationResponse.workstationLease as Record<string, unknown>).kernelRunId,
	"kernel-run-1",
);
assert.ok(seenRequest);
const workstationRequest = seenRequest as Request;
assert.equal(
	workstationRequest.url,
	"https://tedi/api/admin/workstation/provision",
);
assert.deepEqual(await workstationRequest.json(), {
	executionId: "execution-1",
	kernelRunId: "kernel-run-1",
	reason: "need repo shell",
});

seenRequest = undefined;
const probeWorkstationResponse = (await requestWorkstation(
	provisionEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		kernelRunId: "kernel-run-probe",
		reason: "prove bootstrap readiness",
		setupPlan: [
			{
				kind: "bootstrap_readiness_probe",
				cwd: "/home/tedi/workstation/bootstrap-proof/fixture",
			},
		],
	},
	{ timeoutMs: 1_000 },
)) as Record<string, unknown>;

assert.equal(probeWorkstationResponse.ok, true);
assert.ok(seenRequest);
const probeWorkstationRequest = seenRequest as Request;
assert.deepEqual(await probeWorkstationRequest.json(), {
	kernelRunId: "kernel-run-probe",
	reason: "prove bootstrap readiness",
	setupPlan: [
		{
			kind: "bootstrap_readiness_probe",
			cwd: "/home/tedi/workstation/bootstrap-proof/fixture",
		},
	],
});

seenRequest = undefined;
const defaultWorkstation = (await requestWorkstation(
	provisionEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		kernelRunId: "kernel-run-default",
		objective: "inspect the checked out repo",
	},
	{ timeoutMs: 1_000 },
)) as Record<string, unknown>;

assert.equal(defaultWorkstation.ok, true);
assert.equal(defaultWorkstation.profileId, "general");
assert.ok(defaultWorkstation.workstationLease);
assert.equal(
	(defaultWorkstation.workstationLease as Record<string, unknown>).kernelRunId,
	"kernel-run-default",
);
assert.ok(seenRequest);
const defaultWorkstationRequest = seenRequest as Request;
assert.equal(
	defaultWorkstationRequest.url,
	"https://tedi/api/admin/workstation/provision",
);
assert.deepEqual(await defaultWorkstationRequest.json(), {
	kernelRunId: "kernel-run-default",
	reason: "inspect the checked out repo",
});

const timeoutEnv = {
	ENVIRONMENT: "production",
	TEDI_SERVICE: {
		fetch: async (request: Request) =>
			new Promise<Response>((_, reject) => {
				request.signal.addEventListener("abort", () =>
					reject(new DOMException("Aborted", "AbortError")),
				);
			}),
	} as unknown as Fetcher,
};

const timedOutWorkstation = (await requestWorkstation(
	timeoutEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		kernelRunId: "kernel-run-timeout",
		objective: "prove bounded wake timeout evidence",
		timeoutMs: 1,
	},
)) as Record<string, unknown>;

assert.equal(timedOutWorkstation.ok, false);
assert.equal(timedOutWorkstation.ready, false);
assert.equal(
	timedOutWorkstation.error,
	"workstation provision timed out after 1ms",
);
assert.deepEqual(timedOutWorkstation.readiness, {
	toolsReady: false,
	secretsReady: false,
	repoReady: false,
	depsReady: false,
});
assert.equal(
	(timedOutWorkstation.bootstrap as Record<string, unknown>).installStatus,
	"blocked",
);
assert.equal(
	(timedOutWorkstation.bootstrap as Record<string, unknown>).nextAction,
	"open_computer",
);
assert.equal(timedOutWorkstation.workstation, undefined);
assert.equal(timedOutWorkstation.workstationLease, undefined);
assert.equal(timedOutWorkstation.leaseId, undefined);
assert.equal(timedOutWorkstation.workstationId, undefined);

const execResponse = await execWorkstationAdapter(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		command: "gh repo view",
		cwd: "/home/tedi/workstation/repos/tedix-hq/tedix",
		operationLock: "branch_push",
		timeoutMs: 30_000,
	},
);

assert.deepEqual(execResponse, { ok: true, ready: true });
assert.ok(seenRequest);
const execRequest = seenRequest as Request;
assert.equal(execRequest.url, "https://tedi/api/admin/workstation/exec");
assert.deepEqual(await execRequest.json(), {
	command: "gh repo view",
	cwd: "/home/tedi/workstation/repos/tedix-hq/tedix",
	operationLock: "branch_push",
	timeoutMs: 30_000,
});

const workstationExecResponse = (await execWorkstation(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		command: "git status --short",
		leaseId: "lease-shared",
		operationLock: "branch_push",
		participantId: "participant-devops",
		profileId: "general",
		sessionId: "session-shell-1",
		sessionKind: "shell",
		timeoutMs: 30_000,
		workstationId: "workstation-shared",
	},
)) as Record<string, unknown>;

assert.equal(workstationExecResponse.ok, true);
assert.equal(workstationExecResponse.profileId, "general");
assert.ok(seenRequest);
const workstationExecRequest = seenRequest as Request;
assert.equal(
	workstationExecRequest.url,
	"https://tedi/api/admin/workstation/exec",
);
assert.deepEqual(await workstationExecRequest.json(), {
	command: "git status --short",
	leaseId: "lease-shared",
	operationLock: "branch_push",
	participantId: "participant-devops",
	sessionId: "session-shell-1",
	sessionKind: "shell",
	timeoutMs: 30_000,
	workstationId: "workstation-shared",
});

const processStartResponse = await startWorkstationProcessAdapter(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		command: "bun install --frozen-lockfile",
		cwd: "/home/tedi/workstation/repos/tedix-hq/tedix",
		operationLock: "package_install",
		processId: "install-deps",
		timeoutMs: 90_000,
	},
);

assert.deepEqual(processStartResponse, { ok: true, ready: true });
assert.ok(seenRequest);
const processStartRequest = seenRequest as Request;
assert.equal(
	processStartRequest.url,
	"https://tedi/api/admin/workstation/process/start",
);
assert.deepEqual(await processStartRequest.json(), {
	command: "bun install --frozen-lockfile",
	cwd: "/home/tedi/workstation/repos/tedix-hq/tedix",
	operationLock: "package_install",
	processId: "install-deps",
	timeoutMs: 90_000,
});

const workstationProcessStartResponse = (await startWorkstationProcess(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		command: "bun run test:run",
		kind: "tests",
		kernelRunId: "kernel-run-1",
		leaseId: "lease-shared",
		operationLock: "package_install",
		participantId: "participant-devops",
		profileId: "general",
		processId: "test-run",
		sessionId: "session-test-1",
		sessionKind: "test-runner",
		timeoutMs: 90_000,
		traceBundleId: "trace-bundle-1",
		traceId: "trace-1",
		workItemId: "work-item-1",
		workstationId: "workstation-shared",
	},
)) as Record<string, unknown>;

assert.equal(workstationProcessStartResponse.ok, true);
assert.equal(workstationProcessStartResponse.profileId, "general");
assert.ok(seenRequest);
const workstationProcessStartRequest = seenRequest as Request;
assert.equal(
	workstationProcessStartRequest.url,
	"https://tedi/api/admin/workstation/process/start",
);
assert.equal(
	workstationProcessStartRequest.headers.get("X-Trace-Id"),
	"trace-1",
);
assert.deepEqual(await workstationProcessStartRequest.json(), {
	command: "bun run test:run",
	kind: "tests",
	kernelRunId: "kernel-run-1",
	leaseId: "lease-shared",
	operationLock: "package_install",
	participantId: "participant-devops",
	processId: "test-run",
	sessionId: "session-test-1",
	sessionKind: "test-runner",
	timeoutMs: 90_000,
	traceBundleId: "trace-bundle-1",
	traceId: "trace-1",
	workItemId: "work-item-1",
	workstationId: "workstation-shared",
});
assert.equal(
	workstationProcessStartRequest.headers.get(
		"X-Tedix-Workstation-Conversation-Id",
	),
	null,
	"an ordinary process start has no conversation claim",
);

await startWorkstationProcess(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ command: "printf child", kernelRunId: "child-run" },
	{
		conversationProvenance: {
			conversationId: "cto:home-child",
			runId: "child-run",
		},
	},
);
assert.ok(seenRequest);
const boundProcessStartRequest = seenRequest as Request;
assert.equal(
	boundProcessStartRequest.headers.get("X-Tedix-Workstation-Conversation-Id"),
	"cto:home-child",
);
assert.equal(
	boundProcessStartRequest.headers.get("X-Tedix-Workstation-Run-Id"),
	"child-run",
);
assert.equal(
	((await boundProcessStartRequest.json()) as { conversationId?: string })
		.conversationId,
	undefined,
	"the provenance claim must not enter the public request body",
);

const processReadResponse = await readWorkstationProcessAdapter(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ processId: "test-run", tailBytes: 4096 },
);

assert.deepEqual(processReadResponse, { ok: true, ready: true });
assert.ok(seenRequest);
const processReadRequest = seenRequest as Request;
assert.equal(
	processReadRequest.url,
	"https://tedi/api/admin/workstation/process/status",
);
assert.deepEqual(await processReadRequest.json(), {
	processId: "test-run",
	tailBytes: 4096,
});

const workstationProcessReadResponse = (await readWorkstationProcess(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		kernelRunId: "kernel-run-1",
		leaseId: "lease-shared",
		participantId: "participant-devops",
		processId: "test-run",
		profileId: "general",
		sessionId: "session-test-1",
		sessionKind: "test-runner",
		tailBytes: 8192,
		traceBundleId: "trace-bundle-1",
		traceId: "trace-1",
		workItemId: "work-item-1",
		workstationId: "workstation-shared",
	},
)) as Record<string, unknown>;

assert.equal(workstationProcessReadResponse.ok, true);
assert.equal(workstationProcessReadResponse.profileId, "general");
assert.ok(seenRequest);
const workstationProcessReadRequest = seenRequest as Request;
assert.equal(
	workstationProcessReadRequest.url,
	"https://tedi/api/admin/workstation/process/status",
);
assert.equal(
	workstationProcessReadRequest.headers.get("X-Trace-Id"),
	"trace-1",
);
assert.deepEqual(await workstationProcessReadRequest.json(), {
	kernelRunId: "kernel-run-1",
	leaseId: "lease-shared",
	participantId: "participant-devops",
	processId: "test-run",
	sessionId: "session-test-1",
	sessionKind: "test-runner",
	tailBytes: 8192,
	traceBundleId: "trace-bundle-1",
	traceId: "trace-1",
	workItemId: "work-item-1",
	workstationId: "workstation-shared",
});

const processCancelResponse = await cancelWorkstationProcessAdapter(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ processId: "test-run" },
);

assert.deepEqual(processCancelResponse, { ok: true, ready: true });
assert.ok(seenRequest);
const processCancelRequest = seenRequest as Request;
assert.equal(
	processCancelRequest.url,
	"https://tedi/api/admin/workstation/process/cancel",
);
assert.deepEqual(await processCancelRequest.json(), {
	processId: "test-run",
});

const workstationProcessCancelResponse = (await cancelWorkstationProcess(
	env,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		kernelRunId: "kernel-run-1",
		leaseId: "lease-shared",
		participantId: "participant-devops",
		processId: "test-run",
		profileId: "general",
		sessionId: "session-test-1",
		sessionKind: "test-runner",
		traceBundleId: "trace-bundle-1",
		traceId: "trace-1",
		workItemId: "work-item-1",
		workstationId: "workstation-shared",
	},
)) as Record<string, unknown>;

assert.equal(workstationProcessCancelResponse.ok, true);
assert.equal(workstationProcessCancelResponse.profileId, "general");
assert.ok(seenRequest);
const workstationProcessCancelRequest = seenRequest as Request;
assert.equal(
	workstationProcessCancelRequest.url,
	"https://tedi/api/admin/workstation/process/cancel",
);
assert.equal(
	workstationProcessCancelRequest.headers.get("X-Trace-Id"),
	"trace-1",
);
assert.deepEqual(await workstationProcessCancelRequest.json(), {
	kernelRunId: "kernel-run-1",
	leaseId: "lease-shared",
	participantId: "participant-devops",
	processId: "test-run",
	sessionId: "session-test-1",
	sessionKind: "test-runner",
	traceBundleId: "trace-bundle-1",
	traceId: "trace-1",
	workItemId: "work-item-1",
	workstationId: "workstation-shared",
});

// Requested seats cannot fabricate additional server-issued participants.
// Joining participants is the separate canonical join_workstation operation.
seenRequest = undefined;
const multiSeatWorkstation = (await requestWorkstation(
	provisionEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{
		kernelRunId: "kernel-run-multi",
		objective: "pair CTO and DevOps on the repo",
		seats: [
			{ tediId: "tedi-2", role: "specialist", slug: "devops" },
			// Re-declaring the lead is a no-op (deduped on tediId).
			{ tediId: "tedi-1", role: "collaborator", slug: "cto" },
		],
	},
	{ timeoutMs: 1_000 },
)) as Record<string, unknown>;

const multiSeatLease = multiSeatWorkstation.workstationLease as {
	participants: Array<{ tediId: string; role: string; slug?: string }>;
};
assert.equal(multiSeatLease.participants.length, 1);
assert.deepEqual(
	multiSeatLease.participants.map((p) => p.tediId),
	["tedi-1"],
);
assert.equal(multiSeatLease.participants[0]?.role, "lead");
assert.deepEqual(
	multiSeatLease,
	canonicalProvision({ kernelRunId: "kernel-run-multi" }).workstationLease,
);

assert.deepEqual(
	await requestWorkstationAdapter(
		{ ENVIRONMENT: "production" },
		{ slug: "cto", tediId: "tedi-1" },
	),
	{ ok: false, error: "TEDI_SERVICE binding is not configured" },
);

// --- Sync exec output ergonomics: tail truncation + annotations -------------
// The model-facing exec result must TAIL-truncate stdout/stderr per field so
// the tail (where errors live) survives the generic 24k HEAD-truncate backstop
// in do.ts/llm.ts stringifyToolResult, and gain text annotations without
// touching structured fields.

const TRUNCATION_HINT = "use the durable workstation job receipt for full logs";

let execPayload: Record<string, unknown> = {};
const execEnv = {
	ENVIRONMENT: "production",
	TEDI_SERVICE: {
		fetch: async () => Response.json(execPayload),
	} as unknown as Fetcher,
};
const runExec = async () =>
	(await execWorkstation(
		execEnv,
		{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
		{ command: "bun run test:run" },
	)) as Record<string, unknown>;

// Long stdout is tail-truncated: marker present, tail preserved, head dropped,
// whole lines kept, structured fields untouched.
const longStdout = Array.from(
	{ length: 400 },
	(_, i) => `stdout line ${String(i).padStart(4, "0")} ${"x".repeat(40)}`,
).join("\n");
assert.ok(longStdout.length > 10_000 && longStdout.length < 24_000);
execPayload = {
	ok: true,
	command: "bun run test:run",
	exitCode: 0,
	stdout: longStdout,
	stderr: "warn: slow test\n",
};
const truncatedStdoutResult = await runExec();
const truncatedStdout = truncatedStdoutResult.stdout as string;
assert.ok(
	truncatedStdout.startsWith(
		`[Truncated: showing last ${
			truncatedStdout.length - truncatedStdout.indexOf("\n") - 1
		} of ${longStdout.length} chars — ${TRUNCATION_HINT}]\n`,
	),
);
assert.ok(truncatedStdout.includes("stdout line 0399"), "tail preserved");
assert.ok(!truncatedStdout.includes("stdout line 0000"), "head dropped");
// The first content line after the marker is a complete line, not a splice.
assert.ok(truncatedStdout.split("\n")[1]?.startsWith("stdout line "));
assert.ok(truncatedStdout.length <= 10_000 + 200, "stdout budget enforced");
assert.equal(truncatedStdoutResult.exitCode, 0);
assert.equal(truncatedStdoutResult.ok, true);
assert.equal(truncatedStdoutResult.stderr, "warn: slow test\n");
assert.ok(!truncatedStdout.includes("[Exit code:"));

// stderr is truncated independently under its own smaller budget: a 9k stderr
// fits the 10k stdout budget but must still truncate under the 6k stderr one.
const longStderr = Array.from(
	{ length: 156 },
	(_, i) => `stderr line ${String(i).padStart(4, "0")} ${"e".repeat(40)}`,
).join("\n");
assert.ok(longStderr.length > 6_000 && longStderr.length < 10_000);
execPayload = {
	ok: false,
	command: "bun run test:run",
	exitCode: 1,
	stdout: "ok",
	stderr: longStderr,
};
const truncatedStderrResult = await runExec();
const truncatedStderr = truncatedStderrResult.stderr as string;
assert.ok(
	truncatedStderr.startsWith(
		`[Truncated: showing last ${
			truncatedStderr.length - truncatedStderr.indexOf("\n") - 1
		} of ${longStderr.length} chars — ${TRUNCATION_HINT}]\n`,
	),
);
assert.ok(truncatedStderr.includes("stderr line 0155"), "tail preserved");
assert.ok(!truncatedStderr.includes("stderr line 0000"), "head dropped");
assert.ok(truncatedStderr.length <= 6_000 + 200, "stderr budget enforced");
assert.equal(truncatedStderrResult.stdout, "ok\n[Exit code: 1]");
assert.equal(truncatedStderrResult.exitCode, 1);
assert.equal(truncatedStderrResult.ok, false);

// Worst case (both streams over budget) stays under the 24k serialized
// backstop, so stringifyToolResult never head-truncates an exec result.
execPayload = {
	ok: false,
	command: "bun run test:run",
	exitCode: 1,
	stdout: longStdout,
	stderr: `${longStderr}\n${longStderr}`,
	sessionId: "session-shell-1",
	workstationId: "workstation-shared",
};
assert.ok(
	JSON.stringify(await runExec(), null, 2).length <= 24_000,
	"combined exec payload stays under the 24k stringifyToolResult backstop",
);

// Nonzero exit annotation; stderr text passes through byte-identical.
execPayload = {
	ok: false,
	command: "cat missing.txt",
	exitCode: 2,
	stdout: "",
	stderr: "cat: missing.txt: No such file or directory\n",
};
const nonzeroExitResult = await runExec();
assert.equal(nonzeroExitResult.stdout, "[Exit code: 2]");
assert.equal(
	nonzeroExitResult.stderr,
	"cat: missing.txt: No such file or directory\n",
);
assert.equal(nonzeroExitResult.exitCode, 2);
assert.equal(nonzeroExitResult.ok, false);

// Both streams empty → [no output]; exit 0 adds no exit-code annotation.
execPayload = {
	ok: true,
	command: "true",
	exitCode: 0,
	stdout: "",
	stderr: "",
};
const emptyResult = await runExec();
assert.equal(emptyResult.stdout, "[no output]");
assert.equal(emptyResult.stderr, "");
assert.equal(emptyResult.exitCode, 0);

// Both empty AND nonzero exit → both annotations.
execPayload = {
	ok: false,
	command: "false",
	exitCode: 3,
	stdout: "",
	stderr: "",
};
const emptyFailureResult = await runExec();
assert.equal(emptyFailureResult.stdout, "[no output]\n[Exit code: 3]");
assert.equal(emptyFailureResult.stderr, "");
assert.equal(emptyFailureResult.exitCode, 3);

// Regression pin: short successful output passes through byte-identical —
// no markers, no annotations, no reshaped fields.
execPayload = {
	ok: true,
	command: "echo hello",
	exitCode: 0,
	stdout: "hello\nworld\n",
	stderr: "warn: x\n",
	sessionId: "session-shell-1",
	workstationId: "workstation-shared",
};
assert.deepEqual(await runExec(), { ...execPayload, profileId: "general" });

// Non-exec payloads (no stdout/stderr strings — transport errors, timeouts)
// pass through untouched; the timeout error already reports its duration.
execPayload = { ok: false, error: "workstation exec timed out after 120000ms" };
assert.deepEqual(await runExec(), { ...execPayload, profileId: "general" });

// A request timeout stops THIS caller waiting; it never reaches the
// workstation, so a dispatched process keeps running there. The abort payload
// carries a structured marker so process callers return a running receipt
// instead of a failure the model reads as a killed command.
const timedOutStart = (await startWorkstationProcessAdapter(
	timeoutEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ command: "bunx tsc --noEmit", kind: "command", processId: "proc-1" },
	{ timeoutMs: 1 },
)) as Record<string, unknown>;
assert.deepEqual(timedOutStart, {
	ok: false,
	error: "workstation process/start timed out after 1ms",
	requestTimedOut: true,
	waitedMs: 1,
});
const timedOutRead = (await readWorkstationProcessAdapter(
	timeoutEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ processId: "proc-1" },
	{ timeoutMs: 1 },
)) as Record<string, unknown>;
assert.equal(timedOutRead.requestTimedOut, true);
assert.equal(timedOutRead.waitedMs, 1);

// A caller-side cancel is not a request timeout: no detach marker.
// (Abort after dispatch: the mock only observes the abort EVENT, and a
// pre-aborted signal never fires one.)
const cancelController = new AbortController();
setTimeout(() => cancelController.abort(), 5);
const cancelledExec = (await execWorkstationAdapter(
	timeoutEnv,
	{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	{ command: "echo hi" },
	{ signal: cancelController.signal },
)) as Record<string, unknown>;
assert.deepEqual(cancelledExec, {
	ok: false,
	error: "workstation exec cancelled by caller",
});

// A complete persisted receipt remains server-authored, including pending
// readiness, participants, sessions and evidence beyond the schema's fields.
{
	const receipt = {
		...canonicalProvision(),
		workstationLease: {
			...canonicalProvision().workstationLease,
			status: "provisioning",
			serverDiagnostic: "preserve",
		},
		artifactRefs: ["r2://canonical-receipt"],
		providerEvidence: { acceptedAt: "2026-09-18T00:00:00Z" },
	};
	const result = (await requestWorkstation(
		{
			TEDI_SERVICE: {
				fetch: async () => Response.json(receipt, { status: 202 }),
			} as unknown as Fetcher,
		},
		{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
		{ seats: [{ tediId: "not-yet-joined" }] },
	)) as Record<string, unknown>;
	assert.deepEqual(result, {
		...receipt,
		leaseId: receipt.workstationLease.id,
		workstationId: receipt.workstation.id,
		profileId: "general",
	});
	assert.equal(result.ready, false, "accepted does not imply ready");
}

const malformedProvisionResponses: Record<string, unknown> = {
	invalidLeaseStatus: {
		...canonicalProvision(),
		workstationLease: {
			...canonicalProvision().workstationLease,
			status: "suspended",
		},
	},
	missingLease: { ...canonicalProvision(), workstationLease: undefined },
	invalidLease: {
		...canonicalProvision(),
		workstationLease: { id: "pretend" },
	},
	missingWorkstation: { ...canonicalProvision(), workstation: undefined },
	invalidWorkstation: {
		...canonicalProvision(),
		workstation: { id: "pretend" },
	},
	emptyLeaseId: {
		...canonicalProvision(),
		workstationLease: { ...canonicalProvision().workstationLease, id: " " },
	},
	emptyWorkstationId: {
		...canonicalProvision(),
		workstation: { ...canonicalProvision().workstation, id: " " },
	},
	wrongWorkstation: {
		...canonicalProvision(),
		workstationLease: {
			...canonicalProvision().workstationLease,
			workstationId: "other",
		},
	},
	wrongOrganization: {
		...canonicalProvision(),
		workstationLease: {
			...canonicalProvision().workstationLease,
			organizationId: "other-org",
		},
	},
	wrongTenant: {
		...canonicalProvision(),
		workstation: {
			...canonicalProvision().workstation,
			organizationId: "other-org",
		},
		workstationLease: {
			...canonicalProvision().workstationLease,
			organizationId: "other-org",
		},
	},
	conflictingRootLease: { ...canonicalProvision(), leaseId: "other" },
	conflictingRootWorkstation: {
		...canonicalProvision(),
		workstationId: "other",
	},
	missingAcceptance: { ...canonicalProvision(), accepted: undefined },
	rejectedAcceptance: { ...canonicalProvision(), accepted: false },
	missingPersistence: {
		...canonicalProvision(),
		workstationPersistence: undefined,
	},
	failedPersistence: {
		...canonicalProvision(),
		workstationPersistence: { status: "failed", error: "D1 unavailable" },
	},
	scheduledPersistence: {
		...canonicalProvision(),
		workstationPersistence: { status: "scheduled" },
	},
	skippedPersistence: {
		...canonicalProvision(),
		workstationPersistence: { status: "skipped" },
	},
	oldIncompleteSuccess: { ok: true, ready: true },
	missingSuccess: { ...canonicalProvision(), ok: undefined },
	nonJsonSuccess: "upstream text",
};
for (const [name, payload] of Object.entries(malformedProvisionResponses)) {
	const responsePayload = JSON.parse(JSON.stringify(payload));
	const result = (await requestWorkstation(
		{
			TEDI_SERVICE: {
				fetch: async () => Response.json(payload),
			} as unknown as Fetcher,
		},
		{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
	)) as Record<string, unknown>;
	assert.equal(result.ok, false, name);
	assert.equal(result.accepted, false, name);
	assert.equal(result.ready, undefined, name);
	assert.match(
		String(result.error),
		/outcome is unknown.*Do not reprovision/,
		name,
	);
	assert.equal(result.leaseId, undefined, name);
	assert.equal(result.workstationId, undefined, name);
	assert.equal(result.workstationLease, undefined, name);
	assert.equal(result.workstation, undefined, name);
	assert.deepEqual(result.body, responsePayload, name);
}

// Errors remain byte-for-byte structured evidence; no fallback appends IDs,
// generated workstation/lease records, participants or optimistic status.
{
	const failure = {
		ok: false,
		accepted: false,
		error: "persistence failed",
		workstationPersistence: { status: "failed", error: "D1 unavailable" },
		artifactRefs: ["r2://failure"],
		requestTimedOut: false,
	};
	const env = {
		TEDI_SERVICE: {
			fetch: async () => Response.json(failure),
		} as unknown as Fetcher,
	};
	assert.deepEqual(
		await requestWorkstation(env, {
			orgId: "org-1",
			slug: "cto",
			tediId: "tedi-1",
		}),
		failure,
	);
	const httpEnv = {
		TEDI_SERVICE: {
			fetch: async () =>
				Response.json(failure, { status: 503, statusText: "Unavailable" }),
		} as unknown as Fetcher,
	};
	assert.deepEqual(
		await requestWorkstation(httpEnv, {
			orgId: "org-1",
			slug: "cto",
			tediId: "tedi-1",
		}),
		{ ok: false, status: 503, error: "Unavailable", body: failure },
	);
}
// Files deny diagnostics retain fixed reason codes, never private edge bodies.
{
	const cases: Array<[unknown, string]> = [
		[
			{ error: "workstation lease wl_private is not in this organization" },
			"org_mismatch",
		],
		[
			{ error: "workstationId ws_private does not match lease wl_private" },
			"workstation_mismatch",
		],
		[
			{
				error:
					"workstation lease wl_private has no participant for tedi private-tedi",
			},
			"participant_missing",
		],
		[
			{ error: "workstation lease wl_private has no selectable participant" },
			"participant_missing",
		],
		[
			{ error: "workstation participant private-participant is not active" },
			"participant_inactive",
		],
		[
			{
				error:
					"workstation participant private-participant does not belong to lease wl_private",
			},
			"participant_lease_mismatch",
		],
		[
			{
				error:
					"workstation participant private-participant does not belong to tedi private-tedi",
			},
			"participant_tedi_mismatch",
		],
		[
			{
				error:
					"workstation session private-session belongs to participant private-participant",
			},
			"session_owner_mismatch",
		],
		[
			{ error: "private-token arbitrary upstream message" },
			"forbidden_unknown",
		],
		[
			{
				error:
					"workstation participant private-participant is not active\nprivate-token",
			},
			"forbidden_unknown",
		],
		[
			{ error: "workstation participant private-participant is not active\n" },
			"forbidden_unknown",
		],
		[{ error: "private-token".repeat(100) }, "forbidden_unknown"],
		[{ error: { token: "private-token" } }, "forbidden_unknown"],
		[null, "forbidden_unknown"],
		[[{ error: "private-token" }], "forbidden_unknown"],
	];
	const identity = { orgId: "org-1", slug: "cto", tediId: "tedi-1" };
	const input = {
		leaseId: "wl_selected",
		path: "proof.txt",
		operation: "read_file",
	};
	for (const [payload, reason] of cases) {
		const env = {
			TEDI_SERVICE: {
				fetch: async (request: Request) => {
					assert.equal(
						new URL(request.url).pathname,
						"/api/admin/workstation/files",
					);
					assert.equal(request.headers.get("X-Service-Binding"), "true");
					assert.equal(request.headers.get("X-Tedix-Workstation"), "true");
					assert.equal(request.headers.get("X-Tedix-Org-Id"), identity.orgId);
					assert.equal(request.headers.get("X-Tedix-Tedi-Id"), identity.tediId);
					assert.deepEqual(await request.json(), input);
					return Response.json(payload, {
						status: 403,
						statusText: "private-token",
					});
				},
			} as unknown as Fetcher,
		};
		const result = await operateComputerFiles(env, identity, input);
		assert.deepEqual(result, {
			ok: false,
			status: 403,
			error: `workstation_files_denied:${reason} (HTTP 403)`,
		});
		assert.doesNotMatch(
			JSON.stringify(result),
			/private-|wl_private|ws_private/,
		);
	}
	const plainTextEnv = {
		TEDI_SERVICE: {
			fetch: async () => new Response("private-token", { status: 403 }),
		} as unknown as Fetcher,
	};
	assert.deepEqual(await operateComputerFiles(plainTextEnv, identity, input), {
		ok: false,
		status: 403,
		error: "workstation_files_denied:forbidden_unknown (HTTP 403)",
	});
	const otherPathPayload = {
		error: "workstation participant private-participant is not active",
	};
	const otherPathEnv = {
		TEDI_SERVICE: {
			fetch: async () =>
				Response.json(otherPathPayload, {
					status: 403,
					statusText: "Forbidden",
				}),
		} as unknown as Fetcher,
	};
	assert.deepEqual(await requestWorkstation(otherPathEnv, identity), {
		ok: false,
		status: 403,
		error: "Forbidden",
		body: otherPathPayload,
	});
	for (const status of [200, 400, 404, 503]) {
		const payload = {
			ok: status === 200,
			error: "preserved upstream response",
		};
		const env = {
			TEDI_SERVICE: {
				fetch: async () => Response.json(payload, { status }),
			} as unknown as Fetcher,
		};
		const result = await operateComputerFiles(env, identity, input);
		assert.deepEqual(
			result,
			status === 200
				? payload
				: {
						ok: false,
						status,
						error:
							new Response(null, { status }).statusText ||
							"workstation request failed",
						body: payload,
					},
		);
	}
}
console.log(
	"Workstation transport: canonical persisted acquisitions, unchanged errors and no synthetic authority pass",
);

// Valid same-tenant leases still belong to one requested Work/run/generation.
{
	const input = {
		workItemId: "work-requested",
		kernelRunId: "run-requested",
		executionId: "generation-requested",
	};
	const canonical = canonicalProvision(input);
	const request = async (payload: unknown) =>
		requestWorkstation(
			{
				TEDI_SERVICE: {
					fetch: async () => Response.json(payload, { status: 202 }),
				} as unknown as Fetcher,
			},
			{ orgId: "org-1", slug: "cto", tediId: "tedi-1" },
			input,
		) as Promise<Record<string, unknown>>;
	assert.equal((await request(canonical)).ok, true);
	for (const property of [
		"workItemId",
		"kernelRunId",
		"executionId",
	] as const) {
		for (const mismatched of ["another-scope", null, undefined]) {
			const lease = structuredClone(canonical.workstationLease);
			if (property === "executionId") {
				if (mismatched === undefined) delete lease.metadata.executionId;
				else lease.metadata.executionId = mismatched;
			} else (lease as Record<string, unknown>)[property] = mismatched;
			const result = await request({ ...canonical, workstationLease: lease });
			assert.equal(result.ok, false, `${property}=${mismatched}`);
			assert.equal(result.accepted, false);
			assert.equal(result.leaseId, undefined);
			assert.match(String(result.error), /outcome is unknown/);
		}
	}
	// Requesting tedi is the canonical /provision lead in both server records.
	for (const patch of [
		{ participants: [] },
		{
			participants: canonical.workstationLease.participants.map(
				(participant) => ({ ...participant, tediId: "another-tedi" }),
			),
		},
		{
			participants: canonical.workstationLease.participants.map(
				(participant) => ({ ...participant, role: "collaborator" }),
			),
		},
		{
			participants: canonical.workstationLease.participants.map(
				(participant) => ({ ...participant, leaseId: "another-lease" }),
			),
		},
		{
			participants: canonical.workstationLease.participants.map(
				(participant) => ({ ...participant, organizationId: "another-org" }),
			),
		},
		{
			participants: canonical.workstationLease.participants.map(
				(participant) => ({ ...participant, leftAt: "2026-09-18T01:00:00Z" }),
			),
		},
	]) {
		assert.equal(
			(
				await request({
					...canonical,
					workstationLease: { ...canonical.workstationLease, ...patch },
				})
			).ok,
			false,
		);
	}
	assert.equal(
		(
			await request({
				...canonical,
				workstation: {
					...canonical.workstation,
					seats: [
						{ ...canonical.workstation.seats[0], tediId: "another-tedi" },
					],
				},
			})
		).ok,
		false,
	);
}

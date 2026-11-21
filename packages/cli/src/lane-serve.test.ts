import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as retryTimers from "node:timers/promises";
import { laneTurnOutputPaths } from "./lane-output";
import { CodexLaneResultJsonSchema } from "./lane-result";
import {
	LaneDispatcher,
	followUpRefusal,
	questionRefusal,
	LaneCommitFetchError,
	ARCHIVED_RUNS_KEPT,
	DISPATCHER_LOG_CAP_BYTES,
	MIN_FREE_DISK_BYTES,
	MAX_PREPARATIONS,
	cleanupLaneWorktree,
	installLaneDependencies,
	laneLandingBrief,
	provisionLaneWorktree,
	landedLaneCommits,
	landedDeployments,
	mainLaneCommits,
	existingLaneCommits,
	retainedLaneWorktree,
	dispatchSkip,
	laneDelegationRequest,
	parseServeOptions,
	runLaneServe,
	proposedAcceptance,
	serialCalls,
	cooldownGraceMs,
	type DispatchItem,
	type ServeOptions,
} from "./lane-serve";
import { childLeaseWatch } from "./lane-leases";
import { RunStepsUnavailableError } from "./lane-steps";
import {
	runnerDutyFromPlist,
	runnerDutyFromServeOptions,
	runnerKey,
	runnerServeArgs,
	writeRunnerDuty,
} from "./supervise-runners";
import {
	dispatcherNextCheckAt,
	writeDispatcherHealthSource,
} from "./dispatcher-health";
import { laneChildEnv } from "./lane-child-env";
import {
	dispatchRequestsDirectory,
	serveDispatchRequests,
} from "./lane-dispatch-wake";
import {
	answerMachineToolCall,
	machineToolHandlers,
} from "./lane-machine-tools";
import { writeWorkspaceCredentials } from "./credential-store";
import { parseOptions } from "./options";
import { CliReadError } from "./hooks/hook-io";
import { beginFileLock } from "./local-file-lock";
import { LaneOutcomeReadError } from "./lane-result";
import { runtimeAppEvidenceUri } from "./lane-runtime-app-proof";
import { laneProcessIdentity } from "./lane-process-recovery";
import { unpushedLaneCommits } from "./lane-unpushed";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";

const projectId = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
const fixtureCleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(fixtureCleanup.splice(0).map((cleanup) => cleanup()));
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const item = (n = 1): DispatchItem => ({
	id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
	title: "Summarize the guide",
	workKind: "research",
	description: "Write a paragraph as a Work comment.",
	disposition: "accepted",
	startAt: null,
	acceptanceContract: {
		version: 1,
		doneLooksLike: "A paragraph is recorded as a Work comment.",
	},
	projectId,
	version: 2,
	metadata: { executor: "codex" },
	accountableOwnerType: "user",
	accountableOwnerId: "fictional-owner",
});
const options: ServeOptions = {
	executor: "codex",
	coordinated: false,
	acceptProposed: false,
	project: projectId,
	rules: projectId,
	repo: "/fictional/repo",
	scope: ["--workspace", "acme", "--organization", "org_acme"],
	once: true,
	install: false,
};
const completedResult = (work = item()) => ({
	outcome: "completed" as const,
	workItemId: work.id,
	workVersion: work.version,
	contractVersion: work.acceptanceContract!.version,
	outcomeText: work.acceptanceContract?.doneLooksLike ?? work.title,
});
function fixture({
	refuse = false,
	dark = false,
	failSettle = false,
	devinReady = true,
	devinReason = "Devin is logged out",
	executor = "codex" as ServeOptions["executor"],
	coordinated = false,
	acceptProposed = false,
	capBytes = undefined as number | undefined,
	proposed = [] as DispatchItem[],
	autoCleanup = true,
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "lane-dispatch-test-"));
	if (autoCleanup) dirs.push(dir);
	const items: DispatchItem[] = [item(1), item(2), item(3)].map((row) => ({
		...row,
		metadata: {
			executor:
				executor === "any-local"
					? row.id === item(1).id
						? "claude-code"
						: "codex"
					: executor,
			...(coordinated && row.id === item(1).id
				? { laneDispatch: { state: "ready" } }
				: {}),
		},
	}));
	const devinAttempts = new Map<string, Record<string, unknown>>();
	const devinComments = new Map<string, Record<string, unknown>[]>();
	const devinOrgId = "99999999-9999-4999-8999-999999999999";
	const events: Array<{
		verb: string;
		args: string[];
		env: NodeJS.ProcessEnv;
		input?: Record<string, unknown>;
	}> = [];
	const recalls: Array<{
		brief: string;
		scope: string[];
		harness: string;
		cwd?: string;
	}> = [];
	const briefs: string[] = [];
	const releases: Array<() => void> = [];
	const control = {
		spawnPid: undefined as number | undefined,
		uniqueAttempts: false,
		deliverNote: undefined as string | undefined,
		telemetryOutcome: "succeeded" as "succeeded" | "stopped" | "failed",
		exitCode: 0,
		finalMessage: "Result recorded in OS.",
		declareCompleted: true,
		codexResultFile: undefined as string | null | undefined,
		provisionError: undefined as Error | undefined,
		threadError: undefined as Error | undefined,
		resumeError: undefined as Error | undefined,
		threadSessions: [] as Array<string | undefined>,
		installError: undefined as Error | undefined,
		installed: [] as string[],
		commits: [] as string[],
		deployments: [] as { url: string; sha: string }[],
		deploymentChecks: [] as string[][],
		repositoryChecks: [] as string[],
		existingRefusal: undefined as string | undefined,
		existingChecks: [] as string[][],
		unpushedCommits: [] as string[],
		unpushedWait: undefined as Promise<string[]> | undefined,
		heartbeatExpiry: false,
		heartbeatError: undefined as Error | undefined,
		onAgentEvent: undefined as ((observedAt: number) => void) | undefined,
		// What the step tool answers, one entry per call; an Error is thrown.
		stepReplies: [] as Array<Record<string, unknown>[] | Error>,
		stepCalls: [] as Array<{
			attemptId?: string;
			steps: Array<{
				seq: number;
				kind: string;
				text: string;
				choices?: string[];
			}>;
			applied: string[];
		}>,
		// The output and result file each launch was given, in launch order.
		turnFiles: [] as Array<{ output: string; result?: string }>,
		// Runs inside each agent turn, after it started and before it ends.
		duringTurn: undefined as
			| ((turn: {
					number: number;
					brief: string;
					args: string[];
					step: (kind: "message" | "command", text: string) => void;
			  }) => void | Promise<void>)
			| undefined,
		turns: 0,
		cleanups: 0,
		cleanupResult: true,
		cleanupRemoves: false,
		cleanupWait: undefined as Promise<boolean> | undefined,
		cleanupAfterPickup: [] as boolean[],
		runSize: 0,
		runSizes: new Map<string, number>(),
		freeDiskBytes: Number.MAX_SAFE_INTEGER,
		proofError: undefined as Error | undefined,
		evidenceError: undefined as Error | undefined,
		evidence: {
			data: [] as Record<string, unknown>[],
			nextCursor: null as unknown,
		},
		skillRun: {} as Record<string, unknown>,
		skillRunError: undefined as Error | undefined,
		rulesState: "active",
		skill: {} as Record<string, unknown>,
		appRead: undefined as ((source: string) => unknown) | undefined,
		startError: refuse
			? new CliReadError("Admission refused: resource capacity", "CONFLICT")
			: (undefined as Error | undefined),
		readiness: { ready: true, reasons: [] as Array<{ detail: string }> },
		completeError: undefined as Error | undefined,
		cooldownUntil: 0,
		cooldownWorkspaces: [] as Array<string | undefined>,
		recall: "",
		history: {
			data: [] as Record<string, unknown>[],
			nextCursor: null as string | null,
		},
		comments: [] as Record<string, unknown>[],
		historyError: undefined as Error | undefined,
		preparationGate: undefined as
			| { itemId: string; open: Promise<void> }
			| undefined,
	};
	let threadNumber = 0;
	let attemptNumber = 0;
	let cleaning = false;
	const config = {
		...options,
		executor,
		coordinated,
		acceptProposed,
		checkoutCapBytes: capBytes,
	};
	const deps: NonNullable<ConstructorParameters<typeof LaneDispatcher>[2]> = {
		health: () => [],
		createHeartbeat: (scope) => (receipt) =>
			deps.cli!<{ expiresAt: string }>(
				[...scope, "work", "heartbeat", receipt.itemId],
				{
					TEDIX_AGENT_SESSION: receipt.session,
					TEDIX_EXTERNAL_AGENT: receipt.executorKey,
					TEDIX_CLI_EXPECTED_ATTEMPT_ID: receipt.attemptId,
				},
			),
		createStepSender: () => async (receipt, steps, applied) => {
			control.stepCalls.push({
				attemptId: receipt.attemptId,
				steps: [...steps],
				applied,
			});
			const reply = control.stepReplies.shift();
			if (reply instanceof Error) throw reply;
			return { accepted: steps.length, pending: reply ?? [] };
		},
		waitForIdentity: async () => undefined,
		darkWake: () => dark,
		gatewayCooldownUntil: (workspace) => {
			control.cooldownWorkspaces.push(workspace);
			return control.cooldownUntil;
		},
		available: () => ({ available: true }),
		preflight: async () => undefined,
		budgets: () => ({}),
		devinAvailability: () =>
			devinReady
				? { available: true }
				: { available: false, reason: devinReason },
		provision: (_source, destination) => {
			if (control.provisionError) throw control.provisionError;
			return destination;
		},
		baseCommit: () => "a".repeat(40),
		installDependencies: async (repo) => {
			if (control.installError) throw control.installError;
			control.installed.push(repo);
		},
		landedCommits: async () => {
			if (control.proofError) throw control.proofError;
			return control.commits;
		},
		mainCommits: (_repo, commits) => commits,
		landedDeployments: async (_repo, commits) => {
			control.deploymentChecks.push(commits);
			if (!control.deployments.length)
				throw new Error("The live surface does not contain the landed commit");
			return control.deployments;
		},
		existingCommits: async (_repo, cited) => {
			if (control.proofError) throw control.proofError;
			control.existingChecks.push(cited);
			return control.existingRefusal;
		},
		verifyRepository: (_repo, result) => {
			const proof = result.repositoryProof!;
			control.repositoryChecks.push(proof.repository);
			return {
				mode: "repository_commit",
				repository: proof.repository,
				commitSha: proof.commitSha,
				runId: proof.runId,
				runAttempt: 1,
				runCommitSha: proof.commitSha,
				evidenceUri: `https://github.com/${proof.repository}/actions/runs/${proof.runId}`,
			};
		},
		unpushedCommits: async () =>
			control.unpushedWait ?? control.unpushedCommits,
		recall: async (brief, scope, harness, _organization, cwd) => {
			recalls.push({ brief, scope, harness, cwd });
			return {
				brief: control.recall ? `${control.recall}\n\n${brief}` : brief,
				recall: control.recall,
				recallStatus: control.recall ? "matched" : "none",
			};
		},
		cleanup: (_source, destination) => {
			control.cleanups++;
			control.cleanupAfterPickup.push(
				events.some((event) => event.verb === "dispatch-list"),
			);
			if (control.cleanupRemoves) rmSync(destination, { recursive: true });
			return control.cleanupWait ?? control.cleanupResult;
		},
		directoryBytes: async (path) =>
			control.runSizes.get(path) ?? control.runSize,
		freeDiskBytes: () => control.freeDiskBytes,
		thread: async (repo, executor, _model, resume) => {
			control.threadSessions.push(resume);
			if (resume && control.resumeError) throw control.resumeError;
			if (control.threadError) throw control.threadError;
			if (
				control.preparationGate &&
				repo.includes(control.preparationGate.itemId)
			)
				await control.preparationGate.open;
			if (executor === "devin") expect(control.installed).toContain(repo);
			return {
				thread: {
					id:
						(control.uniqueAttempts ? resume : undefined) ??
						`33333333-3333-4333-8333-${String(++threadNumber).padStart(12, "0")}`,
					cliVersion: "1.2.3",
					path: "/fictional/transcript",
				},
				model: "test-model",
				modelProvider: "test-provider",
			};
		},
		cli: async <T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> => {
			const verb = args[5]!;
			const inputIndex = args.indexOf("--input");
			const input =
				inputIndex < 0 ? undefined : JSON.parse(args[inputIndex + 1]!);
			events.push({ verb, args, env, input });
			if (verb === "dispatch-list" && input.disposition !== "proposed")
				expect(input.dispatchReadyOnly).toBe(true);
			let response: unknown;
			if (args[4] === "code") response = control.appRead?.(args[5]!);
			else if (verb === "dispatch-list" && input.disposition === "proposed")
				response = { data: proposed, pagination: { hasMore: false } };
			else if (
				verb === "dispatch-list" ||
				(verb === "dispatch-idle-list" && input.dispatchReadyOnly)
			)
				// Like the server's ready filter: held Work is not offered.
				response = {
					data: items.filter(
						(row) =>
							(row.metadata?.laneDispatch as { state?: string })?.state !==
								"held" &&
							(!input.idPrefix || row.id === input.idPrefix),
					),
					pagination: { hasMore: false },
				};
			else if (
				verb === "dispatch-hold" ||
				(verb === "dispatch-reassign" && input.laneDispatch)
			) {
				// Like the server: changing the dispatch plan creates a Work version.
				const row = items.find((row) => row.id === args[6])!;
				row.version++;
				if (input.laneDispatch)
					row.metadata = { ...row.metadata, laneDispatch: input.laneDispatch };
				if (input.startAt) row.startAt = input.startAt;
				response = row;
			} else if (verb === "interaction-create")
				response = { id: "fictional-request" };
			else if (verb === "dispatch-get")
				response = {
					workItem: {
						...items.find((row) => row.id === args[6]),
						...(executor === "devin" ? { orgId: devinOrgId } : {}),
					},
					comments: [
						...(devinComments.get(args[6]!) ?? []),
						...control.comments,
					],
				};
			else if (verb === "dispatch-attempts") {
				if (control.historyError) throw control.historyError;
				response = devinAttempts.has(args[6]!)
					? { data: [devinAttempts.get(args[6]!)], nextCursor: null }
					: control.history;
			} else if (verb === "evidence") {
				if (control.evidenceError) throw control.evidenceError;
				response = control.evidence;
			} else if (verb === "status") {
				if (control.skillRunError) throw control.skillRunError;
				response = control.skillRun;
			} else if (verb === "readiness") response = control.readiness;
			else if (verb === "runner-rules")
				response = {
					rules: { content: "The dispatcher owns the Attempt.", version: 3 },
				};
			else if (verb === "show" && args.includes("--file"))
				response = { path: "SKILL.md", content: "Keep all evidence in OS." };
			else if (verb === "show" && args[6] !== options.rules)
				response = control.skill;
			else if (verb === "show")
				response = {
					id: options.rules,
					revision: 7,
					contentPreview: "Keep all evidence in OS.",
					lifecycleState: control.rulesState,
				};
			else if (verb === "start" && args[4] === "agent")
				response = { principalKey: "local-acme" };
			else if (verb === "start") {
				if (control.startError) throw control.startError;
				const isDevin = env.TEDIX_AGENT_SESSION?.startsWith("devin:");
				const workItem = {
					...items.find((row) => row.id === args[6]),
					orgId: devinOrgId,
				};
				const attempt = {
					id: isDevin
						? "88888888-8888-4888-8888-888888888888"
						: input.metadata?.verificationRound
							? `fictional-verification-${workItem.version}`
							: control.uniqueAttempts
								? `fictional-attempt-${++attemptNumber}`
								: "fictional-attempt",
					orgId: devinOrgId,
					workItemId: args[6],
					executorId: "local-acme",
					executorType: "external_agent",
					externalSessionKey: env.TEDIX_AGENT_SESSION,
					runtimeState: "running",
					outcome: null,
					metadata: { dispatchVersion: workItem.version },
					expiresAt: new Date(Date.now() + 300000).toISOString(),
				};
				if (isDevin) devinAttempts.set(args[6]!, attempt);
				response = { workItem, attempt };
			} else if (
				verb === "comment" &&
				env.TEDIX_AGENT_SESSION?.startsWith("devin:")
			) {
				const comment = {
					id: "saved-note",
					orgId: devinOrgId,
					workItemId: args[6],
					authorType: "external_agent",
					authorId: "local-acme",
					body: args[args.indexOf("--body") + 1],
					metadata: { agentSession: env.TEDIX_AGENT_SESSION },
					createdAt: new Date().toISOString(),
				};
				devinComments.set(args[6]!, [comment]);
				response = comment;
			} else if (verb === "settle" && failSettle)
				throw new Error("Transient settlement failure");
			else if (verb === "complete" && control.completeError)
				throw control.completeError;
			else if (
				verb === "complete" &&
				input === undefined &&
				control.deployments.length
			) {
				const work = items.find((row) => row.id === args[6])!;
				work.disposition = "completed";
				response = { ...work, completedAt: new Date().toISOString() };
			} else if (verb === "heartbeat" && control.heartbeatError)
				throw control.heartbeatError;
			else if (verb === "heartbeat" && control.heartbeatExpiry)
				response = { expiresAt: new Date(Date.now() + 300_000).toISOString() };
			else response = {};
			return response as T;
		},
		launch: async (args, deps) => {
			const nativeExecutor =
				args[args.indexOf("--executor") + 1] === "devin"
					? "devin"
					: args[args.indexOf("--executor") + 1] === "claude-code"
						? "claude-code"
						: args[args.indexOf("--executor") + 1] === "opencode"
							? "opencode"
							: "codex";
			const brief = readFileSync(args[args.indexOf("--brief") + 1]!, "utf8");
			briefs.push(brief);
			// A follow-up turn resumes the thread with only the new message.
			const followUp = /follow-up-\d+\.txt$/.test(
				args[args.indexOf("--brief") + 1]!,
			);
			const work = items.find(
				(row) => row.id === args[args.indexOf("--work-item") + 1],
			)!;
			expect(deps?.label).toBe(work.title);
			expect(deps?.cwd).toBe(
				join(dirname(args[args.indexOf("--brief") + 1]!), "repo"),
			);
			expect(deps?.detachedOutputDirectory).toBe(
				join(
					dirname(args[args.indexOf("--brief") + 1]!),
					nativeExecutor === "devin"
						? "88888888-8888-4888-8888-888888888888"
						: brief.includes("Verify-only Attempt.")
							? `fictional-verification-${work.version}`
							: control.uniqueAttempts
								? `fictional-attempt-${attemptNumber}`
								: "fictional-attempt",
				),
			);
			expect(args.slice(args.indexOf("--") + 1)).toEqual(
				nativeExecutor === "devin"
					? ["devin"]
					: nativeExecutor === "opencode"
						? [
								"opencode",
								"run",
								"--dir",
								join(dirname(args[args.indexOf("--brief") + 1]!), "repo"),
								"--format",
								"json",
								"--model",
								"test-provider/test-model",
								"--auto",
								"--session",
								expect.any(String),
							]
						: nativeExecutor === "claude-code"
							? [
									"claude",
									"-p",
									followUp || control.threadSessions.includes(deps?.sessionKey)
										? "--resume"
										: "--session-id",
									expect.any(String),
									"--output-format",
									"stream-json",
									"--verbose",
								]
							: [
									"codex",
									"exec",
									"-C",
									join(dirname(args[args.indexOf("--brief") + 1]!), "repo"),
									"resume",
									expect.any(String),
									"--output-schema",
									expect.any(String),
									"-o",
									expect.any(String),
									"-",
								],
			);
			if (!followUp) {
				expect(brief).toContain("runner rules version 3");
				// The organization's own rules are added only while its skill is active.
				expect(brief.includes("revision 7")).toBe(
					control.rulesState === "active",
				);
				expect(brief.includes("Keep all evidence in OS.")).toBe(
					control.rulesState === "active",
				);
				expect(brief).toContain("already holds Attempt");
			}
			if (
				items.find((row) => row.id === args[args.indexOf("--work-item") + 1])!
					.metadata?.artifactKind === "skill_revision"
			)
				expect(brief).toContain("--evidence-kind skill_revision");
			else expect(brief).not.toContain("--evidence-kind skill_revision");
			if (!followUp && !brief.includes("Verify-only Attempt.")) {
				// One trailer paragraph with this lane's exact ids, so the pre-push
				// secret scan accepts the lane's commits.
				expect(brief).toMatch(
					new RegExp(
						`\\nWork-Item: [0-9a-f-]{36}\\nAgent-Session: ${nativeExecutor}:\\S+\\n`,
					),
				);
				expect(brief).toContain("Do not pass one -m per trailer");
			}
			expect(deps?.forwardSignals).toBe(false);
			// Like the real launcher, open this turn's output files in the
			// Attempt's folder before the agent starts.
			const output = laneTurnOutputPaths(deps!.detachedOutputDirectory!);
			writeFileSync(output.stdout, "", { flag: "wx" });
			writeFileSync(output.stderr, "", { flag: "wx" });
			control.turnFiles.push({
				output: `stdout-${output.turn}.log`,
				...(nativeExecutor === "codex"
					? { result: basename(args[args.indexOf("-o") + 1]!) }
					: {}),
			});
			deps?.onSpawn?.(control.spawnPid ?? 2_000_000_000);
			control.onAgentEvent = deps?.onAgentEvent;
			await control.duringTurn?.({
				number: ++control.turns,
				brief,
				args,
				step: (kind, text) => deps?.onAgentStep?.({ kind, text }),
			});
			const completed = completedResult(
				items.find((row) => row.id === args[args.indexOf("--work-item") + 1])!,
			);
			await new Promise<void>((done) => {
				releases.push(done);
				if (cleaning) done();
			});
			if (control.deliverNote) {
				const bridge = deps!.devinWorkBridge!;
				expect((await bridge.context()).binding.externalSessionKey).toBe(
					`devin:${deps!.sessionKey}`,
				);
				const saved = await bridge.deliver(
					`TEDIX_WORK_RESULT ${JSON.stringify({ binding: bridge.binding, outcome: "succeeded", note: control.deliverNote })}`,
				);
				await bridge.verify(
					`TEDIX_WORK_VERIFIED ${JSON.stringify({ binding: bridge.binding, commentId: saved.commentId, sha256: saved.sha256 })}`,
				);
			}
			if (nativeExecutor === "codex") {
				const schema = JSON.parse(
					readFileSync(args[args.indexOf("--output-schema") + 1]!, "utf8"),
				);
				expect(schema.type).toBe("object");
				expect(schema.additionalProperties).toBe(false);
				expect(schema.required).toEqual(Object.keys(schema.properties));
				expect(brief).toContain(
					"only the JSON object required by --output-schema",
				);
				expect(brief).not.toContain(
					"End your final answer with exactly one TEDIX_LANE_RESULT JSON line",
				);
				const line = control.finalMessage
					.split("\n")
					.find((line) => line.startsWith("TEDIX_LANE_RESULT "));
				const resultFile =
					control.codexResultFile !== undefined
						? control.codexResultFile
						: (line?.slice("TEDIX_LANE_RESULT ".length) ??
							(control.declareCompleted ? JSON.stringify(completed) : null));
				if (resultFile !== null)
					writeFileSync(args[args.indexOf("-o") + 1]!, resultFile);
			} else {
				expect(args).not.toContain("--output-schema");
				expect(brief).toContain(
					"End your final answer with exactly one TEDIX_LANE_RESULT JSON line",
				);
			}
			deps?.onTelemetry?.({
				executor: nativeExecutor,
				model: "test-model",
				provider: "test-provider",
				reasoningEffort: null,
				brief: "test",
				startedAt: "2026-10-01T00:00:00.000Z",
				heartbeatAt: "2026-10-01T00:00:01.000Z",
				finishedAt: "2026-10-01T00:00:01.000Z",
				outcome: control.telemetryOutcome,
				finalMessage:
					control.declareCompleted &&
					!control.finalMessage.includes("TEDIX_LANE_RESULT")
						? `${control.finalMessage}\nTEDIX_LANE_RESULT ${JSON.stringify(completed)}`
						: control.finalMessage,
				tools: {},
				usage: { input: 100, cached: 40, output: 30, reasoning: 10 },
				shas: [],
				workItems: [],
				corrections: [],
				source: "wrapper",
			});
			return control.exitCode;
		},
	};
	const dispatchers: LaneDispatcher[] = [];
	const restart = (directory = dir) => {
		const dispatcher = new LaneDispatcher(config, directory, deps);
		dispatchers.push(dispatcher);
		return dispatcher;
	};
	const cleanup = async () => {
		cleaning = true;
		for (const dispatcher of dispatchers) dispatcher.stop();
		for (const release of releases) release();
		await Promise.all(dispatchers.map((dispatcher) => dispatcher.drain()));
	};
	if (autoCleanup) fixtureCleanup.push(cleanup);
	const dispatcher = restart();
	return {
		dispatcher,
		cleanup,
		restart,
		deps,
		config,
		dir,
		events,
		releases,
		control,
		items,
		recalls,
		briefs,
	};
}
async function withoutReadBackoff(run: () => Promise<void>) {
	const wait = spyOn(retryTimers, "setTimeout").mockResolvedValue(undefined);
	try {
		await run();
	} finally {
		wait.mockRestore();
	}
}

async function until(test: () => boolean, attempts = 100) {
	for (let n = 0; n < attempts && !test(); n++)
		await new Promise((done) => setTimeout(done, 2));
	expect(test()).toBe(true);
}

describe("restarting onto an updated CLI", () => {
	function serve(listed: boolean) {
		const directory = mkdtempSync(join(tmpdir(), "lane-update-"));
		dirs.push(directory);
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = directory;
		if (listed)
			writeFileSync(
				join(directory, "supervisor-runners.json"),
				JSON.stringify({
					version: 1,
					runners: [
						{
							workspace: "acme",
							organization: "org_acme",
							executor: "codex",
							rules: "lane-rules",
							repo: "/fictional/repo",
						},
					],
				}),
			);
		const spies = [
			spyOn(LaneDispatcher.prototype, "tick").mockResolvedValue(),
			spyOn(LaneDispatcher.prototype, "nextTickDelayMs").mockReturnValue(5),
			spyOn(process.stderr, "write").mockReturnValue(true),
		];
		const quiet = spyOn(LaneDispatcher.prototype, "quiet");
		const hold = spyOn(LaneDispatcher.prototype, "holdAdmissions");
		return {
			tick: spies[0]!,
			stderr: spies[2]!,
			quiet,
			hold,
			running: runLaneServe(
				["--executor", "codex", ...options.scope],
				() => "99.0.0",
			),
			cleanup() {
				for (const spy of [...spies, quiet, hold]) spy.mockRestore();
				if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
				else process.env.TEDIX_CONFIG_DIR = previous;
			},
		};
	}
	it("a supervised runner takes no new Work, waits until none is in progress, then exits for the supervisor to restart it", async () => {
		const f = serve(true);
		f.quiet.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
		f.quiet.mockResolvedValue(true);
		try {
			expect(await f.running).toBe(75);
			expect(f.tick).toHaveBeenCalledTimes(3);
			expect(f.hold).toHaveBeenCalled();
			expect(f.stderr.mock.calls.map(([line]) => String(line))).toEqual([
				expect.stringContaining("found Tedix CLI 99.0.0 installed"),
				"Dispatcher restarting onto Tedix CLI 99.0.0; no Work in progress\n",
			]);
		} finally {
			f.cleanup();
		}
	});
	it("a runner the supervisor does not list keeps serving", async () => {
		const f = serve(false);
		f.quiet.mockResolvedValue(true);
		try {
			await until(() => f.tick.mock.calls.length >= 3);
			expect(f.hold).not.toHaveBeenCalled();
			process.emit("SIGTERM", "SIGTERM");
			expect(await f.running).toBe(0);
		} finally {
			f.cleanup();
		}
	});
});

describe("dispatcher lock handoff", () => {
	function handoff(
		executor = "codex",
		serveArgs: string[] = [],
		before?: (directory: string) => void,
	) {
		const directory = mkdtempSync(join(tmpdir(), "lane-handoff-"));
		dirs.push(directory);
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = directory;
		const lockDirectory = (name: string) =>
			join(
				directory,
				"dispatchers",
				createHash("sha256")
					.update(`org_acme:${name}`)
					.digest("hex")
					.slice(0, 16),
				"lock",
			);
		const predecessor = beginFileLock(lockDirectory("codex"));
		const tick = spyOn(LaneDispatcher.prototype, "tick").mockResolvedValue();
		const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
		let polls = 0;
		const schedule = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			if (args[1] === 250) {
				polls++;
				args[1] = 1;
			}
			return schedule(...args);
		}) as typeof setTimeout);
		const signals = [
			process.listenerCount("SIGTERM"),
			process.listenerCount("SIGINT"),
		] as const;
		// Locks are taken synchronously on serve start, so a blocking claim must
		// exist before runLaneServe is invoked.
		before?.(directory);
		const running = runLaneServe([
			"--executor",
			executor,
			"--once",
			...serveArgs,
			...options.scope,
		]);
		return {
			directory,
			predecessor,
			tick,
			stderr,
			running,
			lockDirectory,
			get polls() {
				return polls;
			},
			async cleanup() {
				predecessor.release();
				await running.catch(() => {});
				tick.mockRestore();
				stderr.mockRestore();
				timer.mockRestore();
				if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
				else process.env.TEDIX_CONFIG_DIR = previous;
				expect(process.listenerCount("SIGTERM")).toBe(signals[0]);
				expect(process.listenerCount("SIGINT")).toBe(signals[1]);
			},
		};
	}
	it("waits through multiple polls, logs once, and takes over after the predecessor drains", async () => {
		const f = handoff();
		try {
			await until(() => f.polls >= 3);
			expect(f.tick).not.toHaveBeenCalled();
			expect(f.stderr.mock.calls.map(([line]) => line)).toEqual([
				`Dispatcher waiting for ${process.pid} to finish draining\n`,
			]);
			expect(readdirSync(f.lockDirectory("codex"))).toHaveLength(2);
			f.predecessor.release();
			expect(await f.running).toBe(0);
			expect(f.tick).toHaveBeenCalledTimes(1);
			expect(readdirSync(f.lockDirectory("codex"))).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		it(`releases a waiting any-local runner on ${signal} without touching its predecessor`, async () => {
			const f = handoff("any-local");
			try {
				process.emit(signal, signal);
				expect(await f.running).toBe(0);
				expect(f.tick).not.toHaveBeenCalled();
				expect(f.predecessor.ready()).toBe(true);
				expect(readdirSync(f.lockDirectory("codex"))).toHaveLength(1);
			} finally {
				await f.cleanup();
			}
		});
	}
	it("releases earlier any-local claims when a later lock is corrupt", async () => {
		const f = handoff("any-local");
		const corrupt = f.lockDirectory("any-local");
		mkdirSync(corrupt, { recursive: true });
		writeFileSync(join(corrupt, "bad.json"), "{");
		try {
			f.predecessor.release();
			await expect(f.running).rejects.toThrow();
			for (const executor of ["codex", "claude-code", "opencode", "devin"])
				expect(readdirSync(f.lockDirectory(executor))).toEqual([]);
			expect(readdirSync(corrupt)).toEqual(["bad.json"]);
			expect(f.tick).not.toHaveBeenCalled();
		} finally {
			await f.cleanup();
		}
	});
	describe("a scoped any-local runner", () => {
		const repo = "/fictional/ops-checkout";
		const scopedKey = () =>
			runnerKey({
				organization: "org_acme",
				executor: "any-local",
				project: projectId,
				repo,
			});
		it("passes beside the per-executor runners without touching their locks", async () => {
			const f = handoff("any-local", ["--project", projectId, "--repo", repo]);
			const peers = ["claude-code", "opencode", "devin"].map((executor) =>
				beginFileLock(f.lockDirectory(executor)),
			);
			try {
				expect(await f.running).toBe(0);
				expect(f.tick).toHaveBeenCalledTimes(1);
				expect(f.stderr.mock.calls).toEqual([]);
				for (const executor of ["codex", "claude-code", "opencode", "devin"])
					expect(readdirSync(f.lockDirectory(executor))).toHaveLength(1);
				const lane = join(f.directory, "dispatchers", scopedKey());
				expect(existsSync(join(lane, "health-source.json"))).toBe(true);
				expect(readdirSync(join(lane, "lock"))).toEqual([]);
			} finally {
				for (const peer of peers) peer.release();
				await f.cleanup();
			}
		});
		it("runs beside differently scoped runners but waits on the same scope", async () => {
			const otherProject = "33333333-3333-4333-8333-333333333333";
			const otherRepo = "/fictional/other-checkout";
			const laneLock = (
				directory: string,
				scope: { project?: string; repo?: string },
			) =>
				beginFileLock(
					join(
						directory,
						"dispatchers",
						runnerKey({
							organization: "org_acme",
							executor: "any-local",
							...scope,
						}),
						"lock",
					),
				);
			// Runners serving another project, another repo or the whole
			// organization hold only their own lanes, so this one passes
			// without waiting on them.
			let siblings: ReturnType<typeof beginFileLock>[] = [];
			const f = handoff(
				"any-local",
				["--project", projectId, "--repo", repo],
				(directory) => {
					siblings = [
						{ project: otherProject, repo },
						{ project: projectId, repo: otherRepo },
						{},
					].map((scope) => laneLock(directory, scope));
				},
			);
			try {
				expect(await f.running).toBe(0);
				expect(f.tick).toHaveBeenCalledTimes(1);
				expect(f.stderr.mock.calls).toEqual([]);
			} finally {
				for (const sibling of siblings) sibling.release();
				await f.cleanup();
			}
			// The same project and repo share one lane: a holder makes us wait.
			let peer!: ReturnType<typeof beginFileLock>;
			const same = handoff(
				"any-local",
				["--project", projectId, "--repo", repo],
				(directory) => {
					peer = laneLock(directory, { project: projectId, repo });
				},
			);
			try {
				await until(() => same.polls > 0);
				expect(same.tick).not.toHaveBeenCalled();
				peer.release();
				expect(await same.running).toBe(0);
				expect(same.tick).toHaveBeenCalledTimes(1);
			} finally {
				peer.release();
				await same.cleanup();
			}
		});
		it("leaves per-executor receipts for the runners they belong to", async () => {
			const f = handoff("any-local", ["--project", projectId, "--repo", repo]);
			const receipt = "22222222-2222-4222-8222-222222222222-1.json";
			writeFileSync(join(f.lockDirectory("codex"), "..", receipt), "{}");
			try {
				expect(await f.running).toBe(0);
				expect(f.tick).toHaveBeenCalledTimes(1);
				expect(existsSync(join(f.lockDirectory("codex"), "..", receipt))).toBe(
					true,
				);
				expect(
					existsSync(join(f.directory, "dispatchers", scopedKey(), receipt)),
				).toBe(false);
			} finally {
				await f.cleanup();
			}
		});
	});
});

describe("dispatcher log", () => {
	const skipped = (dir: string) =>
		readFileSync(join(dir, "dispatcher.log"), "utf8")
			.split("\n")
			.filter((line) => line.includes('"event":"skipped"'));

	it("writes an unchanged skip reason once per item, then hourly", async () => {
		const f = fixture();
		for (const row of f.items) row.metadata = { executor: "claude-code" };
		await f.dispatcher.tick();
		await f.dispatcher.tick();
		expect(skipped(f.dir)).toHaveLength(f.items.length);
		const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
		try {
			await f.dispatcher.tick();
		} finally {
			clock.mockRestore();
		}
		expect(skipped(f.dir)).toHaveLength(2 * f.items.length);
	});

	it("writes again as soon as an item's skip reason changes", async () => {
		const f = fixture();
		for (const row of f.items) row.metadata = { executor: "claude-code" };
		await f.dispatcher.tick();
		await f.dispatcher.tick();
		for (const row of f.items) {
			row.metadata = { executor: "codex" };
			row.projectId = null;
		}
		await f.dispatcher.tick();
		const lines = skipped(f.dir);
		expect(lines).toHaveLength(2 * f.items.length);
		expect(lines.slice(f.items.length).join("\n")).toContain(
			"Work has no project",
		);
	});

	it("rotates dispatcher.log past the cap and keeps the new lines", async () => {
		const f = fixture();
		for (const row of f.items) row.metadata = { executor: "claude-code" };
		writeFileSync(
			join(f.dir, "dispatcher.log"),
			"x".repeat(DISPATCHER_LOG_CAP_BYTES + 1),
		);
		await f.dispatcher.tick();
		expect(readFileSync(join(f.dir, "dispatcher.log.1"), "utf8")).toHaveLength(
			DISPATCHER_LOG_CAP_BYTES + 1,
		);
		expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
			'"event":"skipped"',
		);
	});
});

describe("dispatcher admission", () => {
	it("keeps a start request while the runner waits to restart, and the next runner starts it without a pass", async () => {
		const f = fixture();
		const target = f.items[1]!;
		const duty = runnerDutyFromServeOptions(f.config);
		const env = { TEDIX_CONFIG_DIR: f.dir };
		writeRunnerDuty(env, duty);
		const directory = join(f.dir, "dispatchers", runnerKey(duty));
		const requests = dispatchRequestsDirectory(directory);
		mkdirSync(requests, { recursive: true });

		const leaving = f.restart(directory);
		leaving.holdAdmissions("9.9.9");
		const stopLeaving = new AbortController();
		void serveDispatchRequests(requests, stopLeaving.signal, (id) =>
			leaving.startRequested(id),
		);
		const answer = await answerMachineToolCall(
			machineToolHandlers({
				checkout: duty.repo,
				configDir: f.dir,
				organization: duty.organization,
				env,
			}),
			"dispatch_work_item",
			{ workItemId: target.id, projectId, executor: "codex" },
		);
		expect(answer.ok).toBe(true);
		const log = () => readFileSync(join(directory, "dispatcher.log"), "utf8");
		// The folder is read every 250 ms when the watcher misses the file.
		await until(() => existsSync(join(directory, "dispatcher.log")), 1000);
		expect(log()).toContain('"event":"request-held"');
		expect(readdirSync(requests)).toEqual([target.id]);
		stopLeaving.abort();

		const lane = f.restart(directory);
		const stopLane = new AbortController();
		void serveDispatchRequests(requests, stopLane.signal, (id) =>
			lane.startRequested(id),
		);
		await until(() => f.releases.length === 1, 1000);
		expect(
			f.events
				.filter((event) => event.verb === "start" && event.args[4] === "work")
				.map((event) => event.args[6]),
		).toEqual([target.id]);
		expect(f.control.turnFiles).toHaveLength(1);
		await until(() => readdirSync(requests).length === 0);
		stopLane.abort();
		f.releases[0]!();
		await lane.drain();
	});

	it("a start request retries a start that failed before any Attempt, and leaves a record with an Attempt alone", async () => {
		const f = fixture();
		const [retried, kept] = f.items;
		const record = (row: typeof retried, extra: object) =>
			writeFileSync(
				join(f.dir, `${row!.id}-${row!.version}.json`),
				JSON.stringify({
					itemId: row!.id,
					version: row!.version,
					phase: "deferred",
					outcome: "failed",
					note: "Error: Tedix CLI read deadline elapsed",
					...extra,
				}),
			);
		record(retried, { admissionState: "not_sent" });
		record(kept, { admissionState: "admitted", attemptId: "a".repeat(8) });
		await f.dispatcher.startRequested(kept!.id);
		await f.dispatcher.startRequested(retried!.id);
		await until(() => f.releases.length === 1, 1000);
		expect(
			f.events
				.filter((event) => event.verb === "start" && event.args[4] === "work")
				.map((event) => event.args[6]),
		).toEqual([retried!.id]);
		expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
			"This runner already has a record of this revision",
		);
		f.releases[0]!();
		await f.dispatcher.drain();
	});

	it("prepares at most MAX_PREPARATIONS starts at once and still runs them all", async () => {
		const f = fixture();
		for (let n = 4; n <= 12; n++) f.items.push(item(n));
		let preparing = 0;
		let most = 0;
		const thread = f.deps.thread!;
		f.deps.thread = async (...args) => {
			most = Math.max(most, ++preparing);
			await new Promise((done) => setTimeout(done, 5));
			return thread(...args);
		};
		const cli = f.deps.cli!;
		f.deps.cli = async (args, ...rest) => {
			try {
				return await cli(args, ...rest);
			} finally {
				if (args[4] === "work" && args[5] === "start") preparing--;
			}
		};
		const dispatcher = f.restart();
		await dispatcher.tick();
		// The limit is on start-ups: all twelve end up running together.
		await until(() => f.releases.length === 12, 1000);
		expect(most).toBe(MAX_PREPARATIONS);
		expect(
			f.events.filter((event) => event.verb === "runner-rules").length,
		).toBeLessThanOrEqual(2);
		for (const release of f.releases) release();
		await dispatcher.drain();
	});

	it("retries unready starts after fresh starts across pages following a restart", async () => {
		const f = fixture();
		const blocked = f.items.slice();
		const reasons = [
			"Missing approval risk:high",
			"Missing purpose context",
			"Blocking dependency",
		];
		const cli = f.deps.cli!;
		f.deps.cli = async <T>(args: string[], env: NodeJS.ProcessEnv) => {
			if (args[5] === "readiness") {
				const index = blocked.findIndex((row) => row.id === args[6]);
				f.control.readiness = {
					ready: index < 0,
					reasons: index < 0 ? [] : [{ detail: reasons[index]! }],
				};
			}
			const result = await cli<T>(args, env);
			if (args[5] === "dispatch-list") {
				const input = JSON.parse(args[args.indexOf("--input") + 1]!);
				return {
					data: f.items.slice(input.offset, input.offset + 3),
					pagination: { hasMore: input.offset + 3 < f.items.length },
				} as T;
			}
			return result;
		};
		const first = f.restart();
		await first.tick();
		await first.drain();
		for (const row of blocked) {
			const receipt = JSON.parse(
				readFileSync(join(f.dir, `${row.id}-${row.version}.json`), "utf8"),
			);
			expect(receipt.note).toStartWith("Error: Admission not ready:");
		}
		expect(f.releases).toHaveLength(0);
		for (let n = 4; n <= 7; n++) f.items.push(item(n));
		f.events.length = 0;
		const restarted = f.restart();
		await restarted.tick();
		await until(() => f.releases.length === 4, 1000);
		for (const release of f.releases) release();
		await restarted.drain();
		const prepared = [
			...new Set(
				f.events
					.filter((event) => event.verb === "dispatch-get")
					.map((event) => event.args[6]),
			),
		];
		expect(prepared).toEqual(
			[...f.items.slice(3), ...blocked].map((row) => row.id),
		);
		expect(
			f.events
				.filter((event) => event.verb === "start" && event.args[4] === "work")
				.map((event) => event.args[6]),
		).toEqual(f.items.slice(3).map((row) => row.id));
	});

	it("keeps the oldest waiting start first when a requested start makes a fourth, and a request starts a waiting item once", async () => {
		const f = fixture();
		for (let n = 4; n <= 6; n++) f.items.push(item(n));
		const [, , , oldest, second, asked] = f.items;
		const extra = item(7);
		// Each preparation stops at its thread until the test lets it go on.
		const began: string[] = [];
		const gates = new Map<string, () => void>();
		const thread = f.deps.thread!;
		f.deps.thread = async (repo, ...rest) => {
			const id = f.items.find((row) => repo.includes(row.id))!.id;
			began.push(id);
			await new Promise<void>((open) => gates.set(id, open));
			return thread(repo, ...rest);
		};
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => began.length === MAX_PREPARATIONS, 1000);
		// Items 4 to 6 wait. A request for a new item takes a fourth place.
		f.items.push(extra);
		await dispatcher.startRequested(extra.id);
		await until(() => began.includes(extra.id), 1000);
		// One of the first three is admitted: four were preparing, so no place
		// is free and nobody may lose a turn. Then the requested one is too.
		gates.get(began[0]!)!();
		await until(() => f.releases.length === 1, 1000);
		gates.get(extra.id)!();
		await until(() => began.length === 5, 1000);
		expect(began[4]).toBe(oldest!.id);
		// A request for a waiting item starts it now, ahead of the one before
		// it, and not a second time.
		await dispatcher.startRequested(asked!.id);
		await until(() => began.length === 6, 1000);
		expect(began[5]).toBe(asked!.id);
		for (const id of began) gates.get(id)!();
		await until(() => began.length === 7, 1000);
		gates.get(second!.id)!();
		await until(() => f.releases.length === 7, 1000);
		expect(began.filter((id) => id === asked!.id)).toHaveLength(1);
		for (const release of f.releases) release();
		await dispatcher.drain();
	});

	it("drains a delayed process identity read before fixture teardown", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.spawnPid = 999999;
		let finishIdentity!: (identity: string | undefined) => void;
		f.deps.waitForIdentity = () =>
			new Promise((done) => {
				finishIdentity = done;
			});
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		let drained = false;
		const draining = dispatcher.drain().then(() => {
			drained = true;
		});
		try {
			await until(() => f.events.some((event) => event.verb === "complete"));
			await new Promise((done) => setTimeout(done, 0));
			expect(drained).toBe(false);
			expect(existsSync(f.dir)).toBe(true);
		} finally {
			finishIdentity(undefined);
			await draining;
		}
		expect(drained).toBe(true);
	});

	it.each([
		"{",
		"null",
		'{"itemId":null}',
		...[
			{ pid: "unknown" },
			{ session: 123 },
			{ phase: ["running"] },
			{ admissionState: ["unknown"] },
			{ itemId: item(2).id },
			{ version: 3 },
		].map((fields) =>
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "running",
				...fields,
			}),
		),
	])(
		"holds unknown capacity for an invalid receipt without replaying admission: %s",
		async (contents) => {
			const f = fixture();
			const path = join(f.dir, `${item().id}-2.json`);
			writeFileSync(path, contents);
			await f.dispatcher.tick();
			await f.dispatcher.tick();
			expect(f.releases).toHaveLength(0);
			expect(f.events.some((event) => event.verb === "start")).toBe(false);
			expect(readFileSync(path, "utf8")).toBe(contents);
			expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
				"capacity is unknown",
			);
			expect(() => retainedLaneWorktree(f.dir, item().id, [])).toThrow(
				"capacity is unknown",
			);
		},
	);
	it("holds a legacy ownership receipt whose itemId is missing", async () => {
		const f = fixture();
		const path = join(f.dir, "old.json");
		const contents = JSON.stringify({
			version: 2,
			phase: "running",
			pid: process.pid,
			session: "codex:legacy",
			attemptId: "legacy-attempt",
		});
		writeFileSync(path, contents);
		await f.dispatcher.tick();
		expect(f.events.some((event) => event.verb === "dispatch-list")).toBe(
			false,
		);
		expect(f.releases).toHaveLength(0);
		expect(readFileSync(path, "utf8")).toBe(contents);
		expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
			"capacity is unknown",
		);
	});
	it("keeps an already running worker's result while corrupt ownership holds new admission", async () => {
		const f = fixture();
		const second = f.items[1]!;
		f.items.splice(1);
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.items.push(second);
		const path = join(f.dir, `${item(2).id}-2.json`);
		writeFileSync(path, "null");
		await f.dispatcher.tick();
		expect(f.releases).toHaveLength(1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.events.filter((event) => event.verb === "settle")).toHaveLength(1);
		expect(f.events.filter((event) => event.verb === "complete")).toHaveLength(
			1,
		);
		expect(readFileSync(path, "utf8")).toBe("null");
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item(2).id,
				version: 2,
				phase: "deferred",
				admissionState: "not_sent",
			}),
		);
		await f.dispatcher.tick();
		await until(() => f.releases.length === 2);
		f.releases[1]!();
		await f.dispatcher.drain();
	});
	it("ignores health metadata by filename even when it is null", async () => {
		const f = fixture();
		f.items.splice(1);
		writeFileSync(join(f.dir, "health-source.json"), "null");
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
	});
	it("does not count dispatcher health metadata as a worker in a one-slot lane", async () => {
		const parent = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 30000)"],
			{ detached: true, stdio: "ignore" },
		);
		await once(parent, "spawn");
		const f = fixture();
		f.items.splice(1);
		writeDispatcherHealthSource(f.dir, options, parent.pid);
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			expect(
				f.events.filter((event) => event.verb === "start" && event.input),
			).toHaveLength(1);
		} finally {
			for (const release of f.releases) release();
			await f.dispatcher.drain();
			const exited = once(parent, "exit");
			process.kill(-parent.pid!, "SIGTERM");
			await exited;
		}
	});
	it("admits fresh Work before a stalled historical read without replaying an unknown admission", async () => {
		const f = fixture();
		f.items.splice(2);
		const old = f.items[0]!;
		writeFileSync(
			join(f.dir, `${old.id}-2.json`),
			JSON.stringify({
				itemId: old.id,
				version: 2,
				phase: "deferred",
				admissionState: "unknown",
				session: "codex:old-session",
				executorKey: "old-executor",
			}),
		);
		let releaseHistory!: () => void;
		const history = new Promise<void>((resolve) => {
			releaseHistory = resolve;
		});
		let historicalReads = 0;
		const cli = f.deps.cli!;
		f.deps.cli = async (args, ...rest) => {
			if (args[5] === "dispatch-attempts" && args[6] === old.id) {
				historicalReads++;
				await history;
				return { data: [], nextCursor: "unavailable-history" } as never;
			}
			return cli(args, ...rest);
		};
		const dispatcher = f.restart();
		const tick = dispatcher.tick();
		try {
			await until(() => f.releases.length === 1);
			expect(
				f.events
					.filter((event) => event.verb === "start" && event.input)
					.map((event) => event.args[6]),
			).toEqual([f.items[1]!.id]);
			expect(historicalReads).toBe(0);
			const recovery = dispatcher.tick();
			await until(() => historicalReads === 1);
			expect(f.releases).toHaveLength(1);
			releaseHistory();
			await recovery;
		} finally {
			releaseHistory();
			await tick;
			await until(() => f.releases.length === 1);
			for (const release of f.releases) release();
			await dispatcher.drain();
		}
	});
	it.each(["codex", "claude-code", "opencode", "devin", "any-local"] as const)(
		"only checks Devin sign-in when %s serves Devin, and caches the check",
		async (executor) => {
			const f = fixture({ executor });
			f.items.splice(0);
			let checks = 0;
			f.deps.devinAvailability = async () => {
				checks++;
				return { available: true };
			};
			const dispatcher = f.restart();
			await dispatcher.tick();
			await dispatcher.tick();
			expect(checks).toBe(
				executor === "devin" || executor === "any-local" ? 1 : 0,
			);
		},
	);
	it("checks and renews a live Attempt in a child process", async () => {
		const confirmed = Date.now() + 60_000;
		const renewed = confirmed + 60_000;
		const watch = childLeaseWatch([], process.env, () => [
			process.execPath,
			[
				"-e",
				`
				import { createLeaseWatch, serveLeaseWatches } from ${JSON.stringify(new URL("./lane-leases.ts", import.meta.url).pathname)};
				globalThis.setInterval = (callback) => setTimeout(callback, 0);
				serveLeaseWatches(createLeaseWatch(
					async () => ({ expiresAt: new Date(${renewed}).toISOString() }),
					async () => ({
						id: "attempt", externalSessionKey: "codex:test",
						runtimeState: "running", expiresAt: new Date(${confirmed}).toISOString(),
					}),
				));
				`,
			],
		]);
		const events: Array<{ kind: string; expiry: number }> = [];
		const lease = watch(
			{
				receipt: {
					itemId: item().id,
					attemptId: "attempt",
					session: "codex:test",
				},
				expiry: Date.now(),
			},
			(event) => {
				if (event.kind === "confirmed" || event.kind === "renewed")
					events.push(event);
			},
		);
		try {
			lease.update({ spawned: true });
			await until(() => events.length === 2, 1200);
			expect(events.slice(0, 2)).toEqual([
				{ kind: "confirmed", expiry: confirmed },
				{ kind: "renewed", expiry: renewed },
			]);
		} finally {
			lease.stop();
		}
	});
	it("renews the real heartbeat while an executor child-process probe is pending", async () => {
		const f = fixture();
		f.items.splice(1);
		let heartbeat!: () => void;
		const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 60_000) heartbeat = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		const dispatcher = f.restart();
		try {
			await dispatcher.tick();
			await until(() => f.releases.length === 1);
			const { laneCommand } = await import("./lane-command");
			f.deps.available = async () => {
				await laneCommand("/bin/sleep", ["0.2"], { timeout: 2000 });
				return { available: true };
			};
			const offset = f.events.length;
			const tick = dispatcher.tick();
			setTimeout(() => heartbeat(), 20);
			await until(() =>
				f.events.slice(offset).some((e) => e.verb === "heartbeat"),
			);
			await tick;
		} finally {
			for (const done of f.releases) done();
			await dispatcher.drain();
			intervals.mockRestore();
		}
	});
	it("renews while a pickup read is blocked", async () => {
		const f = fixture();
		f.items.splice(1);
		let heartbeat!: () => void;
		const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 60_000) heartbeat = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		let release!: () => void;
		let blocked = false;
		let blockNext = false;
		const cli = f.deps.cli!;
		f.deps.createHeartbeat = (scope) => async (receipt) => {
			expect(receipt.itemId).toBe(item().id);
			expect(receipt.session).toMatch(/^codex:/);
			expect(receipt.executorKey).toBe("local-acme");
			expect(receipt.attemptId).toBe("fictional-attempt");
			return cli<{ expiresAt: string }>(
				[...scope, "work", "heartbeat", receipt.itemId],
				{
					TEDIX_AGENT_SESSION: receipt.session,
					TEDIX_EXTERNAL_AGENT: receipt.executorKey,
					TEDIX_CLI_EXPECTED_ATTEMPT_ID: receipt.attemptId,
				},
			);
		};
		f.deps.cli = async (args, ...rest) => {
			expect(args[5]).not.toBe("heartbeat");
			if (args[5] === "dispatch-list" && blockNext && !blocked) {
				blocked = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return cli(args, ...rest);
		};
		const dispatcher = f.restart();
		try {
			await dispatcher.tick();
			await until(() => f.releases.length === 1);

			const pickup = () =>
				dispatcher["call"]([
					"work",
					"dispatch-list",
					"--input",
					'{"dispatchReadyOnly":true}',
				]);
			blockNext = true;
			const first = pickup();
			await until(() => Boolean(release));
			const offset = f.events.length;
			const second = pickup();
			heartbeat();
			await until(() =>
				f.events.slice(offset).some((event) => event.verb === "heartbeat"),
			);
			release();
			await Promise.all([first, second]);
			expect(
				f.events
					.slice(offset)
					.filter((event) =>
						["dispatch-list", "heartbeat"].includes(event.verb),
					)
					.map((event) => event.verb),
			).toEqual(["heartbeat", "dispatch-list", "dispatch-list"]);
		} finally {
			release?.();
			for (const done of f.releases) done();
			await dispatcher.drain();
			intervals.mockRestore();
		}
	});
	it("runs settlement and completion before queued background reads", async () => {
		const f = fixture();
		const cli = f.deps.cli!;
		const releases: Array<() => void> = [];

		f.deps.cli = async (args, ...rest) => {
			if (releases.length < 3) {
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
			}
			return cli(args, ...rest);
		};
		const dispatcher = f.restart();
		const read = [
			"work",
			"dispatch-list",
			"--input",
			'{"dispatchReadyOnly":true}',
		];
		const current = Promise.all(
			Array.from({ length: 3 }, () => dispatcher["call"](read)),
		);
		await until(() => releases.length === 3);
		const background = dispatcher["call"](read);
		const settle = dispatcher["call"](["work", "settle", item().id]);
		const complete = dispatcher["call"](["work", "complete", item().id]);
		for (const release of releases) release();
		await Promise.all([current, background, settle, complete]);
		expect(f.events.map((event) => event.verb)).toEqual([
			"dispatch-list",
			"dispatch-list",
			"dispatch-list",
			"settle",
			"complete",
			"dispatch-list",
		]);
	});
	it("delivers a final report before queued background reads", async () => {
		const f = fixture();
		f.items.splice(1);
		const order: string[] = [];
		f.deps.observe = async () => {
			order.push("final-report");
			return {};
		};
		const launch = f.deps.launch!;
		let report: NonNullable<Parameters<typeof launch>[1]>["report"];
		f.deps.launch = (args, deps) => {
			report = deps?.report;
			return launch(args, deps);
		};
		const releases: Array<() => void> = [];
		let block = 0;
		const cli = f.deps.cli!;
		f.deps.cli = async (args, ...rest) => {
			if (block) {
				block--;
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
			}
			order.push(args[5]!);
			return cli(args, ...rest);
		};
		const dispatcher = f.restart();
		try {
			await dispatcher.tick();
			await until(() => f.releases.length === 1);
			order.length = 0;
			block = 3;
			const read = [
				"work",
				"dispatch-list",
				"--input",
				'{"dispatchReadyOnly":true}',
			];
			const current = Promise.all(
				Array.from({ length: 3 }, () => dispatcher["call"](read)),
			);
			await until(() => releases.length === 3);
			const background = dispatcher["call"](read);
			const finished = report!({ state: "done" }, options.scope);
			for (const release of releases) release();
			await Promise.all([current, background, finished]);
			expect(order).toEqual([
				"dispatch-list",
				"dispatch-list",
				"dispatch-list",
				"final-report",
				"dispatch-list",
			]);
		} finally {
			for (const release of releases) release();
			for (const done of f.releases) done();
			await dispatcher.drain();
		}
	});
	it("closes retained Work while another native worker runs without retrying optional telemetry", async () => {
		const f = fixture();
		const retained = f.items.splice(1)[0]!;
		const path = join(f.dir, `${item(2).id}-2.json`);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item(2).id,
				version: 2,
				phase: "settled",
				outcome: "succeeded",
				admissionState: "admitted",
				attemptId: "retained-attempt",
				session: "codex:retained-session",
				executorKey: "retained-executor",
				completionPending: true,
				laneResult: completedResult(item(2)),
				pendingObservation: { state: "idle" },
			}),
		);
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.items.push(retained);
			f.control.history.data = [
				{
					id: "retained-attempt",
					externalSessionKey: "codex:retained-session",
					outcome: "succeeded",
				},
			];
			await f.dispatcher.tick();
			const completion = f.events.find(
				(event) => event.verb === "complete" && event.args[6] === item(2).id,
			);
			expect(completion?.env.TEDIX_AGENT_SESSION).toBe(
				"codex:retained-session",
			);
			expect(completion?.env.TEDIX_EXTERNAL_AGENT).toBe("retained-executor");
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.completionPending).toBe(false);
			expect(saved.pendingObservation).toEqual({ state: "idle" });
			expect(saved.reportRetries).toBeUndefined();
			expect(f.releases).toHaveLength(1);
		} finally {
			for (const release of f.releases) release();
			await f.dispatcher.drain();
		}
	});
	it("retains an undeclared legacy success instead of inferring completion", async () => {
		const f = fixture();
		f.items.splice(1);
		const path = join(f.dir, `${item().id}-2.json`);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "settled",
				outcome: "succeeded",
				admissionState: "admitted",
				attemptId: "retained-attempt",
				session: "codex:retained-session",
				executorKey: "retained-executor",
			}),
		);
		f.control.history.data = [
			{
				id: "retained-attempt",
				externalSessionKey: "codex:retained-session",
				outcome: "succeeded",
			},
		];
		await f.dispatcher.tick();
		await f.dispatcher.tick();
		await f.dispatcher.drain();
		expect(f.releases).toHaveLength(0);
		const completed = f.events.find((event) => event.verb === "complete");
		expect(completed).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8")).completionPending).toBe(
			false,
		);
	});
	it("revisits one historical receipt per idle pass without starving later receipts", async () => {
		const f = fixture();
		f.items.splice(0);
		for (let n = 1; n <= 3; n++) {
			writeFileSync(
				join(f.dir, `${item(n).id}-2.json`),
				JSON.stringify({
					itemId: item(n).id,
					version: 2,
					phase: "deferred",
					admissionState: "unknown",
					session: `codex:retained-${n}`,
					executorKey: "retained-executor",
				}),
			);
		}
		// Each retained session holds a live Attempt, so every pass re-reads it.
		f.control.history.data = [1, 2, 3].map((n) => ({
			id: `retained-attempt-${n}`,
			externalSessionKey: `codex:retained-${n}`,
			outcome: null,
			metadata: { dispatchVersion: 2 },
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
		}));
		for (let n = 0; n < 4; n++) await f.dispatcher.tick();
		const reads = f.events
			.filter((event) => event.verb === "dispatch-attempts")
			.map((event) => event.args[6]);
		expect(reads).toHaveLength(4);
		expect(reads.slice(0, 3).sort()).toEqual([
			item(1).id,
			item(2).id,
			item(3).id,
		]);
		expect(reads[3]).toBe(reads[0]);
		expect(
			f.events.filter((event) => event.verb === "start" && event.input),
		).toHaveLength(0);
	});
	describe("unknown admission after a transient error", () => {
		const stuck = (f: ReturnType<typeof fixture>) => {
			const path = join(f.dir, `${item(1).id}-2.json`);
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item(1).id,
					version: 2,
					phase: "deferred",
					admissionState: "unknown",
					session: "codex:lost-session",
					executorKey: "local-acme",
					recheckAt: Date.now() - 60_000,
					note: "Database temporarily unavailable",
				}),
			);
			return path;
		};
		const admissions = (f: ReturnType<typeof fixture>) =>
			f.events.filter((event) => event.verb === "start" && event.input);
		it("re-admits the revision when no canonical Attempt exists", async () => {
			const f = fixture();
			f.items.splice(1);
			const path = stuck(f);
			await f.dispatcher.tick();
			expect(admissions(f)).toHaveLength(0);
			expect(JSON.parse(readFileSync(path, "utf8")).admissionState).toBe(
				"not_sent",
			);
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			expect(admissions(f).map((event) => event.args[6])).toEqual([item(1).id]);
			for (const release of f.releases) release();
			await f.dispatcher.drain();
		});
		it("adopts this session's live Attempt instead of admitting another", async () => {
			const f = fixture();
			f.items.splice(1);
			const path = stuck(f);
			f.control.history.data = [
				{
					id: "lost-attempt",
					externalSessionKey: "codex:lost-session",
					outcome: null,
					metadata: { dispatchVersion: 2 },
					expiresAt: new Date(Date.now() + 300_000).toISOString(),
				},
			];
			for (let n = 0; n < 3; n++) await f.dispatcher.tick();
			await f.dispatcher.drain();
			expect(admissions(f)).toHaveLength(0);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			expect(receipt.attemptId).toBe("lost-attempt");
			expect(receipt.admissionState).toBe("admitted");
		});
		it("backs off when re-resolution cannot read Attempts", async () => {
			const f = fixture();
			f.items.splice(1);
			const path = stuck(f);
			f.control.historyError = new Error("MCP tools/call error");
			for (let n = 0; n < 3; n++) await f.dispatcher.tick();
			const reads = f.events.filter(
				(event) => event.verb === "dispatch-attempts",
			);
			expect(reads).toHaveLength(1);
			expect(admissions(f)).toHaveLength(0);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			expect(receipt.admissionState).toBe("unknown");
			expect(receipt.admissionCheckFailures).toBe(1);
			expect(receipt.recheckAt).toBeGreaterThan(Date.now() + 30_000);
		});
	});
	it.each(["succeeded", "failed", "unknown admission"])(
		"neither signals an unrelated reused PID nor holds other Work for settled %s",
		async (state) => {
			const child = spawn(
				process.execPath,
				["-e", "setTimeout(() => {}, 30000)"],
				{ detached: true, stdio: "ignore" },
			);
			await once(child, "spawn");
			const f = fixture();
			if (state !== "succeeded") f.items.splice(0, 1);
			// One startable item beside the retained receipt.
			f.items.splice(state === "succeeded" ? 2 : 1);
			writeFileSync(
				join(f.dir, `${item(1).id}-2.json`),
				JSON.stringify({
					itemId: item(1).id,
					version: 2,
					phase: "settled",
					outcome: state === "unknown admission" ? "succeeded" : state,
					admissionState:
						state === "unknown admission" ? "unknown" : "admitted",
					pid: child.pid,
					processIdentity: "previous-process-birth",
					session: "codex:previous-session",
					attemptId: "previous-attempt",
					executorKey: "previous-executor",
					completionPending: state === "succeeded",
					laneResult: completedResult(item(1)),
				}),
			);
			const signals = spyOn(process, "kill");
			try {
				await f.dispatcher.tick();
				// Other ready Work starts; only an uncertain admission is re-read.
				await until(() => f.releases.length === 1);
				expect(
					f.events.filter(
						(event) =>
							event.verb === "dispatch-attempts" &&
							event.args[6] === item(1).id,
					),
				).toHaveLength(state === "unknown admission" ? 1 : 0);
				if (state === "succeeded") {
					for (const release of f.releases) release();
					await f.dispatcher.drain();
					f.items.splice(1);
					f.control.history.data = [
						{
							id: "previous-attempt",
							externalSessionKey: "codex:previous-session",
							outcome: "succeeded",
							metadata: { dispatchVersion: 2 },
						},
					];
					await f.dispatcher.tick();
					expect(
						f.events.filter(
							(event) =>
								event.verb === "complete" && event.args[6] === item(1).id,
						),
					).toHaveLength(1);
				}
				expect(
					signals.mock.calls.filter(
						([pid, signal]) => Math.abs(pid) === child.pid && signal !== 0,
					),
				).toHaveLength(0);
			} finally {
				signals.mockRestore();
				for (const release of f.releases) release();
				await f.dispatcher.drain();
				const exited = once(child, "exit");
				process.kill(-child.pid!, "SIGTERM");
				await exited;
			}
		},
	);
	it.each([
		"outage",
		"stale",
		"missing",
		"superseded",
		"ended",
		"expired",
		"unreachable",
		"unreachable with recent activity",
	])(
		"checks server authority before stopping a child: %s",
		async (scenario) => {
			let now = 1_800_000_000_000;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			let leaseCheck!: () => void;
			let heartbeat!: () => void;
			const timer = spyOn(globalThis, "setInterval").mockImplementation(((
				callback: () => void,
				ms: number,
			) => {
				if (ms === 1000) leaseCheck = callback;
				if (ms === 60_000) heartbeat = callback;
				return setTimeout(() => {}, 60_000);
			}) as typeof setInterval);
			const kill = spyOn(process, "kill").mockReturnValue(true);
			const f = fixture();
			f.items.splice(1);
			f.control.spawnPid = 999999;
			f.control.heartbeatError = new CliReadError(
				"Gateway unavailable",
				"GATEWAY_UNAVAILABLE",
			);
			const path = join(f.dir, `${item().id}-2.json`);
			try {
				await f.dispatcher.tick();
				await until(() => f.releases.length === 1);
				const receipt = JSON.parse(readFileSync(path, "utf8"));
				// A failed renewal is not proof the server lost the Attempt.
				now += 60_000;
				heartbeat();
				await until(() =>
					readFileSync(join(f.dir, "dispatcher.log"), "utf8").includes(
						'"event":"heartbeat-failed"',
					),
				);
				await new Promise((done) => setTimeout(done, 0));
				leaseCheck();
				expect(
					kill.mock.calls.filter(([, signal]) => signal !== 0),
				).toHaveLength(0);
				if (scenario === "stale" || scenario === "missing") {
					f.control.onAgentEvent!(now);
					f.control.heartbeatError = new CliReadError(
						scenario === "stale"
							? "STALE_ATTEMPT: no longer authoritative"
							: "Attempt not found",
						scenario === "stale" ? "CONFLICT" : "NOT_FOUND",
					);
					heartbeat();
				} else {
					f.control.history.data = [
						{
							id: scenario === "superseded" ? "replacement" : receipt.attemptId,
							externalSessionKey: receipt.session,
							runtimeState: scenario === "ended" ? "finished" : "running",
							expiresAt: new Date(
								now + (scenario === "expired" ? 0 : 600_000),
							).toISOString(),
						},
					];
					if (scenario.startsWith("unreachable"))
						f.control.historyError = new CliReadError(
							"Gateway unavailable",
							"GATEWAY_UNAVAILABLE",
						);
					now += 190_001;
					if (scenario !== "unreachable") f.control.onAgentEvent!(now);
					now += 50_000;
					leaseCheck();
				}
				if (scenario === "unreachable with recent activity") {
					await until(() =>
						readFileSync(join(f.dir, "dispatcher.log"), "utf8").includes(
							'"event":"lease-check-failed"',
						),
					);
					expect(kill).not.toHaveBeenCalledWith(-999999, "SIGTERM");
					now += 10_001;
					leaseCheck();
				}
				if (scenario === "outage") {
					await until(() =>
						readFileSync(join(f.dir, "dispatcher.log"), "utf8").includes(
							'"event":"lease-confirmed"',
						),
					);
					expect(
						kill.mock.calls.filter(([, signal]) => signal !== 0),
					).toHaveLength(0);
					expect(JSON.parse(readFileSync(path, "utf8")).interrupted).not.toBe(
						true,
					);
					f.control.heartbeatError = undefined;
					f.control.heartbeatExpiry = true;
					heartbeat();
					await until(
						() =>
							f.events.filter((event) => event.verb === "heartbeat").length ===
							2,
					);
					await new Promise((done) => setTimeout(done, 0));
					now += 1000;
					leaseCheck();
					expect(
						kill.mock.calls.filter(([, signal]) => signal !== 0),
					).toHaveLength(0);
				} else {
					await until(() =>
						kill.mock.calls.some((call) => call[1] === "SIGTERM"),
					);
					expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
						interrupted: true,
						outcome: "expired",
					});
				}
			} finally {
				f.control.historyError = undefined;
				for (const release of f.releases) release();
				await f.dispatcher.drain();
				kill.mockRestore();
				timer.mockRestore();
				clock.mockRestore();
			}
			if (scenario === "outage")
				expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe(
					"succeeded",
				);
		},
	);
	it.each([false, true])(
		"keeps renewing through a 20-minute push queue with commit reads blocked=%s",
		async (blocked) => {
			let now = 1_800_000_000_000;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			let leaseCheck!: () => void;
			let heartbeat!: () => void;
			const timer = spyOn(globalThis, "setInterval").mockImplementation(((
				callback: () => void,
				ms: number,
			) => {
				if (ms === 1000) leaseCheck = callback;
				if (ms === 60_000) heartbeat = callback;
				return setTimeout(() => {}, 60_000);
			}) as typeof setInterval);
			const kill = spyOn(process, "kill").mockReturnValue(true);
			const f = fixture();
			f.items.splice(1);
			f.items[0]!.workKind = "coding";
			f.control.spawnPid = 999999;
			f.control.heartbeatExpiry = true;
			const sha = "b".repeat(40);
			f.control.unpushedCommits = [sha];
			let finishRead: (() => void) | undefined;
			if (blocked)
				f.control.unpushedWait = new Promise((done) => {
					finishRead = () => done([sha]);
				});
			const path = join(f.dir, `${item().id}-2.json`);
			try {
				await f.dispatcher.tick();
				await until(() => f.releases.length === 1);
				for (let minute = 0; minute < 20; minute++) {
					now += 30_000;
					leaseCheck();
					now += 30_000;
					heartbeat();
					await until(
						() =>
							f.events.filter((event) => event.verb === "heartbeat").length ===
							minute + 1,
					);
					await new Promise((done) => setTimeout(done, 0));
					leaseCheck();
				}
				finishRead?.();
				await until(
					() =>
						JSON.parse(readFileSync(path, "utf8")).unpushedCommented !==
						undefined,
				);
				f.control.unpushedWait = undefined;
				const receipt = JSON.parse(readFileSync(path, "utf8"));
				expect(receipt.interrupted).not.toBe(true);
				expect(receipt.unpushedCommits).toEqual([sha]);
				expect(kill).not.toHaveBeenCalledWith(-999999, "SIGTERM");
				const comments = f.events.filter(
					(event) =>
						event.verb === "comment" &&
						event.args.some((arg) => arg.includes("Unpushed commits retained")),
				);
				expect(comments).toHaveLength(1);
				expect(comments[0]!.args.join(" ")).toContain(sha);
				expect(comments[0]!.args.join(" ")).toContain(receipt.repo);
				// The queued push lands before the native turn returns.
				f.control.unpushedCommits = [];
				f.control.commits = [sha];
				f.releases[0]!();
				await f.dispatcher.drain();
				expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
					outcome: "succeeded",
					commits: [sha],
					unpushedCommits: [],
				});
			} finally {
				finishRead?.();
				for (const release of f.releases) release();
				await f.dispatcher.drain();
				kill.mockRestore();
				timer.mockRestore();
				clock.mockRestore();
			}
		},
	);
	it("posts recovery details for interrupted commits before settlement", async () => {
		const f = fixture();
		f.config.repo = "/fictional/runner's source repo";
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		f.control.telemetryOutcome = "stopped";
		f.control.unpushedCommits = ["c".repeat(40)];
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const receipt = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		expect(receipt.unpushedCommits).toEqual(f.control.unpushedCommits);
		const commentAt = f.events.findIndex(
			(event) =>
				event.verb === "comment" &&
				event.args.some((arg) => arg.includes("Unpushed commits retained")),
		);
		expect(commentAt).toBeGreaterThanOrEqual(0);
		const comment = f.events[commentAt]!.args.join(" ");
		expect(comment).toContain(receipt.repo);
		expect(comment).toContain(f.control.unpushedCommits[0]!);
		expect(comment).toContain(
			`git fetch '/fictional/runner'\\''s source repo' 'refs/lane-evicted/${item().id}-2/repo'`,
		);
		expect(commentAt).toBeLessThan(
			f.events.findIndex((event) => event.verb === "settle"),
		);
		expect(f.control.cleanups).toBe(0);
	});
	it.each(["late timer", "lease expiry", "stopped telemetry"])(
		"records the child outcome after %s",
		async (scenario) => {
			let now = 1_800_000_000_000;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			let leaseCheck!: () => void;
			const timer = spyOn(globalThis, "setInterval").mockImplementation(((
				callback: () => void,
				ms: number,
			) => {
				if (ms === 1000) leaseCheck = callback;
				return setTimeout(() => {}, 60_000);
			}) as typeof setInterval);
			const kill = spyOn(process, "kill").mockReturnValue(true);
			const { dispatcher, items, control, releases, events, dir } = fixture();
			writeDispatcherHealthSource(dir, {
				scope: ["--workspace", "fixture", "--organization", "org_fixture"],
				executor: "codex",
			});
			items.splice(1);
			control.spawnPid = 999999;
			if (scenario === "stopped telemetry")
				control.telemetryOutcome = "stopped";
			try {
				await dispatcher.tick();
				await until(() => releases.length === 1);
				if (scenario === "lease expiry") {
					for (let tick = 0; tick < 10; tick++) {
						now += 30_000;
						leaseCheck();
					}
				} else {
					now += scenario === "late timer" ? 31_001 : 1000;
					leaseCheck();
				}
				if (scenario === "lease expiry") {
					leaseCheck();
					await until(() =>
						kill.mock.calls.some((call) => call[1] === "SIGTERM"),
					);
					leaseCheck();
					expect(kill).toHaveBeenCalledWith(-control.spawnPid, "SIGTERM");
					expect(
						kill.mock.calls.filter((call) => call[1] === "SIGTERM"),
					).toHaveLength(1);
				} else
					expect(kill).not.toHaveBeenCalledWith(-control.spawnPid, "SIGTERM");
				releases[0]!();
				await dispatcher.drain();
				const outcome = scenario === "late timer" ? "succeeded" : "expired";
				const receipt = JSON.parse(
					readFileSync(join(dir, `${item().id}-2.json`), "utf8"),
				);
				expect(receipt.outcome).toBe(outcome);
				const health = JSON.parse(
					readFileSync(join(dir, "health-source.json"), "utf8"),
				);
				expect(
					health.reliability.events.filter(
						(event: { kind: string }) => event.kind === "supervisor_kill",
					),
				).toHaveLength(scenario === "lease expiry" ? 1 : 0);
				if (scenario === "late timer") {
					expect(receipt.interrupted).not.toBe(true);
					expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
						'"event":"lease-check-delayed"',
					);
				} else expect(receipt.interrupted).toBe(true);
				const settlement = events.find(
					(event) => event.verb === "settle",
				)!.args;
				expect(settlement[settlement.indexOf("--outcome") + 1]).toBe(outcome);
			} finally {
				for (const release of releases) release();
				await dispatcher.drain();
				kill.mockRestore();
				timer.mockRestore();
				clock.mockRestore();
			}
		},
	);
	it("kills a child that ignores SIGTERM after the lease grace period", async () => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				'process.on("SIGTERM", () => console.log("ignored")); console.log("ready"); setInterval(() => {}, 1000)',
			],
			{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		const exited = once(child, "exit");
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let leaseCheck!: () => void;
		let heartbeat!: () => void;
		const timer = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 1000) leaseCheck = callback;
			else heartbeat = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		const { dispatcher, items, control, releases, events, dir } = fixture();
		items.splice(1);
		control.spawnPid = child.pid;
		const timeouts = spyOn(globalThis, "setTimeout");
		try {
			await once(child.stdout!, "data");
			await dispatcher.tick();
			await until(() => releases.length === 1);
			const ignored = once(child.stdout!, "data");
			const offset = timeouts.mock.calls.length;
			now += 300_001;
			leaseCheck();
			expect(String((await ignored)[0])).toContain("ignored");
			const receiptPath = join(dir, `${item().id}-2.json`);
			expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
				interrupted: true,
				outcome: "expired",
				phase: "running",
			});
			for (let tick = 0; tick < 10; tick++) {
				leaseCheck();
				heartbeat();
			}
			expect(events.some((event) => event.verb === "heartbeat")).toBe(false);
			expect(child.signalCode).toBeNull();
			const escalation = timeouts.mock.calls
				.slice(offset)
				.filter(([, delay]) => delay === 5_000);
			expect(escalation).toHaveLength(1);
			escalation[0]![0]();
			const [code, signal] = await exited;
			expect(code).toBeNull();
			expect(signal).toBe("SIGKILL");
			releases[0]!();
			await dispatcher.drain();
			expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
				interrupted: true,
				outcome: "expired",
			});
			const log = readFileSync(join(dir, "dispatcher.log"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(log.filter((row) => row.event === "lease-expired")).toHaveLength(
				1,
			);
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				process.kill(-child.pid!, "SIGKILL");
			await exited;
			for (const release of releases) release();
			await dispatcher.drain();
			timeouts.mockRestore();
			timer.mockRestore();
			clock.mockRestore();
		}
	}, 15_000);
	it.each(["admission", "crash"])(
		"leaves repeated %s failures to server admission across restarts",
		async (stage) => {
			const f = fixture();
			f.items.splice(1);
			f.control.uniqueAttempts = true;
			if (stage === "admission")
				f.control.startError = new CliReadError(
					"Admission refused: capacity",
					"CONFLICT",
				);
			else {
				f.control.exitCode = 1;
				f.control.telemetryOutcome = "failed";
				f.control.declareCompleted = false;
				f.control.finalMessage = "stream disconnected before completion";
			}
			for (let n = 1; n <= 4; n++) {
				const runner = f.restart();
				await runner.tick();
				if (stage === "crash") {
					await until(() => f.releases.length === n);
					f.releases[n - 1]!();
				}
				await runner.drain();
				expect(
					f.events.filter((e) => e.verb === "start" && e.input),
				).toHaveLength(n);
				const saved = JSON.parse(
					readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
				);
				expect(saved.held).not.toBe(true);
				for (const field of [
					"retries",
					"retryAt",
					"retryDeadlineAt",
					"identicalFailures",
					"runRetryAt",
					"runFailureCounted",
					"admissionFailure",
					"admissionFailureSignature",
					"runFailureSignature",
				])
					expect(saved[field]).toBeUndefined();
			}
			f.control.startError = new CliReadError(
				"Lane retry budget exhausted",
				"CONFLICT",
			);
			const runner = f.restart();
			await runner.tick();
			await runner.drain();
			expect(f.releases).toHaveLength(stage === "crash" ? 4 : 0);
			expect(
				f.events.filter(
					(e) =>
						e.verb === "comment" &&
						e.args.some((arg) => arg.includes("Three identical")),
				),
			).toHaveLength(0);
		},
	);
	it.each([
		[
			"devin",
			"Session 'foggy-eggnog' is already open in another process (PID 27850)",
			true,
		],
		["devin", "Devin authentication failed", false],
		[
			"codex",
			"Session 'foggy-eggnog' is already open in another process (PID 27850)",
			false,
		],
	] as const)(
		"recovers only Devin session locks: %s / %s",
		async (executor, error, recover) => {
			const f = fixture({ executor });
			f.items.splice(1);
			const work = f.items[0]!;
			const repo = join(f.dir, "runs", `${work.id}-${work.version}`, "repo");
			mkdirSync(repo, { recursive: true });
			writeFileSync(
				join(f.dir, "old.json"),
				JSON.stringify({
					itemId: work.id,
					version: 1,
					phase: "settled",
					outcome: "failed",
					attemptId: "old-attempt",
					session: `${executor}:foggy-eggnog`,
					repo,
				}),
			);
			f.control.history.data = [{ id: "old-attempt", outcome: "failed" }];
			f.control.resumeError = new Error(error);
			const sessions = f.control.threadSessions;
			await f.dispatcher.tick();
			if (!recover) {
				await f.dispatcher.drain();
				expect(sessions).toEqual(["foggy-eggnog"]);
				expect(f.events.some((event) => event.verb === "start")).toBe(false);
				return;
			}
			await until(() => f.releases.length === 1);
			expect(sessions).toEqual(["foggy-eggnog", undefined]);
			const starts = f.events.filter(
				(event) => event.verb === "start" && event.args[4] === "work",
			);
			expect(starts).toHaveLength(1);
			const admission = starts[0]!;
			expect(admission.env.TEDIX_AGENT_SESSION).not.toBe("devin:foggy-eggnog");
			const note = f.events.find((event) => event.verb === "comment")!;
			expect(note.args.at(-1)).toContain("held by another process");
			expect(note.env.TEDIX_AGENT_SESSION).toBe(
				admission.env.TEDIX_AGENT_SESSION,
			);
			expect(f.events.some((event) => event.verb === "settle")).toBe(false);
			f.releases[0]!();
			await f.dispatcher.drain();
			const settlements = f.events.filter((event) => event.verb === "settle");
			expect(settlements).toHaveLength(1);
			expect(settlements[0]!.args).toContain("succeeded");
			expect(settlements[0]!.env.TEDIX_AGENT_SESSION).toBe(
				admission.env.TEDIX_AGENT_SESSION,
			);
		},
	);
	it("admits and settles Devin through the same dispatcher", async () => {
		const { dispatcher, events, releases, control } = fixture({
			executor: "devin",
		});
		await dispatcher.tick();
		await until(() => releases.length === 3);
		expect(
			events.find((event) => event.verb === "start")?.env.TEDIX_AGENT_SESSION,
		).toStartWith("devin:");
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((event) => event.verb === "settle")).toHaveLength(3);
		expect(control.installed).toHaveLength(3);
	});
	it("posts Devin notes only to the admitted Work using its own fenced identity", async () => {
		const f = fixture({ executor: "devin" });
		f.items.splice(1);
		f.control.deliverNote = "Actual requested paragraph.";
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const comment = f.events.find((event) => event.verb === "comment")!;
		expect(comment.args.slice(4)).toEqual([
			"work",
			"comment",
			f.items[0]!.id,
			"--body",
			f.control.deliverNote,
		]);
		const admission = f.events.find(
			(event) => event.verb === "start" && event.args[4] === "work",
		)!;
		expect(comment.env.TEDIX_AGENT_SESSION).toBe(
			admission.env.TEDIX_AGENT_SESSION,
		);
		expect(comment.env.TEDIX_EXTERNAL_AGENT).toBe(
			admission.env.TEDIX_EXTERNAL_AGENT,
		);
		expect(f.events.slice(0, f.events.indexOf(comment)).at(-1)?.verb).toBe(
			"dispatch-attempts",
		);
		const reads = f.events.filter(
			(event) =>
				["dispatch-get", "dispatch-attempts"].includes(event.verb) &&
				event.env.TEDIX_AGENT_SESSION?.startsWith("devin:"),
		);
		expect(reads).toHaveLength(8);
		for (const read of reads) {
			expect(read.args[6]).toBe(f.items[0]!.id);
			expect(read.env.TEDIX_AGENT_SESSION).toBe(
				admission.env.TEDIX_AGENT_SESSION,
			);
			expect(read.env.TEDIX_EXTERNAL_AGENT).toBe(
				admission.env.TEDIX_EXTERNAL_AGENT,
			);
		}
	});
	it.each([
		["failed", 0],
		["succeeded", 1],
	] as const)(
		"does not settle success with telemetry %s and exit %s",
		async (outcome, exit) => {
			const f = fixture();
			f.items.splice(1);
			f.control.telemetryOutcome = outcome;
			f.control.exitCode = exit;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
			const args = f.events.find((event) => event.verb === "settle")!.args;
			expect(args[args.indexOf("--outcome") + 1]).toBe("failed");
		},
	);
	it("does not create a child or admit Work when Devin dependency installation fails", async () => {
		const { dispatcher, events, releases, control } = fixture({
			executor: "devin",
		});
		control.installError = new Error("Frozen lockfile install failed");
		await dispatcher.tick();
		await dispatcher.drain();
		expect(releases).toHaveLength(0);
		expect(events.some((event) => event.verb === "start")).toBe(false);
	});
	it.each([
		"Devin is logged out",
		"Devin auth status probe timed out after 30000 ms",
	])("leaves Devin work unclaimed and logs %s", async (reason) => {
		const { dispatcher, events, releases, dir } = fixture({
			executor: "devin",
			devinReady: false,
			devinReason: reason,
		});
		await dispatcher.tick();
		await dispatcher.drain();
		expect(releases).toHaveLength(0);
		expect(events.some((event) => event.verb === "start")).toBe(false);
		expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(reason);
	});
	it("admits only explicit server selections when serving coordinated Work across projects", async () => {
		const { dispatcher, events, releases } = fixture({ coordinated: true });
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "settle")).toHaveLength(1);
		expect(
			dispatchSkip(
				{
					...item(),
					metadata: { executor: "codex", laneDispatch: { state: "held" } },
				},
				[],
				"codex",
				true,
			),
		).toContain("no ready");
		expect(dispatchSkip(item(), [], "codex", false)).toBeUndefined();
	});
	it("accepts only shift-assigned proposals with a Done when section when asked to", async () => {
		const shift = {
			...item(7),
			disposition: "proposed" as const,
			description:
				"Full suite hourly is red.\n\n## Done when\nFull suite hourly is green again on main.\n",
		};
		const bare = { ...item(8), disposition: "proposed" as const };
		const other = {
			...shift,
			id: item(9).id,
			metadata: { executor: "devin" },
		};
		expect(proposedAcceptance(shift, "codex")).toBe(
			"Full suite hourly is green again on main.",
		);
		expect(proposedAcceptance(bare, "codex")).toBeUndefined();
		expect(proposedAcceptance(other, "codex")).toBeUndefined();
		expect(proposedAcceptance(other, "any-local")).toBe(
			"Full suite hourly is green again on main.",
		);
		expect(proposedAcceptance(item(), "codex")).toBeUndefined();
		expect(
			proposedAcceptance({ ...shift, accountableOwnerId: null }, "codex"),
		).toBeUndefined();
		const silent = fixture({ proposed: [shift, bare, other] });
		await silent.dispatcher.tick();
		await until(() => silent.releases.length === 3);
		for (const release of silent.releases) release();
		await silent.dispatcher.drain();
		expect(silent.events.some((e) => e.verb === "accept")).toBe(false);
		const { dispatcher, events, releases } = fixture({
			acceptProposed: true,
			proposed: [shift, bare, other],
		});
		await dispatcher.tick();
		await until(() => releases.length === 3);
		await dispatcher.tick();
		for (const release of releases) release();
		await dispatcher.drain();
		const accepts = events.filter((e) => e.verb === "accept");
		expect(accepts).toHaveLength(1);
		expect(accepts[0]!.args.slice(6)).toEqual([
			shift.id,
			"--done-when",
			"Full suite hourly is green again on main.",
		]);
		expect(accepts[0]!.env.TEDIX_AGENT_SESSION).toBeUndefined();
		expect(() =>
			parseServeOptions(["--executor", "codex", "--accept-proposed"], {
				TEDIX_WORKSPACE: "acme",
				TEDIX_ORGANIZATION: "org_acme",
			} as never),
		).toThrow("--accept-proposed requires --project");
	});
	it("admits the native Claude identity before launch and settles through the same dispatcher", async () => {
		const { dispatcher, events, releases } = fixture({
			executor: "claude-code",
		});
		await dispatcher.tick();
		await until(() => releases.length === 3);
		const bootstrap = events.filter((e) => e.verb === "start" && !e.input);
		expect(bootstrap[0]?.env.TEDIX_AGENT_SESSION).toMatch(
			/^claude-code:33333333/,
		);
		expect(
			events.find((e) => e.verb === "dispatch-list")?.input?.executor,
		).toBe("claude-code");
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "settle")).toHaveLength(3);
	});
	it("starts other ready Work beside a retained live process group after restart", async () => {
		const child = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 30000)"],
			{ detached: true, stdio: "ignore" },
		);
		await once(child, "spawn");
		const { restart, deps, dir, releases, events } = fixture();
		const history = [
			{
				id: "retained-attempt",
				externalSessionKey: "codex:retained",
				outcome: null,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
			},
		];
		const cli = deps.cli!;
		deps.cli = async (args, ...rest) => {
			const response = await cli(args, ...rest);
			return args[5] === "dispatch-attempts" && args[6] === item(1).id
				? ({ data: history, nextCursor: null } as never)
				: (response as never);
		};
		const dispatcher = restart();
		writeFileSync(
			join(dir, `${item(1).id}-2.json`),
			JSON.stringify({
				itemId: item(1).id,
				version: 2,
				phase: "running",
				pid: child.pid,
				processIdentity: "deliberately-foreign",
				session: "codex:retained",
				attemptId: "retained-attempt",
			}),
		);
		try {
			await dispatcher.tick();
			await until(() => releases.length === 2);
			// After the first pass declares its rules, the retained run is read.
			expect(
				events.find((event) => !["runner-rules", "show"].includes(event.verb))!
					.verb,
			).toBe("dispatch-attempts");
			await dispatcher.tick();
			// The retained item keeps its run; every other ready item started.
			expect(releases).toHaveLength(2);
			expect(
				events.filter(
					(event) =>
						event.verb === "dispatch-attempts" && event.args[6] === item(1).id,
				),
				// The live lease is read once, then again only when it runs out.
			).toHaveLength(1);
			for (const release of releases) release();
			await dispatcher.drain();
		} finally {
			const exited = once(child, "exit");
			process.kill(-child.pid!, "SIGTERM");
			await exited;
		}
	});
	it("still starts Work on the inherited rules when the organization's rules skill is archived", async () => {
		const { dispatcher, events, releases, control, dir } = fixture();
		control.rulesState = "archived";
		await dispatcher.tick();
		await until(() => releases.length === 3);
		const start = events.find(
			(event) => event.verb === "start" && event.input,
		)!;
		expect(start.input?.metadata).toEqual({
			dispatchVersion: 2,
			runnerRulesVersion: 3,
		});
		expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
			"is archived: runs start with the shared runner rules only",
		);
		for (const release of releases) release();
		await dispatcher.drain();
	});
	it("starts every ready item, claims the native child before launch and persists settlement", async () => {
		const { dispatcher, events, releases, dir } = fixture();
		await dispatcher.tick();
		await until(() => releases.length === 3);
		await dispatcher.tick();
		expect(releases).toHaveLength(3);
		const starts = events.filter(
			(event) => event.verb === "start" && event.input,
		);
		expect(starts).toHaveLength(3);
		expect(starts[0]!.env.TEDIX_AGENT_SESSION).toMatch(/^codex:33333333/);
		expect(starts[0]!.env.TEDIX_EXTERNAL_AGENT).toBe("local-acme");
		expect(starts[0]!.input).toMatchObject({
			metadata: {
				dispatchVersion: 2,
				runnerRulesVersion: 3,
				rulesRevision: 7,
			},
		});
		for (const release of releases) release();
		await dispatcher.drain();
		expect(events.filter((event) => event.verb === "settle")).toHaveLength(3);
		expect(
			events.find((event) => event.verb === "settle")!.input,
		).toMatchObject({
			metadata: {
				usage: { input: 100, cached: 40, output: 30, reasoning: 10 },
			},
		});
		expect(
			JSON.parse(readFileSync(join(dir, `${item(1).id}-2.json`), "utf8")).phase,
		).toBe("settled");
	});
	it("completes a successful result under its original session and retains a denied completion for retry", async () => {
		const { dispatcher, items, control, events, releases, dir } = fixture();
		items.splice(1);
		control.completeError = new Error("Completion unavailable");
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({
			phase: "settled",
			outcome: "succeeded",
			completionPending: true,
			completionRetries: 1,
		});
		const complete = events.find((e) => e.verb === "complete")!;
		const settle = events.find((e) => e.verb === "settle")!;
		expect(complete.env.TEDIX_AGENT_SESSION).toBe(
			settle.env.TEDIX_AGENT_SESSION,
		);
		expect(events.indexOf(complete)).toBeGreaterThan(events.indexOf(settle));
		control.completeError = undefined;
		control.history.data = [
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: "succeeded",
			},
		];
		saved.completionRetryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		await dispatcher.tick();
		expect(JSON.parse(readFileSync(path, "utf8")).completionPending).toBe(
			false,
		);
		expect(releases).toHaveLength(1);
	});

	it("stops asking to complete once the server refuses this Attempt", async () => {
		const { dispatcher, items, control, events, releases, dir } = fixture();
		items.splice(1);
		control.completeError = new CliReadError(
			'Tedix CLI read failed (exit 2): {"message":"MCP tool error: FORBIDDEN: Work Item completion requires its owner or steward"}',
		);
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({
			phase: "settled",
			outcome: "succeeded",
			completionPending: false,
		});
		expect(saved.completionError).toContain("FORBIDDEN");
		saved.completionRetryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		const asks = () =>
			events.filter((e) => ["complete", "dispatch-attempts"].includes(e.verb))
				.length;
		const before = asks();
		for (let pass = 0; pass < 3; pass++) await dispatcher.tick();
		expect(asks()).toBe(before);
		expect(releases).toHaveLength(1);
		// The refusal is recorded on the Work and its owner is asked, once.
		const holds = events.filter((e) => e.verb === "dispatch-hold");
		expect(holds).toHaveLength(1);
		expect(holds[0]!.input).toEqual({
			expectedWorkItemVersion: 2,
			laneDispatch: {
				state: "held",
				reason: "The agent finished, but Tedix refused to complete the task.",
				note: expect.stringContaining("FORBIDDEN"),
			},
		});
		expect(holds[0]!.env.TEDIX_AGENT_SESSION).toBeUndefined();
		const requests = events.filter((e) => e.verb === "interaction-create");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.input).toMatchObject({
			workItemId: item().id,
			kind: "input",
			notificationReason: "failure",
			requestedFrom: { type: "user", id: "fictional-owner" },
			metadata: {
				source: "lane-dispatch-blocker",
				laneBlocker: {
					kind: "execution_hold",
					executor: "codex",
					workVersion: 3,
				},
			},
		});
		expect(JSON.parse(readFileSync(path, "utf8")).holdRecorded).toBe(true);
	});

	it.each(["settling", "admitted"])(
		"closes a recovered %s success after a lost settlement reply without rerunning",
		async (phase) => {
			const f = fixture({ failSettle: true });
			f.items.splice(1);
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
			const path = join(f.dir, `${item().id}-2.json`);
			const saved = JSON.parse(readFileSync(path, "utf8"));
			saved.phase = phase;
			saved.recheckAt = 0;
			writeFileSync(path, JSON.stringify(saved));
			f.control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey: saved.session,
					outcome: "succeeded",
					metadata: { dispatchVersion: 2 },
				},
			];
			await f.restart().tick();
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				phase: "settled",
				outcome: "succeeded",
				completionPending: false,
			});
			const completions = f.events.filter((event) => event.verb === "complete");
			expect(completions).toHaveLength(1);
			expect(completions[0]!.env.TEDIX_AGENT_SESSION).toBe(saved.session);
			expect(completions[0]!.env.TEDIX_EXTERNAL_AGENT).toBe(saved.executorKey);
			expect(f.releases).toHaveLength(1);
			expect(f.events.filter((event) => event.verb === "settle")).toHaveLength(
				1,
			);
		},
	);
	it.each(["changed-version", "newer-attempt"])(
		"keeps recovered closure fenced and stops asking after %s",
		async (state) => {
			const f = fixture();
			f.items.splice(1);
			const path = join(f.dir, `${item().id}-2.json`);
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "settling",
					outcome: "succeeded",
					admissionState: "admitted",
					attemptId: "old-attempt",
					session: "codex:old-session",
					executorKey: "old-executor",
					laneResult: completedResult(),
				}),
			);
			f.control.history.data = [
				{
					id: "old-attempt",
					externalSessionKey: "codex:old-session",
					outcome: "succeeded",
					metadata: { dispatchVersion: 2 },
				},
			];
			if (state === "changed-version") {
				f.items[0]!.version = 3;
				f.items[0]!.startAt = new Date(Date.now() + 60_000).toISOString();
			} else
				f.control.history.data.unshift({
					id: "new-attempt",
					externalSessionKey: "codex:new-session",
					outcome: "succeeded",
				});
			const resumed = f.restart();
			await resumed.tick();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.completionPending).toBe(false);
			saved.completionRetryAt = 0;
			writeFileSync(path, JSON.stringify(saved));
			// The same Attempt is refused again on every retry, so it is not read.
			const reads = () =>
				f.events.filter(
					(event) =>
						["dispatch-get", "dispatch-attempts"].includes(event.verb) &&
						event.env.TEDIX_AGENT_SESSION,
				).length;
			const before = reads();
			await resumed.tick();
			expect(reads()).toBe(before);
			expect(
				f.events.filter((event) => event.verb === "complete"),
			).toHaveLength(0);
			expect(f.releases).toHaveLength(0);
		},
	);
	it.each([
		"recovered",
		"changed-version",
		"different-attempt",
		"missing-attempt",
		"completed",
		"cancelled",
		"unreadable",
	])("reconciles exhausted closure after restart: %s", async (state) => {
		const { dispatcher, restart, items, control, events, releases, dir } =
			fixture();
		items.splice(1);
		control.completeError = new Error("Completion unavailable");
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		saved.completionRetries = 5;
		saved.completionRetryAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		control.completeError = undefined;
		control.history.data = [
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: "succeeded",
			},
		];
		if (state === "changed-version") {
			items[0]!.version++;
			items[0]!.startAt = new Date(Date.now() + 60_000).toISOString();
		}
		if (state === "different-attempt")
			control.history.data[0]!.id = "another-attempt";
		if (state === "missing-attempt") control.history.data = [];
		if (state === "completed" || state === "cancelled")
			items[0]!.disposition = state;
		if (state === "unreadable") items.splice(0);
		const before = events.filter((e) => e.verb === "complete").length;
		const resumed = restart();
		await resumed.tick();
		const recovered = JSON.parse(readFileSync(path, "utf8"));
		expect(recovered.completionRetries).toBe(6);
		expect(recovered.completionPending).toBe(
			["missing-attempt", "unreadable"].includes(state),
		);
		expect(events.filter((e) => e.verb === "complete")).toHaveLength(
			before + (state === "recovered" ? 1 : 0),
		);
		expect(
			events
				.filter((e) => e.verb === "dispatch-get" && e.env.TEDIX_AGENT_SESSION)
				.at(-1)!.env.TEDIX_AGENT_SESSION,
		).toBe(saved.session);
		expect(recovered.completionRetryAt).toBeGreaterThan(
			Date.now() + 14 * 60_000,
		);
		const reads = events.length;
		await resumed.tick();
		expect(
			events
				.slice(reads)
				.some((e) => e.verb === "complete" || e.verb === "dispatch-attempts"),
		).toBe(false);
		// An unclosed result does not occupy a worker slot or relaunch the old Work.
		items.splice(0, items.length, item(2));
		await resumed.tick();
		await until(() => releases.length >= 2);
		for (const release of releases.slice(1)) release();
		await resumed.drain();
		expect(
			events.filter((e) => e.verb === "start" && e.args[6] === item().id),
		).toHaveLength(1);
	});

	it("fresh admission follows a retained lost admission without reviving its expired lease", async () => {
		const { dispatcher, restart, items, control, events, releases, dir } =
			fixture();
		items.splice(1);
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const session = "codex:33333333-3333-4333-8333-000000000099";
			const path = join(dir, `${item().id}-2.json`);
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "preparing",
					admissionState: "unknown",
					session,
					executorKey: "local-acme",
					recheckAt: 0,
					retryDeadlineAt: now + 30 * 60_000,
					note: "Retained result",
					telemetry: { finalMessage: "Retained result" },
				}),
			);
			control.history.data = [
				{
					id: "old-attempt",
					externalSessionKey: session,
					outcome: null,
					expiresAt: new Date(now - 1).toISOString(),
					metadata: { dispatchVersion: 2 },
				},
			];
			await dispatcher.tick();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({
				phase: "deferred",
				outcome: "expired",
				attemptId: "old-attempt",
			});
			expect(
				events.filter((e) => e.verb === "start" || e.verb === "settle"),
			).toHaveLength(0);
			now = Math.max(saved.recheckAt ?? 0, now) + 1;
			const resumed = restart();
			await resumed.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await resumed.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				1,
			);
			expect(JSON.parse(readFileSync(path, "utf8")).attemptId).not.toBe(
				"old-attempt",
			);
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				outcome: "succeeded",
				completionPending: false,
			});
		} finally {
			clock.mockRestore();
		}
	});

	it("re-admits a lease-expired Attempt with a retained result on the same Work revision", async () => {
		const {
			dispatcher,
			restart,
			items,
			control,
			events,
			releases,
			dir,
			briefs,
		} = fixture();
		items.splice(1);
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const session = "codex:33333333-3333-4333-8333-000000000099";
			const path = join(dir, `${item().id}-2.json`);
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "settling",
					outcome: "succeeded",
					admissionState: "admitted",
					attemptId: "old-attempt",
					session,
					executorKey: "local-acme",
					laneResult: completedResult(),
					recheckAt: 0,
					note: "Retained result",
				}),
			);
			control.history.data = [
				{
					id: "old-attempt",
					externalSessionKey: session,
					outcome: null,
					expiresAt: new Date(now - 1).toISOString(),
					metadata: { dispatchVersion: 2 },
				},
			];
			await dispatcher.tick();
			const expired = JSON.parse(readFileSync(path, "utf8"));
			expect(expired).toMatchObject({
				phase: "deferred",
				outcome: "expired",
				attemptId: "old-attempt",
			});
			// An elapsed lease is an interruption, not an identical execution
			// failure: it never feeds the hold that waits for a human edit.
			expect(expired.identicalFailures).toBeUndefined();
			expect(expired.held).not.toBe(true);
			expect(
				events.filter((e) => e.verb === "start" || e.verb === "settle"),
			).toHaveLength(0);
			// Canonical history now shows two earlier failed or expired
			// Attempts on this revision plus the retained one the sweeper
			// retired: the retained expiry must not count as a third
			// execution failure, or the same revision would hold for a
			// person instead of being re-admitted.
			const repo = join(dir, "runs", `${item().id}-2`, "repo");
			mkdirSync(repo, { recursive: true });
			const retainedSha = "d".repeat(40);
			const deferred = { ...expired, repo, unpushedCommits: [retainedSha] };
			writeFileSync(path, JSON.stringify(deferred));
			control.history.data = [
				{
					id: "earlier-failed",
					outcome: "failed",
					metadata: { dispatchVersion: 2 },
				},
				{
					id: "earlier-expired",
					outcome: "expired",
					metadata: { dispatchVersion: 2 },
				},
				{
					id: "old-attempt",
					externalSessionKey: session,
					outcome: "expired",
					expiresAt: new Date(now - 1).toISOString(),
					metadata: { dispatchVersion: 2 },
				},
			];
			// The retained commit is still in the checkout when the run ends.
			control.unpushedCommits = [retainedSha];
			now = Math.max(expired.recheckAt ?? 0, now) + 1;
			const resumed = restart();
			await resumed.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await resumed.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				1,
			);
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.attemptId).toBe("fictional-attempt");
			expect(saved.held).not.toBe(true);
			expect(briefs[0]).toContain(`Recorded unpushed commits: ${retainedSha}`);
			expect(saved.repo).toBe(repo);
			expect(saved.unpushedCommits).toEqual([retainedSha]);
		} finally {
			clock.mockRestore();
		}
	});

	it("uses a fresh OpenCode session after a proven provider stall and then picks up the next task", async () => {
		const { dispatcher, deps, items, control, events, releases, dir } = fixture(
			{
				executor: "opencode",
			},
		);
		const next = items[1]!;
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		const repo = join(dir, "runs", `${item().id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "deferred",
				admissionState: "admitted",
				attemptId: "stalled-attempt",
				session: "opencode:ses_aaaaaaaaaaaaABCDEFGHIJKLMN",
				executorKey: "local-acme",
				outcome: "failed",
				retryable: true,
				recheckAt: 0,
				retryDeadlineAt: Date.now() + 30 * 60_000,
				repo,
				baseCommit: "a".repeat(40),
				providerRecovery: {
					reason: "provider_stall",
					observedAt: new Date().toISOString(),
					safeToRetry: true,
				},
			}),
		);
		control.history.data = [
			{
				id: "stalled-attempt",
				externalSessionKey: "opencode:ses_aaaaaaaaaaaaABCDEFGHIJKLMN",
				outcome: "failed",
				metadata: { dispatchVersion: 2 },
			},
		];
		const thread = spyOn(deps, "thread");
		await dispatcher.tick();
		await until(() => releases.length === 1);
		expect(thread.mock.calls[0]?.[3]).toBeUndefined();
		releases[0]!();
		await dispatcher.drain();
		expect(
			events.filter(
				(event) => event.verb === "start" && event.args[6] === item().id,
			),
		).toHaveLength(1);

		items.splice(0, items.length, next);
		control.history.data = [];
		await dispatcher.tick();
		await until(() => releases.length === 2);
		releases[1]!();
		await dispatcher.drain();
		expect(
			events.filter(
				(event) => event.verb === "start" && event.args[6] === next.id,
			),
		).toHaveLength(1);
	});
	it.each(["expired", "terminal"])(
		"releases a tracked dead process with a %s Attempt and routes the latest revision",
		async (state) => {
			const f = fixture();
			f.items.splice(1);
			f.items[0]!.version = 3;
			const path = join(f.dir, `${item().id}-2.json`);
			const repo = join(f.dir, "runs", `${item().id}-3`, "repo");
			mkdirSync(repo, { recursive: true });
			const checkpoint = join(repo, "unfinished.txt");
			writeFileSync(checkpoint, "unfinished diff");
			const session = "codex:33333333-3333-4333-8333-000000000099";
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "running",
					admissionState: "admitted",
					attemptId: "old-attempt",
					session,
					executorKey: "local-acme",
					pid: 2_000_000_000,
					repo,
				}),
			);
			f.control.history.data = [
				{
					id: "old-attempt",
					externalSessionKey: session,
					outcome: state === "terminal" ? "expired" : null,
					expiresAt: new Date(Date.now() - 1000).toISOString(),
					metadata: { dispatchVersion: 2 },
				},
			];
			const running = Reflect.get(f.dispatcher, "running") as Map<
				string,
				Promise<void>
			>;
			running.set(item().id, new Promise(() => {}));
			await f.dispatcher.tick();
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				phase: "deferred",
				outcome: "expired",
			});
			expect(readFileSync(checkpoint, "utf8")).toBe("unfinished diff");
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			expect(
				readFileSync(join(f.dir, "dispatcher.log"), "utf8").match(
					/"event":"interruption-recovered"/g,
				),
			).toHaveLength(1);
			f.releases[0]!();
			await f.dispatcher.drain();
		},
	);
	it("defers an expired orphan with diagnostics and re-admits it on the next eligible pass", async () => {
		const f = fixture();
		f.items.splice(1);
		const path = join(f.dir, `${item().id}-2.json`);
		const repo = join(f.dir, "runs", `${item().id}-2`, "repo");
		const attemptId = "44444444-4444-4444-8444-444444444444";
		const nativeId = "55555555-5555-4555-8555-555555555555";
		const session = `codex:${nativeId}`;
		mkdirSync(join(dirname(repo), attemptId), { recursive: true });
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			join(dirname(repo), attemptId, "stderr-0.log"),
			"startup detail\nprovider rejected credentials\n",
		);
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)", nativeId],
			{ cwd: repo, detached: true, stdio: "ignore" },
		);
		const exited = once(child, "exit");
		try {
			await once(child, "spawn");
			// Bun emits "spawn" before exec finishes; on Linux /proc/<pid>/cmdline
			// can still be empty, which leaves no identity to reap the orphan by.
			let processIdentity: string | undefined;
			await until(
				() =>
					(processIdentity = laneProcessIdentity(child.pid!, session, repo)) !==
					undefined,
			);
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "running",
					admissionState: "admitted",
					attemptId,
					session,
					executorKey: "local-acme",
					pid: child.pid,
					processIdentity,
					repo,
					retryDeadlineAt: Date.now() + 30 * 60_000,
				}),
			);
			f.control.history.data = [
				{
					id: attemptId,
					externalSessionKey: session,
					outcome: "expired",
					metadata: { dispatchVersion: 2 },
				},
			];
			await f.dispatcher.tick();
			await until(() => child.exitCode !== null || child.signalCode !== null);
			const recovered = JSON.parse(readFileSync(path, "utf8"));
			expect(recovered).toMatchObject({
				phase: "deferred",
				outcome: "expired",
			});
			expect(recovered.recheckAt).toBeUndefined();
			expect(recovered.note).toContain("exit code 143");
			expect(recovered.note).toContain("provider rejected credentials");

			recovered.recheckAt = 0;
			writeFileSync(path, JSON.stringify(recovered));
			f.control.history.data = [];
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			expect(
				f.events.filter((event) => event.verb === "start" && event.input),
			).toHaveLength(1);
			f.releases[0]!();
			await f.dispatcher.drain();
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await exited;
			expect(() => process.kill(child.pid!, 0)).toThrow();
		}
	});

	it.each(["dispatch-get", "agent-start"])(
		"retains interrupted checkout correlation after %s fails",
		async (failure) => {
			const { restart, deps, items, control, events, releases, dir } =
				fixture();
			items.splice(1);
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			const path = join(dir, `${item().id}-2.json`);
			const repo = join(dir, "runs", `${item().id}-2`, "repo");
			mkdirSync(repo, { recursive: true });
			const checkpoint = join(repo, "checkpoint.txt");
			writeFileSync(checkpoint, "unfinished work");
			const previous = {
				itemId: item().id,
				version: 2,
				phase: "deferred",
				outcome: "expired",
				admissionState: "admitted",
				attemptId: "old-attempt",
				repo,
				baseCommit: "b".repeat(40),
				session: "codex:33333333-3333-4333-8333-000000000099",
				executorKey: "local-acme",
				pid: 2_000_000_000,
				processIdentity: "v2:old-process",
			};
			writeFileSync(path, JSON.stringify(previous));
			control.history.data = [
				{
					id: previous.attemptId,
					externalSessionKey: previous.session,
					outcome: "expired",
					metadata: { dispatchVersion: 2 },
				},
			];
			control.cleanupRemoves = true;
			const cli = deps.cli!;
			deps.cli = async (args, env) => {
				if (
					(failure === "dispatch-get" && args[5] === "dispatch-get") ||
					(failure === "agent-start" &&
						args[4] === "agent" &&
						args[5] === "start")
				)
					throw new Error("Tedix CLI read deadline elapsed");
				return cli(args, env);
			};
			const provision = spyOn(deps, "provision");
			const thread = spyOn(deps, "thread");
			try {
				const interrupted = restart();
				await withoutReadBackoff(async () => {
					await interrupted.tick();
					await interrupted.drain();
				});
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved).toMatchObject({
					phase: "deferred",
					outcome: "expired",
					repo,
					session: previous.session,
					attemptId: previous.attemptId,
					processIdentity: previous.processIdentity,
				});
				expect(saved.pid).toBeUndefined();
				expect(control.cleanups).toBe(0);
				await interrupted.tick();
				await interrupted.drain();
				expect(readFileSync(checkpoint, "utf8")).toBe("unfinished work");
				expect(control.cleanups).toBe(0);
				expect(
					events.some((entry) =>
						["start", "heartbeat", "settle"].includes(entry.verb),
					),
				).toBe(false);
				deps.cli = cli;
				now = Math.max(saved.recheckAt ?? 0, now) + 1;
				const resumed = restart();
				await resumed.tick();
				await until(() => releases.length === 1);
				expect(provision).not.toHaveBeenCalled();
				expect(thread.mock.calls.at(-1)![0]).toBe(repo);
				expect(thread.mock.calls.at(-1)![3]).toBe(
					previous.session.slice("codex:".length),
				);
				releases[0]!();
				await resumed.drain();
				expect(JSON.parse(readFileSync(path, "utf8")).attemptId).toBe(
					"fictional-attempt",
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each(["sent-unknown", "sent-rejected", "outside-runs", "not-interrupted"])(
		"does not restore old admission correlation for %s",
		async (state) => {
			const { restart, deps, items, control, events, dir } = fixture({
				refuse: state === "sent-rejected",
			});
			items.splice(1);
			const sent = state.startsWith("sent-");
			const path = join(dir, `${item().id}-2.json`);
			const repo =
				state === "outside-runs"
					? join(dir, "elsewhere")
					: join(dir, "runs", `${item().id}-2`, "repo");
			mkdirSync(repo, { recursive: true });
			const previous = {
				itemId: item().id,
				version: 2,
				phase: "deferred",
				outcome: state === "not-interrupted" ? "failed" : "expired",
				admissionState: "admitted",
				attemptId: "old-attempt",
				repo,
				session: "codex:33333333-3333-4333-8333-000000000099",
				executorKey: "local-acme",
				processIdentity: "v2:old-process",
			};
			writeFileSync(path, JSON.stringify(previous));
			control.history.data = [
				{
					id: previous.attemptId,
					externalSessionKey: previous.session,
					outcome: "expired",
					metadata: { dispatchVersion: 2 },
				},
			];
			if (state === "sent-unknown")
				control.startError = new Error("Tedix CLI read deadline elapsed");
			if (!sent) {
				const cli = deps.cli!;
				deps.cli = async (args, env) => {
					if (args[5] === "dispatch-get")
						throw new Error("Tedix CLI read deadline elapsed");
					return cli(args, env);
				};
			}
			const dispatcher = restart();
			await withoutReadBackoff(async () => {
				await dispatcher.tick();
				await dispatcher.drain();
			});
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.attemptId).toBeUndefined();
			expect(saved.processIdentity).toBeUndefined();
			expect(saved.pid).toBeUndefined();
			expect(saved.outcome).toBe("failed");
			expect(
				events.some((entry) => ["heartbeat", "settle"].includes(entry.verb)),
			).toBe(false);
			if (sent) {
				expect(saved.session).not.toBe(previous.session);
				expect(saved.admissionState).toBe(
					state === "sent-unknown" ? "unknown" : "rejected",
				);
			} else {
				expect(saved.session).toBeUndefined();
				// The checkout an earlier run left in runs/ stays named, so its
				// work reaches the next run; the old Attempt is only remembered.
				expect(saved.repo).toBe(state === "outside-runs" ? undefined : repo);
				expect(saved.retainedAttemptId).toBe(
					state === "outside-runs" ? undefined : "old-attempt",
				);
			}
		},
	);

	it.each([
		[null, "missing"],
		["not-json", "invalid"],
		[JSON.stringify({ ...completedResult(), extra: true }), "invalid"],
		[
			JSON.stringify({ ...completedResult(), outcome: "incomplete" }),
			"invalid",
		],
	] as const)(
		"fails Codex result file %j despite successful telemetry and landed evidence",
		async (content, reason) => {
			const f = fixture();
			f.items.splice(1);
			f.control.commits = ["b".repeat(40)];
			f.control.codexResultFile = content;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
			const saved = JSON.parse(
				readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
			);
			expect(saved.outcome).toBe("failed");
			expect(saved.note).toContain(`Codex lane result file is ${reason}`);
			expect(f.events.find((event) => event.verb === "settle")!.args).toContain(
				"failed",
			);
			expect(f.events.some((event) => event.verb === "complete")).toBe(false);
		},
	);
	it("reads Codex's result file instead of a conflicting telemetry declaration", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		const commitSha = "c".repeat(40);
		const result = { ...completedResult(), commitSha };
		f.deps.landedCommits = async (_repo, _base, message) => {
			expect(message).toContain(commitSha);
			return [commitSha];
		};
		f.control.codexResultFile = JSON.stringify({
			...Object.fromEntries(
				CodexLaneResultJsonSchema.required.map((key) => [key, null]),
			),
			...result,
		});
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "incomplete", remaining: "Telemetry must not decide the result" })}`;
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await dispatcher.drain();
		expect(
			f.events.find((event) => event.verb === "settle")!.input?.metadata,
		).toMatchObject({ laneResult: result });
		expect(f.events.some((event) => event.verb === "complete")).toBe(true);
	});
	it("does not infer completion from a successful process exit", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.declareCompleted = false;
		f.control.finalMessage = "Recovery remains unverified.";
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
		expect(f.events.some((event) => event.verb === "complete")).toBe(false);
	});
	it.each([
		"Pushed the fix; checks green.",
		`Result\nTEDIX_LANE_RESULT {"outcome":"completed","extra":true}`,
	])(
		"recovers an undeclared result from the Attempt's landed commit: %s",
		async (message) => {
			const f = fixture({ executor: "claude-code" });
			f.items.splice(1);
			f.items[0]!.workKind = "coding";
			const commitSha = "b".repeat(40);
			f.control.commits = [commitSha];
			f.control.declareCompleted = false;
			f.control.finalMessage = message;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			const saved = JSON.parse(
				readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
			);
			f.control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey: saved.session,
					outcome: null,
					expiresAt: new Date(Date.now() + 300000).toISOString(),
					metadata: { dispatchVersion: 2 },
				},
			];
			f.releases[0]!();
			await f.dispatcher.drain();
			const settle = f.events.find((event) => event.verb === "settle")!;
			expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe(
				"succeeded",
			);
			expect(settle.args).toContain(commitSha);
			expect(settle.input?.metadata).toMatchObject({
				laneResult: {
					outcome: "completed",
					workItemId: item().id,
					workVersion: item().version,
					contractVersion: item().acceptanceContract!.version,
					outcomeText: item().acceptanceContract!.doneLooksLike,
				},
			});
			expect(f.events.some((event) => event.verb === "complete")).toBe(true);
		},
	);
	it.each([false, true])(
		"does not complete a push-refused run from an unlanded commit (declared=%s)",
		async (declared) => {
			const { repo, git } = gitFixture(true);
			git([
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"Unpushed fix",
			]);
			const sha = git(["rev-parse", "HEAD"]);
			const f = fixture();
			f.items.splice(1);
			f.items[0]!.workKind = "coding";
			f.control.commits = [sha];
			f.control.unpushedCommits = [sha];
			f.control.declareCompleted = declared;
			f.control.finalMessage =
				"Push refused: this change conflicts with origin/main";
			f.deps.mainCommits = (_repo, commits) => mainLaneCommits(repo, commits);
			const dispatcher = f.restart();
			await dispatcher.tick();
			await until(() => f.releases.length === 1);
			const saved = JSON.parse(
				readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
			);
			f.control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey: saved.session,
					outcome: null,
					expiresAt: new Date(Date.now() + 300000).toISOString(),
					metadata: { dispatchVersion: 2 },
				},
			];
			f.releases[0]!();
			await dispatcher.drain();
			const settle = f.events.find((event) => event.verb === "settle")!;
			expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
			expect(settle.args).not.toContain("--commit");
			expect(settle.args[settle.args.indexOf("--note") + 1]).not.toContain(
				"1 landed commit",
			);
			expect(f.events.some((event) => event.verb === "complete")).toBe(false);
			const receipt = JSON.parse(
				readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
			);
			expect(receipt.commits).toEqual([]);
			expect(receipt.unpushedCommits).toEqual([sha]);
		},
	);
	it("logs, and does not stop, an expired orphan whose identity was never recorded", async () => {
		const f = fixture();
		f.items.splice(1);
		const path = join(f.dir, `${item().id}-2.json`);
		const attemptId = "44444444-4444-4444-8444-444444444444";
		const session = "codex:55555555-5555-4555-8555-555555555555";
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		const exited = once(child, "exit");
		try {
			await once(child, "spawn");
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "running",
					admissionState: "admitted",
					attemptId,
					session,
					executorKey: "local-acme",
					pid: child.pid,
				}),
			);
			f.control.history.data = [
				{
					id: attemptId,
					externalSessionKey: session,
					outcome: "expired",
					metadata: { dispatchVersion: 2 },
				},
			];
			f.dispatcher.holdAdmissions();
			expect(await f.dispatcher.quiet()).toBe(false);
			await f.dispatcher.tick();
			await f.dispatcher.drain();
			expect(await f.dispatcher.quiet()).toBe(true);
			expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
				`No process identity was recorded for process ${child.pid} at launch; not stopped`,
			);
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
		} finally {
			child.kill("SIGKILL");
			await exited;
			expect(() => process.kill(child.pid!, 0)).toThrow();
		}
	});
	it("recovers an undeclared result from the session's result comment", async () => {
		const f = fixture({ executor: "claude-code" });
		f.items.splice(1);
		f.control.declareCompleted = false;
		f.control.finalMessage = "Result recorded in OS.";
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		const saved = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		f.control.comments.push({
			id: "delivered-note",
			workItemId: item().id,
			orgId: "99999999-9999-4999-8999-999999999999",
			authorType: "external_agent",
			authorId: saved.executorKey,
			body: "Result recorded in OS.",
			metadata: { agentSession: saved.session },
			createdAt: new Date().toISOString(),
		});
		f.control.history.data = [
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: null,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
				metadata: { dispatchVersion: 2 },
			},
		];
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
		expect(settle.input?.metadata).toMatchObject({
			laneResult: { outcome: "completed", workItemId: item().id },
		});
		expect(f.events.some((event) => event.verb === "complete")).toBe(true);
	});
	// On 15 Nov 2026 three runs of one task ended "TypeError: undefined is not
	// an object (evaluating 't.workItemId')": each cited the earlier commit
	// that had fixed it and declared no result, and the custody check read the
	// missing declaration.
	it("settles a run that cites an earlier commit without declaring a result", async () => {
		const { repo, git } = gitFixture(true);
		const originalSession = "codex:original-session";
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			`Fix\n\nWork-Item: ${item().id}\nAgent-Session: ${originalSession}`,
		]);
		const sha = git(["rev-parse", "HEAD"]);
		git(["push", "origin", "main"]);
		const f = fixture({ executor: "claude-code" });
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		f.control.declareCompleted = false;
		f.control.finalMessage = `The fix is already on origin/main as ${sha}.`;
		f.deps.baseCommit = () => sha;
		f.deps.landedCommits = (_repo, base, message, deps, recovery) =>
			landedLaneCommits(repo, base, message, deps, recovery);
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		const saved = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		f.control.history.data = [
			{
				id: saved.attemptId,
				workItemId: item().id,
				externalSessionKey: saved.session,
				outcome: null,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
				metadata: { dispatchVersion: 2 },
			},
			{
				id: "original-attempt",
				workItemId: item().id,
				externalSessionKey: originalSession,
				outcome: "succeeded",
				admissionId: "original-admission",
				startedAt: new Date(Date.now() - 60000).toISOString(),
				expiresAt: new Date(Date.now() + 60000).toISOString(),
				finishedAt: new Date(Date.now() + 60000).toISOString(),
				metadata: { dispatchVersion: 2 },
			},
		];
		f.releases[0]!();
		await dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--note") + 1]).not.toContain(
			"TypeError",
		);
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
		expect(settle.args).toContain(sha);
		expect(settle.input?.metadata).toMatchObject({
			laneResult: { outcome: "completed", workItemId: item().id },
			recoveredCommits: [{ commitSha: sha, attemptId: "original-attempt" }],
		});
	});
	// On 15 Nov 2026 runs on two tasks waited three times each on whole
	// local test suites and never pushed; nothing on the task said why.
	it("tells the agent how to land and records why commits stayed off main", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		const sha = "c".repeat(40);
		f.control.unpushedCommits = [sha];
		const reason = "The push was refused: main fails the apps/os type-check";
		f.control.finalMessage = `Committed, not pushed.\nTEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "incomplete", remaining: reason })}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		expect(f.briefs[0]).toContain(
			"run the type-check and the focused tests of what you changed, then push your commits to origin main. Do not run a whole workspace's or the whole repository's test suite locally unless this task asks for it. If the push is refused, do not wait and do not keep retrying: copy its one-sentence reason into a comment on this Work and end the run.",
		);
		f.releases[0]!();
		await f.dispatcher.drain();
		const receipt = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("rejected");
		expect(settle.args[settle.args.indexOf("--note") + 1]).toStartWith(
			`Result:\nUnlanded: 1 commit is not on origin/main (${sha}), kept in ${receipt.repo}. Reason: ${reason}.\n`,
		);
		expect(receipt.unpushedReason).toBe(`${reason}.`);
	});
	it("names the repository's own push command in the brief", () => {
		const repo = mkdtempSync(join(tmpdir(), "lane-landing-"));
		dirs.push(repo);
		expect(laneLandingBrief(repo)).toContain(
			"then push your commits to origin main.",
		);
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ scripts: { push: "bun scripts/dev/push-queue.ts" } }),
		);
		writeFileSync(join(repo, "bun.lock"), "");
		expect(laneLandingBrief(repo)).toContain(
			"then run `bun run push`, which runs the pre-push checks and puts your commits on main. Do not run a whole workspace's",
		);
	});
	// On 15 Nov 2026 a run's proof reads waited five minutes behind the
	// runner's other calls. Nothing renewed the lease meanwhile, so the server
	// recorded the run as stopped and took its task off the ready list.
	it("keeps renewing the lease while settlement collects proof", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		f.control.commits = ["a".repeat(40)];
		const renewals = new Map<unknown, () => void>();
		const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			const handle = setTimeout(() => {}, 60_000);
			if (ms === 60_000) renewals.set(handle, callback);
			return handle;
		}) as typeof setInterval);
		const cleared = spyOn(globalThis, "clearInterval").mockImplementation(((
			handle: ReturnType<typeof setTimeout>,
		) => {
			renewals.delete(handle);
			clearTimeout(handle);
		}) as typeof clearInterval);
		let proofStarted = false;
		let releaseProof!: () => void;
		f.deps.landedCommits = async () => {
			proofStarted = true;
			await new Promise<void>((resolve) => {
				releaseProof = resolve;
			});
			return f.control.commits;
		};
		const dispatcher = f.restart();
		try {
			await dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await until(() => proofStarted);
			// The run's own renewal ended with its child; one covers the proof.
			expect(renewals.size).toBe(1);
			const before = f.events.filter((e) => e.verb === "heartbeat").length;
			for (const renew of renewals.values()) renew();
			await until(
				() => f.events.filter((e) => e.verb === "heartbeat").length > before,
			);
			expect(f.events.some((event) => event.verb === "settle")).toBe(false);
			releaseProof();
			await dispatcher.drain();
			expect(renewals.size).toBe(0);
			const verbs = f.events.map((event) => event.verb);
			expect(verbs.lastIndexOf("heartbeat")).toBeLessThan(
				verbs.indexOf("settle"),
			);
		} finally {
			releaseProof?.();
			intervals.mockRestore();
			cleared.mockRestore();
		}
	});
	it("fails an undeclared result that left no Attempt evidence", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.declareCompleted = false;
		f.control.finalMessage = "Result recorded in OS.";
		f.control.comments.push({
			id: "foreign-note",
			workItemId: item().id,
			orgId: "99999999-9999-4999-8999-999999999999",
			authorType: "external_agent",
			authorId: "another-executor",
			body: "Result recorded in OS.",
			metadata: { agentSession: "codex:another-session" },
			createdAt: new Date().toISOString(),
		});
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
		expect(f.events.some((event) => event.verb === "complete")).toBe(false);
	});
	it("keeps an explicitly incomplete coding result open despite its landed commit", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		f.control.commits = ["a".repeat(40)];
		f.control.finalMessage = `Partial result\nTEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "incomplete", remaining: "Live acceptance remains unverified" })}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("rejected");
		expect(settle.args).toContain("a".repeat(40));
		expect(f.events.some((event) => event.verb === "complete")).toBe(false);
	});
	// On 21 Nov 2026 verifiers without a browser or connections.admin reported
	// landed_unverified; each was settled failed and verified again, twice.
	it.each(["verified", "refuted", "inconclusive", "blocked"] as const)(
		"dispatches a verify-only Attempt after deploy and handles a %s result",
		async (verdict) => {
			const f = fixture();
			f.items.splice(1);
			const work = f.items[0]!;
			work.workKind = "coding";
			const sha = "a".repeat(40);
			f.control.commits = [sha];
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(work), outcome: "landed_unverified", unverified: "Live readback remains open" })}`;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
			const settle = f.events.find((event) => event.verb === "settle")!;
			expect(settle.args).toContain(sha);
			expect(settle.input?.metadata).toMatchObject({
				laneResult: { outcome: "landed_unverified" },
			});

			await f.restart().tick();
			expect(f.control.deploymentChecks).toEqual([[sha]]);
			expect(work.version).toBe(2);
			expect(f.releases).toHaveLength(1);

			f.control.deployments = [
				{ url: "https://live.example.test/health", sha: "b".repeat(40) },
			];
			await f.restart().tick();
			expect(work.version).toBe(3);
			expect(f.releases).toHaveLength(1);
			const rounds = verdict === "inconclusive" ? 3 : 1;
			for (let round = 1; round <= rounds; round++) {
				const verifier = f.restart();
				await verifier.tick();
				await until(() => f.releases.length === round + 1);
				expect(f.briefs[round]).toContain("Verify-only Attempt");
				expect(f.briefs[round]).toContain("https://live.example.test/health");
				expect(f.briefs[round]).not.toContain("To land a change");
				const attempt = JSON.parse(
					readFileSync(join(f.dir, `${work.id}-${work.version}.json`), "utf8"),
				).attemptId;
				const evidence = {
					id: "verification-report",
					attemptId: verdict === "inconclusive" ? "fictional-attempt" : attempt,
					kind: "test_report",
					claimKey: "verification",
					uri: "https://live.example.test/report",
				};
				f.control.evidence.data = [evidence];
				const evidenceRefs = [evidence.id];
				f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({
					...completedResult(work),
					evidenceRefs,
					...(verdict === "refuted"
						? {
								outcome: "incomplete",
								remaining: "The live row is still absent",
							}
						: verdict === "blocked"
							? {
									outcome: "landed_unverified",
									unverified: "Open the signed-in page and confirm the row",
								}
							: {}),
				})}`;
				f.releases[round]!();
				await verifier.drain();
				if (verdict !== "verified") await f.restart().tick();
			}
			expect(
				f.events.filter((event) => event.verb === "complete"),
			).toHaveLength(verdict === "verified" ? 1 : 0);
			expect(work.disposition).toBe(
				verdict === "verified" ? "completed" : "accepted",
			);
			if (verdict === "refuted") {
				expect(work.metadata?.laneDispatch).toEqual({
					state: "ready",
					reason: "Repair after agent verification round 1",
					note: "The live row is still absent",
				});
				expect(
					f.events.filter((event) => event.verb === "settle").at(-1)?.args,
				).toContain("rejected");
			}
			if (verdict === "inconclusive")
				expect(work.metadata?.laneDispatch).toMatchObject({
					state: "held",
					reason: "Agent verification stopped after round 3",
					note: expect.stringContaining("did not cite a live test report"),
				});
			if (verdict === "blocked") {
				expect(work.metadata?.laneDispatch).toMatchObject({
					state: "held",
					reason: expect.stringContaining("Someone with that access checks it"),
					note: "Open the signed-in page and confirm the row",
				});
				const settle = f.events.filter((event) => event.verb === "settle");
				expect(settle.at(-1)?.args).toContain("cancelled");
				for (let pass = 0; pass < 2; pass++) await f.restart().tick();
				expect(f.releases).toHaveLength(2);
			}
			const requests = f.events.filter(
				(event) => event.verb === "interaction-create",
			);
			expect(requests).toHaveLength(verdict === "blocked" ? 1 : 0);
			if (verdict === "blocked")
				expect(requests[0]!.input).toMatchObject({
					prompt: expect.stringContaining(
						"Open the signed-in page and confirm the row",
					),
				});
		},
	);
	it("fails a landed but unconfirmed result that has no commit on main", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "landed_unverified", unverified: "The deploy could not be read" })}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
		expect(f.events.some((event) => event.verb === "complete")).toBe(false);
	});
	it("settles a commit proven on an allowed target repository", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		const commitSha = "b".repeat(40);
		const result = {
			...completedResult(),
			commitSha,
			repositoryProof: {
				repository: "tedix-hq/tedix-cloud-ops",
				commitSha,
				runId: 123,
				workflowName: "Tests after deploy",
			},
		};
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(result)}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.control.repositoryChecks).toEqual(["tedix-hq/tedix-cloud-ops"]);
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
		expect(settle.args).toContain(commitSha);
		expect(settle.input?.metadata).toMatchObject({
			settlement: {
				mode: "repository_commit",
				repository: "tedix-hq/tedix-cloud-ops",
				commitSha,
				runId: 123,
			},
		});
		expect(f.events.some((event) => event.verb === "complete")).toBe(true);
	});
	it("settles a result that changed nothing as succeeded when the commits it cites are already on main", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		const cited = ["b".repeat(40), "c".repeat(40)];
		f.control.finalMessage = `Already fixed on main\nTEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "landed_unverified", unverified: "Tests after deploy could not be read", existingCommits: cited })}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.control.existingChecks).toEqual([cited]);
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
		// Not `--commit`: that would record them as commits this run shipped.
		expect(settle.args).not.toContain("--commit");
		expect(settle.args[settle.args.indexOf("--note") + 1]).toContain(
			"No change was needed",
		);
		expect(settle.input?.metadata).toMatchObject({
			laneResult: { outcome: "landed_unverified", existingCommits: cited },
			settlement: {
				mode: "existing_commits",
				commitSha: cited[0],
				commitShas: cited,
			},
		});
		for (let pass = 0; pass < 3; pass++) await f.restart().tick();
		expect(f.control.deploymentChecks[0]).toEqual(cited);
		expect(f.releases).toHaveLength(1);
		expect(f.events.some((event) => event.verb === "complete")).toBe(false);
		expect(f.events.some((event) => event.verb === "interaction-create")).toBe(
			false,
		);
	});
	it("fails a result that cites existing commits the checkout cannot prove", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		f.control.existingRefusal = `${"b".repeat(12)} is not on origin/main`;
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "landed_unverified", unverified: "The deploy could not be read", existingCommits: ["b".repeat(40)] })}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
		expect(settle.args).not.toContain("--commit");
		const note = settle.args[settle.args.indexOf("--note") + 1]!;
		expect(note).toContain(
			"The result says a change landed, but no commit for it is on origin/main.",
		);
		expect(note).toContain("bbbbbbbbbbbb is not on origin/main");
		expect(settle.input?.metadata).not.toHaveProperty("settlement");
	});
	it("keeps a no-change result for a later check while origin cannot be read", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.proofError = new LaneCommitFetchError("origin is unreachable");
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), outcome: "landed_unverified", unverified: "The deploy could not be read", existingCommits: ["b".repeat(40)] })}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.events.some((event) => event.verb === "settle")).toBe(false);
	});
	it.each(["completed", "incomplete"] as const)(
		"preserves %s commit/evidence declarations on the admitted Work and Attempt",
		async (outcome) => {
			const f = fixture();
			f.items.splice(1);
			f.items[0]!.workKind = "coding";
			const commitSha = "a".repeat(40);
			const result = {
				...completedResult(),
				outcome,
				...(outcome === "incomplete"
					? { remaining: "Live proof remains unknown" }
					: {}),
				commitSha,
				evidenceRefs: ["44444444-4444-4444-8444-444444444444"],
			};
			f.control.commits = [commitSha];
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(result)}`;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			const path = join(f.dir, `${item().id}-2.json`);
			const admitted = JSON.parse(readFileSync(path, "utf8"));
			f.releases[0]!();
			await f.dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			const settle = f.events.find((event) => event.verb === "settle")!;
			expect(saved.laneResult).toEqual(result);
			expect(saved.itemId).toBe(admitted.itemId);
			expect(saved.attemptId).toBe(admitted.attemptId);
			expect(saved.session).toBe(admitted.session);
			expect(saved.executorKey).toBe(admitted.executorKey);
			expect(settle.args[6]).toBe(admitted.itemId);
			expect(settle.env.TEDIX_AGENT_SESSION).toBe(admitted.session);
			expect(settle.env.TEDIX_EXTERNAL_AGENT).toBe(admitted.executorKey);
			expect(settle.input?.metadata).toMatchObject({
				laneResult: result,
				session: admitted.session,
			});
			expect(settle.args).toContain(commitSha);
			expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe(
				outcome === "completed" ? "succeeded" : "rejected",
			);
			expect(
				f.events.filter(
					(event) => event.verb === "start" && event.args[4] === "work",
				),
			).toHaveLength(1);
			expect(f.events.some((event) => event.verb === "complete")).toBe(
				outcome === "completed",
			);
		},
	);
	it("does not use a declared commit as verified landed proof", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		const result = {
			...completedResult(),
			commitSha: "a".repeat(40),
			evidenceRefs: ["unverified-ref"],
		};
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(result)}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args).not.toContain("--commit");
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
		expect(settle.input?.metadata).toMatchObject({ laneResult: result });
		expect(f.events.some((event) => event.verb === "complete")).toBe(false);
	});
	it.each([
		{ workItemId: item(2).id },
		{ workVersion: 3 },
		{ contractVersion: 2 },
		{ outcomeText: "An earlier accepted outcome" },
	])(
		"rejects a stale or foreign completion declaration: %j",
		async (mismatch) => {
			const f = fixture();
			f.items.splice(1);
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(), ...mismatch })}`;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
			expect(f.events.some((event) => event.verb === "complete")).toBe(false);
			expect(f.events.find((event) => event.verb === "settle")!.args).toContain(
				"failed",
			);
		},
	);
	it("settles result notes starting with a bullet through the real option parser", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		control.finalMessage = "- SHA256: digest\n- Work result recorded";
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settle = events.find((event) => event.verb === "settle")!;
		expect(parseOptions(settle.args).options.workNote).toBe(
			`Result:\n${control.finalMessage}\nTEDIX_LANE_RESULT ${JSON.stringify(completedResult())}`,
		);
	});

	it("prefixes matching lessons before launching Codex without relying on hooks", async () => {
		const { dispatcher, items, control, recalls, briefs, releases } = fixture();
		items.splice(1);
		control.recall =
			"Tedix situational recall (advisory):\n- [lesson deadbeef] Keep product bindings aligned with the production overlay.";

		await dispatcher.tick();
		await until(() => releases.length === 1);

		expect(recalls).toEqual([
			{
				brief: expect.stringContaining(`Work ${item().id}`),
				scope: options.scope,
				harness: "codex",
				cwd: expect.stringContaining("/repo"),
			},
		]);
		expect(briefs[0]).toStartWith(control.recall);
		expect(briefs[0]).toContain("Your exclusive source worktree is");
		expect(briefs[0]).toContain(
			"Add outcome=completed only when the entire accepted outcome happened",
		);
		expect(briefs[0]).not.toContain(
			"If no new source change is needed, append exactly one TEDIX_LANE_RESULT",
		);
		releases[0]!();
		await dispatcher.drain();
	});
	it.each(["quota", "backoff"])(
		"waits through routing %s pauses without reads and resumes when capacity returns",
		async (pause) => {
			const executor = pause === "quota" ? "claude-code" : "codex";
			const { restart, deps, items, events, releases, dir } = fixture({
				executor,
			});
			items.splice(1);
			let now = Date.now();
			const capacityUntil = now + 60 * 60_000;
			let capacityReturned = false;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			deps.budgets = () => ({
				[executor]: {
					observedAt: now,
					source: "native",
					remainingPercent: capacityReturned
						? 90
						: pause === "quota"
							? 10
							: undefined,
					resetAt: capacityUntil,
					backoffUntil:
						pause === "backoff" && !capacityReturned
							? capacityUntil
							: undefined,
				},
			});
			const path = join(dir, `${item().id}-2.json`);
			const dispatcher = restart();
			try {
				for (let n = 1; n <= 3; n++) {
					await dispatcher.tick();
					await dispatcher.drain();
					expect(existsSync(path)).toBe(false);
					expect(
						events.some((event) =>
							["dispatch-get", "start", "heartbeat", "settle"].includes(
								event.verb,
							),
						),
					).toBe(false);
					now += 60_000 * 2 ** (n - 1);
				}
				capacityReturned = true;
				if (pause === "backoff") now = capacityUntil + 1;
				await dispatcher.tick();
				await until(() => releases.length === 1);
				releases[0]!();
				await dispatcher.drain();
				expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe(
					"succeeded",
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each([
		["codex", "network.websocket_reachability: connection refused"],
		[
			"claude-code",
			"Claude reported a plugin error (review-plugin: load-failed)",
		],
	] as const)(
		"pauses %s pickup through pre-flight backoff and resumes after recovery",
		async (executor, reason) => {
			const { restart, deps, items, events, releases, dir } = fixture({
				executor,
			});
			items.splice(1);
			let now = Date.now();
			let healthy = false;
			const probe = spyOn(deps, "preflight").mockImplementation(async () =>
				healthy ? undefined : reason,
			);
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			const dispatcher = restart();
			const path = join(dir, `${item().id}-2.json`);
			try {
				await dispatcher.tick();
				now += 29_999;
				await dispatcher.tick();
				expect(probe.mock.calls).toEqual([[executor, expect.any(String)]]);
				now++;
				await dispatcher.tick();
				now += 59_999;
				await dispatcher.tick();
				expect(probe).toHaveBeenCalledTimes(2);
				expect(
					events.some((event) =>
						["dispatch-get", "readiness", "start", "settle"].includes(
							event.verb,
						),
					),
				).toBe(false);
				expect(existsSync(path)).toBe(false);
				const log = readFileSync(join(dir, "dispatcher.log"), "utf8");
				expect(
					log.split("\n").filter((line) => line.includes(reason)),
				).toHaveLength(1);
				expect(log).toContain("executor-preflight-failed");

				healthy = true;
				now++;
				await dispatcher.tick();
				await until(() => releases.length === 1);
				releases[0]!();
				await dispatcher.drain();
				await dispatcher.tick();
				expect(probe).toHaveBeenCalledTimes(3);
				expect(
					events.filter(
						(event) => event.verb === "start" && event.args[4] === "work",
					),
				).toHaveLength(1);
				expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe(
					"succeeded",
				);
			} finally {
				probe.mockRestore();
				clock.mockRestore();
			}
		},
	);

	it("waits out a timed-out version probe without a failed run and logs it once", async () => {
		const { restart, deps, items, events, releases, dir } = fixture();
		items.splice(1);
		let busy = true;
		deps.available = (executor) =>
			busy && executor === "codex"
				? {
						available: false,
						transient: true,
						reason: "codex --version timed out twice",
					}
				: { available: true };
		const path = join(dir, `${item().id}-2.json`);
		const dispatcher = restart();
		for (let n = 1; n <= 4; n++) {
			await dispatcher.tick();
			await dispatcher.drain();
			expect(existsSync(path)).toBe(false);
		}
		expect(
			events.some((event) =>
				["dispatch-get", "start", "comment", "settle"].includes(event.verb),
			),
		).toBe(false);
		const logged = readFileSync(join(dir, "dispatcher.log"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			logged.filter(
				(row) =>
					row.event === "executor-probe-slow" &&
					row.reason === "codex --version timed out twice",
			),
		).toHaveLength(1);
		expect(
			logged.filter((row) => row.event === "skipped" && row.itemId),
		).toHaveLength(1);
		expect(logged.some((row) => /fail/.test(row.event))).toBe(false);
		busy = false;
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe("succeeded");
	});

	it.each(["research", "coding"] as const)(
		"leaves a %s lane's rejected verdict to the server instead of holding it locally",
		async (workKind) => {
			const { dispatcher, items, events, control, releases } = fixture();
			items.splice(1);
			items[0]!.workKind = workKind;
			control.history.data = [
				{
					id: "verdict-attempt",
					outcome: "rejected",
					metadata: {
						dispatchVersion: 2,
						laneResult: { outcome: "incomplete", remaining: "Gap found" },
					},
				},
			];
			await dispatcher.tick();
			// Admission is the server's call, so the dispatcher still asks.
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				1,
			);
		},
	);
	it("retries native preparation timeouts after restart, including a legacy held receipt", async () => {
		const { dispatcher, restart, dir, items, events, control, releases } =
			fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		control.threadError = new DOMException(
			"The operation timed out.",
			"TimeoutError",
		);
		for (let n = 1; n <= 3; n++) {
			await dispatcher.tick();
			await dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.held).not.toBe(true);
			expect(saved.attemptId).toBeUndefined();
			expect(saved.recheckAt).toBeUndefined();
			saved.recheckAt = 0;
			saved.identicalFailures = 3;
			saved.held = n === 3;
			writeFileSync(path, JSON.stringify(saved));
		}
		control.threadError = undefined;
		const recovered = restart();
		await recovered.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await recovered.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(1);
		expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe("succeeded");
	});
	it("keeps an uncertain bootstrap admission fenced without holding while owner approval is pending", async () => {
		const { dispatcher, dir, items, events, control } = fixture();
		items.splice(1);
		const path = join(dir, `${item().id}-2.json`);
		for (let n = 1; n <= 4; n++) {
			control.startError = new CliReadError(
				'Tedix CLI read failed (exit 1): Error: External-agent bootstrap is waiting for owner approval 45fe93d1-eba1-4f72-bf95-36842a9693b7 for principal "claude-code-local-host": issuing its credential is human-reserved.',
			);
			await dispatcher.tick();
			await dispatcher.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			// After its retry time, the next pass finds no canonical Attempt and
			// re-admits instead of fencing the revision forever.

			expect(saved.admissionState).toBe(n % 2 ? "unknown" : "not_sent");
			expect(saved.held).not.toBe(true);
			expect(saved.phase).toBe("deferred");
			saved.recheckAt = 0;
			saved.retryDeadlineAt = 0;
			writeFileSync(path, JSON.stringify(saved));
		}
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(2);
		expect(events.filter((e) => e.verb === "comment")).toHaveLength(0);
	});
	it.each(["recovered", "offline", "expired", "foreign", "settled"])(
		"retains offline proof until %s without relaunching",
		async (state) => {
			const { dispatcher, restart, dir, items, events, releases, control } =
				fixture();
			items.splice(1);
			items[0]!.workKind = "coding";
			control.proofError = new LaneCommitFetchError("offline");
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			const path = join(dir, `${item().id}-2.json`);
			let saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({
				phase: "settling",
				outcome: "succeeded",
				attemptId: "fictional-attempt",
				// A Codex run also keeps its structured result file after the final message.
				pendingCommitProof: expect.stringContaining(
					`Result recorded in OS.\nTEDIX_LANE_RESULT ${JSON.stringify(completedResult())}\n{`,
				),
			});
			expect(events.filter((e) => e.verb === "settle")).toHaveLength(0);
			expect(control.cleanups).toBe(0);
			control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey:
						state === "foreign" ? "codex:foreign" : saved.session,
					outcome: state === "settled" ? "succeeded" : null,
					expiresAt: new Date(
						Date.now() + (state === "expired" ? -300000 : 300000),
					).toISOString(),
				},
			];
			if (state === "recovered") {
				control.proofError = undefined;
				control.commits = ["b".repeat(40)];
			}
			for (let n = 0; n < (state === "offline" ? 6 : 1); n++) {
				saved.recheckAt = 0;
				writeFileSync(path, JSON.stringify(saved));
				await restart().tick();
				saved = JSON.parse(readFileSync(path, "utf8"));
			}
			if (state === "foreign") {
				// An unavailable fence holds this receipt without stopping the pass.
				expect(saved).toMatchObject({
					phase: "settling",
					settlementCheckFailures: 1,
				});
				expect(saved.recheckAt).toBeGreaterThan(Date.now());
				expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
					"Retained settlement fence is unavailable",
				);
			}
			expect(releases).toHaveLength(1);
			expect(events.filter((e) => e.verb === "settle")).toHaveLength(
				state === "recovered" ? 1 : 0,
			);
			expect(events.filter((e) => e.verb === "heartbeat")).toHaveLength(
				state === "offline" ? 7 : state === "recovered" ? 2 : 1,
			);
			if (state === "recovered") {
				expect(saved.phase).toBe("settled");
				expect(saved.commits).toEqual(control.commits);
				expect(saved.pendingCommitProof).toBeUndefined();
				expect(control.cleanups).toBe(1);
			}
			if (state === "offline") expect(saved.retries).toBeUndefined();
		},
	);
	it("holds a revision with a recorded result until the Work changes", async () => {
		const { dispatcher, dir, items, events, control } = fixture();
		items.splice(1);
		control.history.data = [
			{
				id: "recorded-attempt",
				externalSessionKey: "codex:another-session",
				outcome: "succeeded",
				metadata: { dispatchVersion: 2 },
			},
		];
		await dispatcher.tick();
		await dispatcher.drain();
		const path = join(dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.held).toBe(true);
		expect(saved.note).toContain(
			"Attempt recorded-attempt already recorded a succeeded result",
		);
		saved.recheckAt = 0;
		saved.retryDeadlineAt = Date.now() - 1;
		writeFileSync(path, JSON.stringify(saved));
		const reads = () =>
			events.filter((e) =>
				["dispatch-get", "dispatch-attempts"].includes(e.verb),
			).length;
		const before = reads();
		for (let pass = 0; pass < 3; pass++) await dispatcher.tick();
		await dispatcher.drain();
		// One read records the hold on the Work; the history is not read again.
		expect(reads()).toBe(before + 1);
		expect(
			events.filter((e) => e.verb === "dispatch-hold").map((e) => e.input),
		).toEqual([
			{
				expectedWorkItemVersion: 2,
				laneDispatch: {
					state: "held",
					reason:
						"An earlier run already recorded a result for this version of the task, so no agent starts it again.",
					note: saved.note,
				},
			},
		]);
		expect(events.filter((e) => e.verb === "interaction-create")).toHaveLength(
			1,
		);
		expect(events.some((e) => e.verb === "start" && e.args[4] === "work")).toBe(
			false,
		);
		expect(events.filter((e) => e.verb === "comment")).toHaveLength(0);
	});
	it("sends the full any-local executor set to server-side discovery", async () => {
		const { dispatcher, events, releases } = fixture({ executor: "any-local" });
		await dispatcher.tick();
		await until(() => releases.length === 3);
		expect(
			events.find((e) => e.verb === "dispatch-list")?.input?.executor,
		).toEqual(["codex", "claude-code", "opencode", "devin", "any-local"]);
		for (const release of releases) release();
		await dispatcher.drain();
	});
	it.each(["landed", "missing", "unavailable"])(
		"settles coding Work with %s commit proof",
		async (proof) => {
			const { dispatcher, items, control, events, releases, dir } = fixture();
			items.splice(1);
			items[0]!.workKind = "coding";
			if (proof === "landed")
				control.commits = ["b".repeat(40), "c".repeat(40)];
			if (proof === "unavailable")
				control.proofError = new Error("origin/main unavailable");
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			const settlement = events.find((e) => e.verb === "settle")!.args;
			expect(settlement[settlement.indexOf("--outcome") + 1]).toBe(
				proof === "landed" ? "succeeded" : "failed",
			);
			expect(settlement.filter((arg) => arg === "--commit")).toHaveLength(
				control.commits.length,
			);
			for (const sha of control.commits) expect(settlement).toContain(sha);
			if (proof === "landed")
				expect(events.some((event) => event.verb === "evidence")).toBe(false);
			const receipt = JSON.parse(
				readFileSync(join(dir, `${item().id}-2.json`), "utf8"),
			);
			if (proof === "missing")
				expect(receipt.note).toContain("No landed commit SHA on origin/main");
		},
	);

	it.each([
		"installed",
		"workspace",
		"app",
		"revision",
		"revisionId",
		"currentPointer",
		"revisionApp",
		"organization",
		"archived",
		"entry",
		"codeRevision",
		"codeRevisionId",
		"noCode",
		"noClient",
		"attempt",
		"uri",
		"missingEvidence",
		"noContract",
		"invalidContract",
		"incompleteResult",
		"git",
		"ledgerUnavailable",
		"ledgerTruncated",
		"discoveryUnavailable",
		"appUnavailable",
		"codeUnavailable",
		"malformedRead",
		"denied",
		"missingTool",
		"restart",
	])("checks installed runtime app proof: %s", async (scenario) => {
		const {
			dispatcher,
			restart,
			items,
			control,
			events,
			releases,
			briefs,
			dir,
		} = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		const app = {
			workspaceId: "66666666-6666-4666-8666-666666666666",
			gadgetId: "77777777-7777-4777-8777-777777777777",
			revision: 4,
			revisionId: "88888888-8888-4888-8888-888888888888",
		};
		const other = "99999999-9999-4999-8999-999999999999";
		items[0]!.metadata = {
			...items[0]!.metadata,
			...(scenario === "noContract"
				? {}
				: {
						artifactKind: "runtime_app_revision",
						artifactRuntimeApp:
							scenario === "invalidContract" ? { ...app, revision: 0 } : app,
					}),
		};
		const evidenceId = "55555555-5555-4555-8555-555555555555";
		control.evidence.data =
			scenario === "missingEvidence" || scenario === "ledgerTruncated"
				? []
				: [
						{
							id: evidenceId,
							attemptId:
								scenario === "attempt" ? "other-attempt" : "fictional-attempt",
							kind: "runtime_app_revision",
							uri:
								scenario === "uri"
									? runtimeAppEvidenceUri({ ...app, workspaceId: other })
									: runtimeAppEvidenceUri(app),
						},
					];
		if (scenario === "ledgerUnavailable")
			control.evidenceError = new Error("gateway unavailable");
		if (scenario === "ledgerTruncated")
			control.evidence.nextCursor = "next-page";
		if (scenario === "git") control.commits = ["c".repeat(40)];
		if (scenario === "incompleteResult")
			control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify({ ...completedResult(items[0]!), outcome: "incomplete", remaining: "App tests remain" })}`;
		let unavailableCode = scenario === "restart";
		control.appRead = (source) => {
			if (source.includes("discover.search")) {
				if (scenario === "discoveryUnavailable")
					throw new Error("discovery unavailable");
				const tool = source.includes('"get_os_gadget"')
					? "get_os_gadget"
					: "gadgets_get_code";
				return {
					tools:
						scenario === "missingTool"
							? []
							: [
									{
										tool,
										callable: `os.${tool}`,
										authorized: true,
										schemaFreshness: {
											sourceRef: `osWorkspaces/gadgets/${tool === "get_os_gadget" ? "get" : "getCode"}`,
										},
									},
								],
				};
			}
			expect(source).toContain(
				JSON.stringify({
					workspaceId: app.workspaceId,
					gadgetId: app.gadgetId,
				}),
			);
			expect(source).not.toContain(`"revisionId":`);
			if (source.includes("os.get_os_gadget(")) {
				if (scenario === "appUnavailable") throw new Error("app unavailable");
				if (scenario === "malformedRead") return {};
				if (scenario === "denied")
					return {
						defined: true,
						status: 403,
						code: "FORBIDDEN",
						message: "denied",
					};
				return {
					gadget: {
						id: scenario === "app" ? other : app.gadgetId,
						workspaceId: scenario === "workspace" ? other : app.workspaceId,
						status: scenario === "archived" ? "archived" : "active",
						organizationId: "fictional-org",
						currentRevisionId:
							scenario === "currentPointer" ? other : app.revisionId,
					},
					currentRevision: {
						id: scenario === "revisionId" ? other : app.revisionId,
						gadgetId: scenario === "revisionApp" ? other : app.gadgetId,
						organizationId:
							scenario === "organization" ? "other-org" : "fictional-org",
						revision: scenario === "revision" ? 5 : app.revision,
						manifest: {
							entry:
								scenario === "entry" ? "tedix:app/work" : "tedix:runtime/v1",
						},
					},
				};
			}
			if (scenario === "codeUnavailable" || unavailableCode)
				throw new Error("code unavailable");
			return {
				code:
					scenario === "noCode"
						? null
						: {
								revisionId:
									scenario === "codeRevisionId" ? other : app.revisionId,
								revision: scenario === "codeRevision" ? 5 : app.revision,
								codeLength: 10,
								hasServer: true,
								hasClient: scenario !== "noClient",
							},
			};
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		if (scenario === "restart") {
			expect(events.some((event) => event.verb === "settle")).toBe(false);
			const path = join(dir, `${items[0]!.id}-2.json`);
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.runtimeAppArtifact).toEqual(app);
			control.history.data = [
				{
					id: saved.attemptId,
					externalSessionKey: saved.session,
					outcome: null,
					expiresAt: new Date(Date.now() + 300_000).toISOString(),
				},
			];
			writeFileSync(path, JSON.stringify({ ...saved, recheckAt: 0 }));
			unavailableCode = false;
			const resumed = restart();
			await resumed.tick();
			await resumed.drain();
			expect(
				events.filter(
					(event) => event.verb === "start" && event.args[4] === "work",
				),
			).toHaveLength(1);
		}
		const settlement = events.find((event) => event.verb === "settle");
		const unavailable = [
			"ledgerUnavailable",
			"ledgerTruncated",
			"discoveryUnavailable",
			"appUnavailable",
			"codeUnavailable",
			"malformedRead",
			"denied",
			"missingTool",
		].includes(scenario);
		if (unavailable) {
			expect(settlement).toBeUndefined();
			const receipt = JSON.parse(
				readFileSync(join(dir, `${items[0]!.id}-2.json`), "utf8"),
			);
			expect(receipt.phase).toBe("settling");
			expect(receipt.pendingCommitProof).toBeDefined();
		} else {
			expect(settlement!.args[settlement!.args.indexOf("--outcome") + 1]).toBe(
				["installed", "git", "restart"].includes(scenario)
					? "succeeded"
					: scenario === "incompleteResult"
						? "rejected"
						: "failed",
			);
		}
		if (scenario === "installed") {
			expect(settlement!.args).not.toContain("--commit");
			expect(settlement!.input).toMatchObject({
				metadata: {
					settlement: {
						mode: "runtime_app_revision",
						...app,
						evidenceId,
						evidenceUri: runtimeAppEvidenceUri(app),
					},
				},
			});
			expect(briefs[0]).toContain("--evidence-kind runtime_app_revision");
			expect(
				events.find((event) => event.verb === "complete")?.env
					.TEDIX_AGENT_SESSION,
			).toBe(settlement!.env.TEDIX_AGENT_SESSION);
		}
		if (
			["git", "noContract", "invalidContract", "incompleteResult"].includes(
				scenario,
			)
		)
			expect(
				events.some(
					(event) => event.args[4] === "code" || event.verb === "evidence",
				),
			).toBe(false);
	});

	it("settles coding Work from completed skill revision evidence attributed to its Attempt", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: null,
		};
		control.skill = {
			id: "66666666-6666-4666-8666-666666666666",
			lifecycleState: "active",
			tediId: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!;
		expect(settlement.args[settlement.args.indexOf("--outcome") + 1]).toBe(
			"succeeded",
		);
		expect(settlement.args).not.toContain("--commit");
		expect(settlement.input).toMatchObject({
			metadata: {
				settlement: {
					mode: "skill_revision",
					evidenceId: "55555555-5555-4555-8555-555555555555",
					evidenceUri: `skill://runs/${runId}`,
					skillId: "66666666-6666-4666-8666-666666666666",
					skillRevision: 3,
					skillRunId: runId,
				},
			},
		});
	});

	it("does not use skill revision evidence from another Attempt", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "another-attempt",
				kind: "skill_revision",
				uri: "skill://runs/44444444-4444-4444-8444-444444444444",
			},
		];
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
		expect(events.some((event) => event.verb === "status")).toBe(false);
	});

	it("does not use a skill run linked to another Work Item", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: item(2).id,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
	});

	it("does not settle from an ephemeral draft skill run", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: null,
		};
		control.skill = {
			id: "66666666-6666-4666-8666-666666666666",
			lifecycleState: "draft",
			tediId: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
	});

	it("does not settle from a different active organization skill", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "77777777-7777-4777-8777-777777777777",
			artifactSkillRevision: 3,
		};
		const runId = "44444444-4444-4444-8444-444444444444";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: `skill://runs/${runId}`,
			},
		];
		control.skillRun = {
			runId,
			status: "completed",
			skillId: "66666666-6666-4666-8666-666666666666",
			skillRevision: 3,
			workItemId: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
		expect(
			events.some(
				(event) => event.verb === "show" && event.args[6] !== options.rules,
			),
		).toBe(false);
	});

	it("rejects permanently missing skill-run evidence instead of retaining the Attempt", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		items[0]!.metadata = {
			...items[0]!.metadata,
			artifactKind: "skill_revision",
			artifactSkillId: "66666666-6666-4666-8666-666666666666",
			artifactSkillRevision: 3,
		};
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: "skill://runs/44444444-4444-4444-8444-444444444444",
			},
		];
		control.skillRunError = new CliReadError("run not found", "NOT_FOUND", 404);
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
	});

	it("keeps landed-commit validation for coding Work without a skill artifact declaration", async () => {
		const { dispatcher, items, control, events, releases } = fixture();
		items.splice(1);
		items[0]!.workKind = "coding";
		control.evidence.data = [
			{
				id: "55555555-5555-4555-8555-555555555555",
				attemptId: "fictional-attempt",
				kind: "skill_revision",
				uri: "skill://runs/44444444-4444-4444-8444-444444444444",
			},
		];
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		const settlement = events.find((event) => event.verb === "settle")!.args;
		expect(settlement[settlement.indexOf("--outcome") + 1]).toBe("failed");
		expect(events.some((event) => event.verb === "evidence")).toBe(false);
	});

	it.each(["failed", "expired"])(
		"holds lost admission responses until canonical history retires the Attempt as %s",
		async (outcome) => {
			const { dispatcher, dir, items, events, control, releases } = fixture({
				refuse: true,
			});
			items.splice(1);
			control.startError = new Error("Tedix CLI read deadline elapsed");
			const path = join(dir, `${item().id}-2.json`);
			const retry = async () => {
				const saved = JSON.parse(readFileSync(path, "utf8"));
				saved.recheckAt = 0;
				writeFileSync(path, JSON.stringify(saved));
				await dispatcher.tick();
				await dispatcher.drain();
			};
			await dispatcher.tick();
			await dispatcher.drain();
			expect(JSON.parse(readFileSync(path, "utf8")).admissionState).toBe(
				"unknown",
			);
			control.startError = undefined;
			control.history.nextCursor = "older-page";
			await retry();
			control.history.nextCursor = null;
			control.history.data = [
				{
					id: "lost-attempt",
					outcome: null,
					expiresAt: "2020-01-01T00:00:00.000Z",
					metadata: { dispatchVersion: 2 },
				},
			];
			await retry();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				1,
			);
			expect(releases).toHaveLength(0);
			// Lease expiry alone is insufficient; the server must retire the Attempt.
			control.history.data[0]!.outcome = outcome;
			const saved = JSON.parse(readFileSync(path, "utf8"));
			control.history.data[0]!.externalSessionKey = saved.session;
			saved.recheckAt = 0;
			writeFileSync(path, JSON.stringify(saved));
			await dispatcher.tick();
			const recovered = JSON.parse(readFileSync(path, "utf8"));
			recovered.recheckAt = 0;
			writeFileSync(path, JSON.stringify(recovered));
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				2,
			);
		},
	);
	it.each([true, false])(
		"discards legacy retry windows and checks admission with current readiness=%s",
		async (ready) => {
			const { dispatcher, dir, items, control, releases, events } = fixture();
			items.splice(1);
			const path = join(dir, `${item().id}-2.json`);
			writeFileSync(
				path,
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "deferred",
					outcome: "failed",
					admissionState: "rejected",
					admissionFailure:
						"The organization's tool policy could not be verified",
					held: true,
					identicalFailures: 3,
					retries: 3,
					retryAt: Date.now() + 30 * 60_000,
					retryDeadlineAt: Date.now() + 30 * 60_000,
				}),
			);
			control.readiness = {
				ready,
				reasons: ready
					? []
					: [{ detail: "approval_blocked: Missing approval risk:high" }],
			};
			await dispatcher.tick();
			if (ready) {
				await until(() => releases.length === 1);
				releases[0]!();
			}
			await dispatcher.drain();
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				ready ? 1 : 0,
			);
			expect(JSON.parse(readFileSync(path, "utf8")).held).not.toBe(true);
		},
	);
	it.each([
		() => ({ admissionState: "unknown" }),
		() => ({
			attemptId: "retained-attempt",
			session: "codex:retained",
			executorKey: "retained",
		}),
	])(
		"preserves admission holds with a live or unknown fence: %j",
		async (createFence) => {
			const fence = createFence();
			const { dispatcher, dir, items, events, releases } = fixture();
			items.splice(1);
			writeFileSync(
				join(dir, `${item().id}-2.json`),
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "deferred",
					admissionState: "rejected",
					admissionFailure: "Earlier admission failed",
					held: true,
					retryDeadlineAt: Date.now() - 1,
					...fence,
				}),
			);
			await dispatcher.tick();
			await dispatcher.drain();
			expect(releases).toHaveLength(0);
			expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
				0,
			);
		},
	);
	it("allows a changed Work revision without waiting for the old revision's retry deadline", async () => {
		const { dispatcher, items, control, releases } = fixture({ refuse: true });
		items.splice(1);
		await dispatcher.tick();
		await dispatcher.drain();
		items[0]!.version++;
		control.startError = undefined;
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
	});
	it("stops before admission when the owner revises Work during preparation, then admits the new revision", async () => {
		const { dispatcher, dir, items, control, events, releases } = fixture();
		items.splice(1);
		let openGate!: () => void;
		control.preparationGate = {
			itemId: item(1).id,
			open: new Promise<void>((done) => {
				openGate = done;
			}),
		};
		const starts = () =>
			events.filter((e) => e.verb === "start" && e.args[4] === "work");
		await dispatcher.tick();
		await until(() =>
			events.some((e) => e.verb === "show" && e.args.includes("--file")),
		);
		await new Promise((done) => setTimeout(done, 10));
		// The owner edits the brief while the native thread is still starting.
		items[0]!.version = 3;
		await dispatcher.tick();
		expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
			"Already preparing or running here",
		);
		openGate();
		await dispatcher.drain();
		expect(starts()).toHaveLength(0);
		expect(events.filter((e) => e.verb === "settle")).toHaveLength(0);
		expect(
			JSON.parse(readFileSync(join(dir, `${item(1).id}-2.json`), "utf8")),
		).toMatchObject({ phase: "deferred", admissionState: "not_sent" });
		expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
			'"event":"superseded"',
		);
		control.preparationGate = undefined;
		await dispatcher.tick();
		await until(() => releases.length === 1);
		expect(starts()).toHaveLength(1);
		expect(starts()[0]!.input?.metadata).toMatchObject({ dispatchVersion: 3 });
		releases[0]!();
		await dispatcher.drain();
	});
	it("does not admit prepared Work after a refreshed pre-flight fails", async () => {
		const { restart, deps, dir, items, control, events, releases } = fixture();
		items.splice(1);
		let now = Date.now();
		let failure: string | undefined;
		deps.preflight = async () => failure;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const gate = Promise.withResolvers<void>();
		control.preparationGate = { itemId: item(1).id, open: gate.promise };
		const dispatcher = restart();
		const starts = () =>
			events.filter((e) => e.verb === "start" && e.args[4] === "work");
		try {
			await dispatcher.tick();
			await until(() => control.threadSessions.length === 1);
			now += 5 * 60_000;
			failure = "Codex network check failed";
			await dispatcher.tick();
			gate.resolve();
			await dispatcher.drain();
			expect(starts()).toHaveLength(0);
			const receipt = JSON.parse(
				readFileSync(join(dir, `${item(1).id}-2.json`), "utf8"),
			);
			expect(receipt).toMatchObject({
				phase: "deferred",
				admissionState: "not_sent",
			});

			now += 30_000;
			failure = undefined;
			await dispatcher.tick();
			await until(() => releases.length === 1);
			releases[0]!();
			await dispatcher.drain();
			expect(starts()).toHaveLength(1);
		} finally {
			gate.resolve();
			clock.mockRestore();
		}
	});
	it("hands Work back without admission when told to stop during preparation", async () => {
		const { dispatcher, dir, items, control, events } = fixture();
		items.splice(1);
		let openGate!: () => void;
		control.preparationGate = {
			itemId: item(1).id,
			open: new Promise<void>((done) => {
				openGate = done;
			}),
		};
		await dispatcher.tick();
		await until(() =>
			events.some((e) => e.verb === "show" && e.args.includes("--file")),
		);
		// The supervisor restarts while this runner is still preparing.
		dispatcher.stop();
		openGate();
		await dispatcher.drain();
		expect(
			events.filter((e) => e.verb === "start" && e.args[4] === "work"),
		).toHaveLength(0);
		const receipt = JSON.parse(
			readFileSync(join(dir, `${item(1).id}-2.json`), "utf8"),
		);
		expect(receipt).toMatchObject({
			phase: "deferred",
			admissionState: "not_sent",
		});
		expect(receipt.held).not.toBe(true);
		expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
			"told to stop while it prepared",
		);
	});
	it("cancels an admitted Attempt instead of launching it once the runner is stopping", async () => {
		const f = fixture();
		f.items.splice(1);
		const recall = f.deps.recall!;
		let runner!: ReturnType<typeof f.restart>;
		f.deps.recall = async (...args) => {
			// The stop lands after admission, while the brief is being built.
			runner.stop();
			return recall(...args);
		};
		runner = f.restart();
		await runner.tick();
		await runner.drain();
		expect(
			f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
		).toHaveLength(1);
		expect(f.releases).toHaveLength(0);
		const settle = f.events.filter((e) => e.verb === "settle");
		expect(settle).toHaveLength(1);
		expect(settle[0]!.args).toContain("cancelled");
	});
	it.each(["unrecorded", "matched", "mismatched"])(
		"checks a retained live PID during an update drain (identity %s)",
		async (identity) => {
			const f = fixture({ executor: "opencode" });
			f.items.splice(1);
			Object.assign(f.items[0]!, { priority: "high" });
			// Liveness probes the process group, so the receipt needs a group leader.
			// This test process leads its group on a terminal but not on a CI runner.
			const agent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
			const exited = once(agent, "exit");
			const pid = agent.pid!;
			try {
				const session = "opencode:30";
				const mismatch = identity === "mismatched";
				let processIdentity = mismatch
					? "recorded-before-pid-reuse"
					: undefined;
				if (identity === "matched")
					await until(
						() =>
							(processIdentity = laneProcessIdentity(pid, session)) !==
							undefined,
					);
				writeFileSync(
					join(f.dir, `${item(99).id}-2.json`),
					JSON.stringify({
						itemId: item(99).id,
						version: 2,
						phase: "deferred",
						outcome: "expired",
						admissionState: "admitted",
						attemptId: "historical-attempt",
						session,
						pid,
						processIdentity,
					}),
				);
				f.dispatcher.holdAdmissions("0.23.0");
				expect(await f.dispatcher.quiet()).toBe(mismatch);
				await f.dispatcher.tick();
				await f.dispatcher.drain();
				expect(await f.dispatcher.quiet()).toBe(mismatch);
				expect(f.events.some((event) => event.verb === "dispatch-list")).toBe(
					false,
				);
				expect(f.releases).toHaveLength(0);
				const log = readFileSync(join(f.dir, "dispatcher.log"), "utf8");
				expect(log).toContain('"event":"admissions-held"');
				expect(log).toContain("Waiting to restart onto Tedix CLI 0.23.0");
				expect(log).toContain("0 running, 0 preparing");
				expect(log.includes('"event":"restart-held"')).toBe(!mismatch);
				if (!mismatch) {
					expect(log).toContain(`PID ${pid}`);
					expect(log).toContain("phase deferred, Attempt historical-attempt");
				}
				expect(agent.signalCode).toBeNull();
				expect(agent.exitCode).toBeNull();
			} finally {
				agent.kill("SIGKILL");
				await exited;
			}
		},
	);
	it("holding admissions for an update launches Work already admitted, cancels nothing and admits nothing new", async () => {
		const f = fixture();
		const waiting = f.items.splice(1);
		const recall = f.deps.recall!;
		let runner!: ReturnType<typeof f.restart>;
		f.deps.recall = async (...args) => {
			// The update is noticed after admission, while the brief is being built.
			runner.holdAdmissions();
			return recall(...args);
		};
		runner = f.restart();
		expect(await runner.quiet()).toBe(true);
		await runner.tick();
		await until(() => f.releases.length === 1);
		expect(await runner.quiet()).toBe(false);
		f.items.push(...waiting);
		f.releases[0]!();
		await runner.drain();
		await runner.tick();
		await runner.drain();
		expect(
			f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
		).toHaveLength(1);
		const settle = f.events.filter((e) => e.verb === "settle");
		expect(settle).toHaveLength(1);
		expect(settle[0]!.args).toContain("succeeded");
		expect(await runner.quiet()).toBe(true);
	});
	it("is not quiet while a retained run's agent process is alive or its Attempt is unsettled", async () => {
		const { dispatcher, dir } = fixture();
		const receipt = {
			itemId: item(1).id,
			version: 2,
			phase: "running",
			admissionState: "admitted",
			attemptId: "fictional-attempt",
		};
		const path = join(dir, `${item(1).id}-2.json`);
		writeFileSync(path, JSON.stringify(receipt));
		expect(await dispatcher.quiet()).toBe(false);
		// Lane processes lead their own process group, like this one.
		const agent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		try {
			writeFileSync(
				path,
				JSON.stringify({ ...receipt, phase: "deferred", pid: agent.pid }),
			);
			expect(await dispatcher.quiet()).toBe(false);
		} finally {
			agent.kill("SIGKILL");
		}
		writeFileSync(
			path,
			JSON.stringify({ ...receipt, phase: "settled", outcome: "succeeded" }),
		);
		expect(await dispatcher.quiet()).toBe(true);
	});
	it("cancels, not fails, an Attempt admitted on a revision that landed during start, then admits it", async () => {
		const { restart, deps, items, events, releases } = fixture();
		items.splice(1);
		const cli = deps.cli!;
		let raced = false;
		deps.cli = async (args, env) => {
			if (!raced && args[4] === "work" && args[5] === "start") {
				raced = true;
				items[0]!.version = 3;
			}
			return cli(args, env);
		};
		const dispatcher = restart();
		await dispatcher.tick();
		await dispatcher.drain();
		const settles = events.filter((e) => e.verb === "settle");
		expect(settles).toHaveLength(1);
		expect(settles[0]!.args).toContain("cancelled");
		expect(settles[0]!.input?.metadata).toMatchObject({ dispatchVersion: 2 });
		expect(releases).toHaveLength(0);
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
	});
	it("does nothing during dark wake", async () => {
		const { dispatcher, events } = fixture({ dark: true });
		await dispatcher.tick();
		expect(events).toHaveLength(0);
	});
	it("waits out the login's shared gateway cooldown instead of queuing reads into it", async () => {
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const { dispatcher, events, control, releases, dir } = fixture();
		try {
			control.cooldownUntil = now + 59_000;
			await dispatcher.tick();
			expect(events).toHaveLength(0);
			expect(control.cooldownWorkspaces).toContain("acme");
			expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
				"Gateway rate limit for this login until",
			);
			// The loop wakes when the cooldown ends, not on a blind 30 s timer.
			expect(dispatcher.nextTickDelayMs()).toBeGreaterThanOrEqual(59_000);
			expect(dispatcher.nextTickDelayMs()).toBeLessThanOrEqual(64_000);
			now += 59_001;
			expect(dispatcher.nextTickDelayMs()).toBe(30_000);
			await dispatcher.tick();
			expect(events.some((event) => event.verb === "dispatch-list")).toBe(true);
			await until(() => releases.length === 3);
		} finally {
			for (const release of releases) release();
			await dispatcher.drain();
			clock.mockRestore();
		}
	});
	it("gives a read queued behind the cooldown the rest of it plus a request budget", () => {
		expect(cooldownGraceMs(0, 1_000)).toBe(0);
		expect(cooldownGraceMs(1_000, 1_000)).toBe(0);
		expect(cooldownGraceMs(46_000, 1_000)).toBe(75_000);
	});
	it("sweeps proposals at most every five minutes", async () => {
		let now = 1_800_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const { dispatcher, events, releases, items } = fixture({
			acceptProposed: true,
		});
		items.splice(0);
		const sweeps = () =>
			events.filter(
				(event) =>
					event.verb === "dispatch-list" &&
					event.input?.disposition === "proposed",
			).length;
		try {
			await dispatcher.tick();
			now += 30_000;
			await dispatcher.tick();
			expect(sweeps()).toBe(1);
			now += 5 * 60_000;
			await dispatcher.tick();
			expect(sweeps()).toBe(2);
		} finally {
			for (const release of releases) release();
			await dispatcher.drain();
			clock.mockRestore();
		}
	});
	it("retries a settling receipt after a read deadline and re-admits the same revision", async () => {
		const { dispatcher, dir, events, releases, control } = fixture();
		// Another Work Item stays in preparation, as on a busy lane.
		let openGate!: () => void;
		control.preparationGate = {
			itemId: item(3).id,
			open: new Promise<void>((done) => {
				openGate = done;
			}),
		};
		const path = join(dir, `${item(1).id}-2.json`);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item(1).id,
				version: 2,
				phase: "settling",
				admissionState: "admitted",
				attemptId: "expired-attempt",
				session: "codex:expired-session",
				executorKey: "codex-fictional",
				outcome: "expired",
				retryable: false,
				interrupted: true,
				note: "Error: Tedix CLI read deadline elapsed",

				runFailureCounted: true,
				runRetryAt: 0,
				settlementRetries: 1,
				recheckAt: 0,
				retryDeadlineAt: Date.now() + 30 * 60_000,
			}),
		);
		const admissions = () =>
			events.filter((e) => e.verb === "start" && e.args[6] === item(1).id);
		try {
			control.historyError = new Error("Tedix CLI read deadline elapsed");
			await withoutReadBackoff(() => dispatcher.tick());
			let saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({
				phase: "settling",
				settlementCheckFailures: 1,
			});
			expect(saved.recheckAt).toBeGreaterThan(Date.now());
			expect(admissions()).toHaveLength(0);

			control.historyError = undefined;
			control.history.data = [
				{
					id: "expired-attempt",
					externalSessionKey: "codex:expired-session",
					outcome: "expired",
					expiresAt: new Date(Date.now() - 60_000).toISOString(),
				},
			];
			saved.recheckAt = 0;
			writeFileSync(path, JSON.stringify(saved));
			await dispatcher.tick();
			expect(admissions()).toHaveLength(0);
			await dispatcher.tick();
			await until(() => admissions().length === 1);
			saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.version).toBe(2);
			expect(saved.attemptId).toBe("fictional-attempt");
			expect(events.filter((e) => e.verb === "settle")).toHaveLength(0);
		} finally {
			openGate();
			await until(() => releases.length === 3);
			for (const release of releases) release();
			await dispatcher.drain();
		}
	});
	it("retains the exact fence, outcome and retry deadline when settlement fails", async () => {
		const { dispatcher, releases, dir } = fixture({ failSettle: true });
		await dispatcher.tick();
		await until(() => releases.length === 3);
		for (const release of releases) release();
		await dispatcher.drain();
		const saved = JSON.parse(
			readFileSync(join(dir, `${item(1).id}-2.json`), "utf8"),
		);
		expect(saved).toMatchObject({
			phase: "settling",
			attemptId: "fictional-attempt",
			outcome: "succeeded",

			settlementRetries: 1,
		});
		expect(saved.recheckAt).toBeGreaterThan(Date.now());
	});
});

it("installs worktree dependencies and rejects a changed frozen lockfile", async () => {
	const repo = mkdtempSync(join(tmpdir(), "lane-install-test-"));
	dirs.push(repo);
	mkdirSync(join(repo, "dependency"));
	writeFileSync(
		join(repo, "dependency/package.json"),
		JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
	);
	const manifest = {
		name: "fixture",
		dependencies: { "fixture-dependency": "file:./dependency" },
	};
	writeFileSync(join(repo, "package.json"), JSON.stringify(manifest));
	expect(spawnSync("bun", ["install"], { cwd: repo }).status).toBe(0);
	rmSync(join(repo, "node_modules"), { recursive: true });
	await installLaneDependencies(repo);
	expect(
		existsSync(join(repo, "node_modules/fixture-dependency/package.json")),
	).toBe(true);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ ...manifest, dependencies: {} }),
	);
	await expect(installLaneDependencies(repo)).rejects.toThrow();
});

it("launches owner-requested workspace coding runs without classifying their brief", () => {
	const work = {
		...item(),
		workKind: "coding" as const,
		sourceSessionKey: `workspace:${projectId}:${projectId}`,
	};
	for (const description of [
		"First run sleep 480 in the shell as one command, so the task owner has time to send a follow-up.",
		"Fix the send email handler, payment flow and credential rotation.",
		"Send an email to the customer, pay the invoice and rotate the API key.",
		"Complete MFA consent.",
	])
		expect(dispatchSkip({ ...work, description })).toBeUndefined();
	const reserved = { ...work, description: "Send an email to the customer." };
	for (const other of [
		{ sourceSessionKey: null },
		{ sourceSessionKey: "home:os:chat-7" },
		{ workKind: "research" as const },
		{ accountableOwnerType: "tedi" as const },
		{ accountableOwnerId: null },
	])
		expect(dispatchSkip({ ...reserved, ...other })).toContain("human-reserved");
	expect(dispatchSkip({ ...work, disposition: "proposed" })).toContain(
		"not accepted",
	);
	expect(dispatchSkip({ ...work, metadata: { executor: "devin" } })).toContain(
		"not assigned",
	);
	expect(dispatchSkip(work, [], "codex", true)).toContain("coordinator");
	expect(dispatchSkip({ ...work, startAt: "2999-01-01T00:00:00Z" })).toContain(
		"scheduled",
	);
	expect(dispatchSkip({ ...work, activeAttempt: {} })).toContain(
		"live Attempt",
	);
});

it("requires the owner's version-specific note for money or personal messaging", () => {
	const work = { ...item(), description: "Send an email as the owner" };
	expect(dispatchSkip(work)).toContain("owner comment");
	const note = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Send this approved draft to the named recipient.",
	};
	expect(dispatchSkip(work, [note])).toBeUndefined();
	for (const owner of [
		{ accountableOwnerType: null, accountableOwnerId: null },
		{ accountableOwnerType: "user" as const, accountableOwnerId: null },
		{
			accountableOwnerType: "tedi" as const,
			accountableOwnerId: "fictional-tedi",
		},
	]) {
		const reason = dispatchSkip({ ...work, ...owner }, [note]);
		expect(reason).toContain("no accountable user owner");
		expect(reason).toContain("Set an accountable user owner");
	}
	expect(
		dispatchSkip(work, [{ ...note, authorId: "another-owner" }]),
	).toContain("owner comment");
	expect(dispatchSkip({ ...work, version: 3 }, [note])).toContain(
		"owner comment",
	);
	expect(
		dispatchSkip({ ...work, description: "Complete MFA consent" }, [note]),
	).toContain("human-only");
	expect(dispatchSkip({ ...work, disposition: "proposed" }, [note])).toContain(
		"not accepted",
	);
});

it("asks the accountable owner once for a missing delegation and never adds it", async () => {
	const f = fixture();
	const [owned, ownerless] = [item(1), item(2)];
	f.items.splice(
		0,
		f.items.length,
		{ ...owned, description: "Send an email as the owner" },
		{
			...ownerless,
			description: "Send an email as the owner",
			accountableOwnerType: "tedi",
			accountableOwnerId: "fictional-tedi",
		},
	);
	const requests = new Map<string, string>();
	const base = f.deps.cli!;
	f.deps.cli = async <T>(args: string[], env: NodeJS.ProcessEnv) => {
		if (args[5] !== "interaction-create") return base<T>(args, env);
		const input = args[args.indexOf("--input") + 1]!;
		f.events.push({ verb: args[5], args, env, input: JSON.parse(input) });
		// The API returns the open request with identical content and creator.
		if (!requests.has(input))
			requests.set(input, `request-${requests.size + 1}`);
		return { id: requests.get(input) } as T;
	};
	for (let pass = 0; pass < 2; pass++) await f.restart().tick();
	const asks = f.events.filter((e) => e.verb === "interaction-create");
	expect(asks).toHaveLength(1);
	expect(requests.size).toBe(1);
	expect(asks[0]!.input).toMatchObject({
		workItemId: owned.id,
		kind: "question",
		notificationReason: "blocked_approval",
		requestedFrom: { type: "user", id: "fictional-owner" },
		metadata: {
			source: "lane-dispatch-blocker",
			laneBlocker: {
				kind: "owner_delegation",
				executor: "codex",
				workVersion: 2,
			},
			decisionDeck: { kind: "approval", classId: "lane-delegation" },
		},
	});
	const input = asks[0]!.input as {
		subject: string;
		prompt: string;
		metadata: {
			decisionDeck: unknown;
			cardPresentation: unknown;
		};
	};
	// The card names the agent and the task, says what each answer does and
	// carries no jargon; Allow posts the delegation through a card effect.
	expect(input.subject).toBe("Allow Codex to proceed?");
	expect(input.prompt).toContain("message people outside the team");
	expect(input.prompt).not.toMatch(
		/lane|work-version|Delegation:|sign-in|MFA/i,
	);
	const deck = DecisionEnvelopeSchema.parse(input.metadata.decisionDeck);
	expect(deck.options.map((option) => [option.label, option.intent])).toEqual([
		["Allow", "approve"],
		["No", "reject"],
		["Later", "later"],
	]);
	expect(deck.options[0]!.effect).toEqual({
		kind: "delegate_work",
		workItemId: owned.id,
		executor: "codex",
		workVersion: 2,
	});
	expect(deck.preview?.body).toBe(
		"Codex may message people outside the team only as this task describes, and nothing beyond it.\n\nMatched task sentences:\n“Send an email as the owner”",
	);
	expect(deck.reversibility).toBe("one_way");
	expect(
		DecisionCardPresentationSchema.safeParse(input.metadata.cardPresentation)
			.success,
	).toBe(true);
	expect(
		f.events.some((e) => ["start", "comment", "readiness"].includes(e.verb)),
	).toBe(false);
	expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
		"Request request-1",
	);
});

it("asks again only for a new Work version or recipient after restart", async () => {
	const f = fixture();
	f.items.splice(0, f.items.length, {
		...item(1),
		description: "Send an email to the customer",
	});
	const base = f.deps.cli!;
	let requests = 0;
	f.deps.cli = async <T>(args: string[], env: NodeJS.ProcessEnv) => {
		if (args[5] !== "interaction-create") return base<T>(args, env);
		requests++;
		return { id: `request-${requests}` } as T;
	};
	await f.restart().tick();
	// Neither a later tick nor a new process asks the same person again.
	await f.restart().tick();
	expect(requests).toBe(1);
	f.items[0]!.version++;
	await f.restart().tick();
	expect(requests).toBe(2);
	f.items[0]!.accountableOwnerId = "another-fictional-owner";
	await f.restart().tick();
	expect(requests).toBe(3);
	expect(f.events.some((e) => e.verb === "start")).toBe(false);
});

it("reads an item waiting on its owner once per window, not once per pass", async () => {
	const f = fixture();
	f.items.splice(0, f.items.length, {
		...item(1),
		description: "Send an email as the owner",
	});
	const base = f.deps.cli!;
	f.deps.cli = async <T>(args: string[], env: NodeJS.ProcessEnv) =>
		args[5] === "interaction-create"
			? ({ id: "request-1" } as T)
			: base<T>(args, env);
	const reads = () => f.events.filter((e) => e.verb === "dispatch-get").length;
	const dispatcher = f.restart();
	for (let pass = 0; pass < 3; pass++) await dispatcher.tick();
	expect(reads()).toBe(1);
	const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
	try {
		await dispatcher.tick();
		expect(reads()).toBe(2);
		// The owner's Delegation comment is seen on the next read after the window.
		f.control.comments.push({
			authorType: "user",
			authorId: "fictional-owner",
			body: "Delegation: codex work-version=2 Send only the fictional draft.",
		});
		await dispatcher.tick();
		expect(reads()).toBe(2);
		clock.mockReturnValue(Date.now() + 5 * 60_000);
		await dispatcher.tick();
		expect(reads()).toBeGreaterThan(2);
		await until(() => f.releases.length === 1);
		expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
			'"event":"admitted"',
		);
		f.releases[0]!();
		await dispatcher.drain();
	} finally {
		clock.mockRestore();
	}
});

it("spends a few gateway requests per pass on a lane of waiting items", async () => {
	// Ten minutes of 30-second passes over ten items that wait on their
	// owner. Before per-item reads were held, each pass read every item
	// (230 requests: 20 lists, 200 reads, 10 owner requests).
	const f = fixture();
	f.items.splice(
		0,
		f.items.length,
		...Array.from({ length: 10 }, (_, n) => ({
			...item(n + 1),
			description: "Send an email as the owner",
		})),
	);
	const base = f.deps.cli!;
	const requests: string[] = [];
	f.deps.cli = async <T>(args: string[], env: NodeJS.ProcessEnv) => {
		requests.push(args[5]!);
		return args[5] === "interaction-create"
			? ({ id: `request-${requests.length}` } as T)
			: base<T>(args, env);
	};
	const dispatcher = f.restart();
	const start = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(start);
	try {
		for (let pass = 0; pass < 20; pass++) {
			clock.mockReturnValue(start + pass * 30_000);
			await dispatcher.tick();
		}
	} finally {
		clock.mockRestore();
	}
	const count = (verb: string) => requests.filter((v) => v === verb).length;
	expect(count("dispatch-list")).toBe(20);
	expect(count("dispatch-get")).toBe(20);
	expect(count("interaction-create")).toBe(10);
	// The rules are declared in the first pass only: one read of the inherited
	// rules and one of the organization's skill, not one per pass.
	expect(count("runner-rules")).toBe(1);
	expect(count("show")).toBe(1);
	expect(requests).toHaveLength(52);
});

it("reads a delegated item once while another reason keeps it waiting", async () => {
	const f = fixture();
	f.items.splice(0, f.items.length, {
		...item(1),
		description: "Send an email as the owner",
	});
	f.control.comments.push({
		authorType: "user",
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Send only the fictional draft.",
	});
	writeFileSync(
		join(f.dir, `${item(1).id}-2.json`),
		JSON.stringify({
			itemId: item(1).id,
			version: 2,
			phase: "deferred",
			outcome: "failed",
			admissionState: "rejected",
			note: "Stopped by fictional-owner",
			held: true,
			holdRecorded: true,
		}),
	);
	const dispatcher = f.restart();
	for (let pass = 0; pass < 3; pass++) await dispatcher.tick();
	await dispatcher.drain();
	expect(f.events.filter((e) => e.verb === "dispatch-get")).toHaveLength(1);
	expect(f.events.some((e) => e.verb === "start")).toBe(false);
});

it("routes an ownerless delegation blocker to the signed-in lane operator", () => {
	const work = {
		...item(),
		accountableOwnerType: "tedi" as const,
		accountableOwnerId: "fictional-tedi",
	};
	const reason = dispatchSkip({ ...work, description: "Send an email" });
	expect(reason).toContain("no accountable user owner");
	const request = laneDelegationRequest(work, reason!, "fictional-operator");
	expect(request).toMatchObject({
		requestedFrom: { type: "user", id: "fictional-operator" },
		metadata: { laneBlocker: { kind: "accountable_owner" } },
	});
	expect(request?.subject).toContain("Choose an accountable owner");
	expect(laneDelegationRequest(work, reason!, undefined)).toBeUndefined();
	expect(
		laneDelegationRequest(
			work,
			"Consent, MFA and user presence remain human-only",
			"fictional-operator",
		),
	).toBeUndefined();
	expect(
		laneDelegationRequest(work, "Work has no project", "x"),
	).toBeUndefined();
});

it("dispatches Work that only mentions logins or credentials and holds credential acts for the owner", () => {
	const note = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Rotate only the fictional staging key.",
	};
	for (const description of [
		"Redesign the connections pages: login status, credentials list and reconnect button.",
		"The dispatcher refuses Work whose text mentions an owner login.",
		"Interview through the already logged-in desktop app. Never run tedix login or complete OAuth consent yourself.",
		"Fix the profile panel's consent check and approval count.",
	])
		expect(dispatchSkip({ ...item(), description })).toBeUndefined();
	const work = { ...item(), description: "Rotate the staging API key." };
	const reason = dispatchSkip(work);
	expect(reason).toContain("consent or credentials");
	expect(reason).toContain(
		"Delegation: codex work-version=2 <bounded delegation note>",
	);
	expect(dispatchSkip(work, [note])).toBeUndefined();
	expect(dispatchSkip({ ...work, version: 3 }, [note])).toContain(
		"owner comment",
	);
	expect(dispatchSkip({ ...work, accountableOwnerId: null }, [note])).toContain(
		"no accountable user owner",
	);
	for (const description of [
		"Complete the OAuth consent for the new connector.",
		"Enter the password and approve MFA on the owner's phone.",
	])
		expect(dispatchSkip({ ...item(), description }, [note])).toBe(
			"Consent, MFA and user presence remain human-only",
		);
});
it("takes no slot count and pins selectors without persisting inherited identity or credentials", () => {
	const args = ["--executor", "codex", "--rules", projectId];
	const env = { TEDIX_WORKSPACE: "acme", TEDIX_ORGANIZATION: "org_acme" };
	expect(() => parseServeOptions([...args, "--max", "3"], env)).toThrow(
		"Unknown serve option --max",
	);
	expect(parseServeOptions([...args, "--coordinated"], env).coordinated).toBe(
		true,
	);
	// No organization skill is assumed: the inherited runner rules are enough.
	expect(parseServeOptions(["--executor", "codex"], env).rules).toBeUndefined();
	expect(() =>
		parseServeOptions(
			[...args, "--organization", "org_acme", "--organization", "org_other"],
			env,
		),
	).toThrow("Conflicting");
	const duty = runnerDutyFromServeOptions(
		parseServeOptions([...args, "--repo", "/repo/a&b"], env),
	);
	expect(duty).toMatchObject({
		workspace: "acme",
		organization: "org_acme",
		executor: "codex",
		rules: projectId,
		repo: "/repo/a&b",
		enabled: true,
	});
	// A duty round-trips through the arguments the supervisor starts it with.
	const served = runnerServeArgs(duty);
	expect(served.slice(4, 6)).toEqual(["lane", "serve"]);
	expect(
		runnerDutyFromServeOptions(
			parseServeOptions([...served.slice(0, 4), ...served.slice(6)], {}),
		),
	).toEqual(duty);
	// A dispatcher installed as its own LaunchAgent before is read back as a duty.
	const plist = `<plist><dict><key>ProgramArguments</key><array>${[
		"/bin/tedix",
		"--organization",
		"org_acme",
		"--workspace",
		"acme",
		"lane",
		"serve",
		...args,
		"--repo",
		"/repo/a&amp;b",
		"--accept-proposed",
		"--project",
		projectId,
	]
		.map((arg) => `<string>${arg}</string>`)
		.join(
			"",
		)}</array><key>EnvironmentVariables</key><dict><key>TEDIX_MCP_BEARER_TOKEN</key><string>secret</string></dict></dict></plist>`;
	expect(
		runnerDutyFromPlist(plist, (served) => parseServeOptions(served, {})),
	).toMatchObject({
		organization: "org_acme",
		repo: "/repo/a&b",
		acceptProposed: true,
		project: projectId,
	});
	expect(
		runnerDutyFromPlist("<plist><dict></dict></plist>", (served) =>
			parseServeOptions(served, {}),
		),
	).toBeUndefined();
	expect(
		laneChildEnv({
			...env,
			CODEX_THREAD_ID: "parent",
			TEDIX_EXTERNAL_AGENT: "parent",
		}),
	).toEqual(env);
});
it("runs due heartbeats before queued normal calls without overlapping the current call", async () => {
	const queue = serialCalls();
	const events: string[] = [];
	let release!: () => void;
	const first = queue(async () => {
		events.push("current");
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		events.push("finished");
	});
	await until(() => Boolean(release));
	const normal = queue(async () => {
		events.push("normal");
	});
	const heartbeat = queue(async () => {
		events.push("heartbeat");
	}, true);
	const nextHeartbeat = queue(async () => {
		events.push("next-heartbeat");
	}, true);
	expect(events).toEqual(["current"]);
	release();
	await Promise.all([first, normal, heartbeat, nextHeartbeat]);
	expect(events).toEqual([
		"current",
		"finished",
		"heartbeat",
		"next-heartbeat",
		"normal",
	]);
});

it("admits a queued read during a continuing stream of urgent renewals", async () => {
	const queue = serialCalls();
	const events: string[] = [];
	let release!: () => void;
	const current = queue(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await until(() => Boolean(release));
	const read = queue(async () => {
		events.push("read");
	});
	const renewals: Promise<void>[] = [];
	const renew = () => {
		renewals.push(
			queue(async () => {
				events.push("renew");
				if (renewals.length < 12) renew();
			}, true),
		);
	};
	renew();
	release();
	await read;
	expect(events.slice(0, 4)).toEqual(["renew", "renew", "renew", "read"]);
	await until(() => events.length === 13);
	await Promise.all([current, ...renewals]);
});

it("serializes calls and releases the queue after an error", async () => {
	const queue = serialCalls();
	const events: string[] = [];
	const a = queue(async () => {
		events.push("a");
		throw new Error("failure");
	});
	const b = queue(async () => {
		events.push("b");
		return 1;
	});
	await expect(a).rejects.toThrow("failure");
	expect(await b).toBe(1);
	expect(events).toEqual(["a", "b"]);
});

it("keeps three calls in flight while a slow preparation is blocked", async () => {
	const queue = serialCalls(3);
	const releases: Array<() => void> = [];
	let active = 0;
	let peak = 0;
	const calls = Array.from({ length: 15 }, () =>
		queue(async () => {
			peak = Math.max(peak, ++active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active--;
		}),
	);
	await until(() => releases.length === 3);
	expect(active).toBe(3);
	// Leave the first preparation blocked while the other slots drain.
	for (let i = 1; i < 15; i++) {
		await until(() => releases.length > i);
		releases[i]!();
	}
	expect(peak).toBe(3);
	releases[0]!();
	await Promise.all(calls);
	expect(active).toBe(0);
});

it("defers a future planned start and reuses only a canonically failed Work's retained tree", () => {
	expect(
		dispatchSkip({
			...item(),
			startAt: new Date(Date.now() + 60000).toISOString(),
		}),
	).toContain("scheduled");
	const dir = mkdtempSync(join(tmpdir(), "lane-resume-test-"));
	dirs.push(dir);
	const repo = join(dir, "runs", "old", "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "unfinished.txt"), "Preserve this work");
	writeFileSync(
		join(dir, "old.json"),
		JSON.stringify({
			itemId: item().id,
			version: 1,
			phase: "settled",
			attemptId: "failed-attempt",
			repo,
		}),
	);
	expect(
		retainedLaneWorktree(dir, item().id, [
			{ id: "failed-attempt", outcome: "failed" },
		])?.repo,
	).toBe(repo);
	expect(
		retainedLaneWorktree(dir, item().id, [
			{ id: "failed-attempt", outcome: "succeeded" },
		]),
	).toBeUndefined();
	expect(
		retainedLaneWorktree(dir, item(2).id, [
			{ id: "failed-attempt", outcome: "failed" },
		]),
	).toBeUndefined();
	expect(readFileSync(join(repo, "unfinished.txt"), "utf8")).toBe(
		"Preserve this work",
	);
});

it("any-local accepts either native executor but never human or tedi Work", () => {
	const parsed = parseServeOptions([
		"--executor",
		"any-local",
		"--workspace",
		"acme",
		"--organization",
		"org-acme",
	]);
	expect(parsed.executor).toBe("any-local");
	for (const executor of ["codex", "claude-code"])
		expect(
			dispatchSkip({ ...item(), metadata: { executor } }, [], "any-local"),
		).toBeUndefined();
	for (const executor of ["human", "tedi"])
		expect(
			dispatchSkip({ ...item(), metadata: { executor } }, [], "any-local"),
		).toContain("not assigned");
	expect(
		dispatchSkip(
			{
				...item(),
				executorType: "human",
				executorId: "codex",
				metadata: {},
			},
			[],
			"any-local",
		),
	).toContain("not assigned");
});

it("any-local runs native Claude and Codex Attempts side by side", async () => {
	const { dispatcher, events, releases } = fixture({ executor: "any-local" });
	await dispatcher.tick();
	await until(() => releases.length === 3);
	const starts = events.filter((e) => e.verb === "start" && !e.input);
	expect(
		starts.map((e) => e.env.TEDIX_AGENT_SESSION?.split(":")[0]).sort(),
	).toEqual(["claude-code", "codex", "codex"]);
	await dispatcher.tick();
	expect(releases).toHaveLength(3);
	for (const done of releases) done();
	await dispatcher.drain();
	expect(events.filter((e) => e.verb === "settle")).toHaveLength(3);
});

it("any-local requests delegation for the assigned native executor", () => {
	expect(
		dispatchSkip(
			{ ...item(), title: "Summarize email fixtures" },
			[],
			"any-local",
		),
	).toBeUndefined();
	const reserved = { ...item(), title: "Send an email to a customer" };
	expect(dispatchSkip(reserved, [], "any-local")).toContain(
		"Delegation: codex work-version=2",
	);
	const comment = {
		authorType: "user" as const,
		authorId: "fictional-owner",
		body: "Delegation: codex work-version=2 Summarize fictional fixtures only.",
	};
	expect(dispatchSkip(reserved, [comment], "any-local")).toBeUndefined();
	expect(
		dispatchSkip(
			reserved,
			[{ ...comment, body: comment.body.replace("codex", "any-local") }],
			"any-local",
		),
	).toContain("needs an owner comment");
});

function gitFixture(withOrigin = false, autoCleanup = true) {
	const root = mkdtempSync(join(tmpdir(), "lane-git-test-"));
	if (autoCleanup) dirs.push(root);
	const repo = join(root, "source");
	mkdirSync(repo);
	const git = (args: string[], cwd = repo) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	git(["init", "-b", "main"]);
	git(["config", "user.name", "Test"]);
	git(["config", "user.email", "test@example.com"]);
	git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"]);
	if (withOrigin) {
		const remote = join(root, "origin.git");
		git(["init", "--bare", remote]);
		git(["remote", "add", "origin", remote]);
		git(["push", "origin", "main"]);
	}
	return { root, repo, git };
}

it("requires the deployed revision to contain every landed commit", async () => {
	const { root, repo, git } = gitFixture(true);
	const previous = git(["rev-parse", "HEAD"]);
	const commit = (message: string) => {
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			message,
		]);
		return git(["rev-parse", "HEAD"]);
	};
	const first = commit("first landed commit");
	const second = commit("second landed commit");
	const descendant = commit("deployed descendant");
	git(["push", "origin", "main"]);
	const env = {
		TEDIX_CONFIG_DIR: join(root, "config"),
		TEDIX_API_URL: "https://api.example.test:8443/v1/",
		TEDIX_MCP_URL: undefined,
		TEDIX_LANE_VERIFY_HEALTH_URLS: undefined,
	};
	const previousEnv = Object.keys(env).map(
		(key) => [key, process.env[key]] as const,
	);
	fixtureCleanup.push(async () => {
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	writeWorkspaceCredentials("acme", {
		loginId: "fixture",
		mcpUrl: "https://gateway.example.test/connect/mcp?tenant=acme",
	});
	const check = (deployedSha: string) =>
		landedDeployments(
			repo,
			[first, second],
			undefined,
			options.scope,
			async () => Response.json({ deployedSha }),
		);
	await expect(check(descendant)).resolves.toEqual([
		{ url: "https://api.example.test:8443/health", sha: descendant },
		{ url: "https://gateway.example.test/health", sha: descendant },
	]);

	const url = "https://live.example.test/custom-health";
	process.env.TEDIX_LANE_VERIFY_HEALTH_URLS = `  ${url}  ${url}  `;
	await expect(check(previous)).rejects.toThrow("does not prove deployment");
	await expect(check(first)).rejects.toThrow(second);
	await expect(check(descendant)).resolves.toEqual([{ url, sha: descendant }]);
});

it("renews ten runs during slow Git preparation, cleanup and proof inspection", async () => {
	const { root, repo, git } = gitFixture(true);
	const head = git(["rev-parse", "HEAD"]);
	const realGit = Bun.which("git")!;
	const bin = join(root, "bin");
	const marker = join(root, "slow-next");
	const entered = join(root, "git-entered");
	const released = join(root, "git-released");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh
if [ -f '${marker}' ]; then
  rm '${marker}'
  touch '${entered}'
  polls=0
  while [ ! -f '${released}' ] && [ "$polls" -lt 250 ]; do
    sleep 0.02
    polls=$((polls + 1))
  done
  [ -f '${released}' ] || exit 124
fi
exec '${realGit}' "$@"
`,
		{ mode: 0o755 },
	);
	const f = fixture();
	f.items.splice(
		0,
		f.items.length,
		...Array.from({ length: 10 }, (_, i) => item(i + 1)),
	);
	f.control.heartbeatExpiry = true;
	const interval = globalThis.setInterval;
	const intervals = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		ms: number,
	) => interval(callback, ms === 60_000 ? 100 : ms)) as typeof setInterval);
	let releaseRead!: () => void;
	let releaseRenewal!: () => void;
	let readBlocked = false;
	let renewalBlocked = false;
	const cli = f.deps.cli!;
	f.deps.cli = async (args, ...rest) => {
		if (args[5] === "dispatch-get" && args[6] === "blocked-read") {
			readBlocked = true;
			await new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
		}
		if (args[5] === "heartbeat" && args[6] === item(1).id && !renewalBlocked) {
			renewalBlocked = true;
			await new Promise<void>((resolve) => {
				releaseRenewal = resolve;
			});
		}
		return cli(args, ...rest);
	};
	const dispatcher = f.restart();
	const previousPath = process.env.PATH;
	const renewingIds = new Set(f.items.slice(1).map((entry) => entry.id));
	let reading: Promise<unknown> | undefined;
	try {
		await dispatcher.tick();
		await until(() => f.releases.length === 10);
		reading = dispatcher["call"](["work", "dispatch-get", "blocked-read"]);
		await until(() => readBlocked && renewalBlocked, 500);
		process.env.PATH = `${bin}:${previousPath}`;
		const destination = join(root, "checkout");
		const phases = [
			() => provisionLaneWorktree(repo, destination),
			() => cleanupLaneWorktree(repo, destination, () => false),
			() => mainLaneCommits(repo, [head]),
		];
		for (const phase of phases) {
			rmSync(entered, { force: true });
			rmSync(released, { force: true });
			writeFileSync(marker, "slow");
			let finished = false;
			const working = phase().finally(() => {
				finished = true;
			});
			void working.catch(() => {});
			try {
				await until(() => finished || existsSync(entered), 500);
				expect(finished).toBe(false);
				const offset = f.events.length;
				const renewed = () =>
					new Set(
						f.events
							.slice(offset)
							.filter((event) => event.verb === "heartbeat")
							.map((event) => event.args[6]),
					);
				await until(() => finished || renewed().size >= renewingIds.size, 500);
				expect(finished).toBe(false);
				expect(renewed()).toEqual(renewingIds);
			} finally {
				writeFileSync(released, "");
				await working;
			}
		}
		releaseRenewal();
		await until(() =>
			f.events.some(
				(event) => event.verb === "heartbeat" && event.args[6] === item(1).id,
			),
		);
		const log = readFileSync(join(f.dir, "dispatcher.log"), "utf8");
		expect(log).not.toContain('"event":"lease-check-delayed"');
		expect(log).not.toContain('"event":"lease-expired"');
		expect(log).not.toContain('"event":"heartbeat-failed"');
	} finally {
		process.env.PATH = previousPath;
		releaseRead?.();
		releaseRenewal?.();
		await reading;
		for (const release of f.releases) release();
		await dispatcher.drain();
		intervals.mockRestore();
	}
}, 30_000);

it.each([false, true])(
	"refreshes a stale source before cutting a run (retry=%s)",
	async (retry) => {
		const { root, repo, git } = gitFixture(true);
		const destination = join(root, "repo");
		if (retry) git(["worktree", "add", "--detach", destination]);
		const stale = git(["rev-parse", "HEAD"]);
		const publisher = join(root, "publisher");
		git(["clone", "--branch", "main", join(root, "origin.git"), publisher]);
		writeFileSync(join(publisher, "fresh.txt"), "latest main");
		git(["add", "fresh.txt"], publisher);
		git(
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-m",
				"advance main",
			],
			publisher,
		);
		git(["push", "origin", "main"], publisher);
		const current = git(["rev-parse", "HEAD"], publisher);
		expect(git(["rev-parse", "origin/main"])).toBe(stale);
		expect(await provisionLaneWorktree(repo, destination)).toBe(destination);
		expect(git(["rev-parse", "HEAD"], destination)).toBe(current);
		expect(git(["rev-parse", "HEAD"])).toBe(current);
		expect(readFileSync(join(destination, "fresh.txt"), "utf8")).toBe(
			"latest main",
		);
	},
	30_000,
);

it.each(["dirty", "unlanded"])(
	"bases runs on origin/main while preserving a %s source",
	async (state) => {
		const { root, repo, git } = gitFixture(true);
		const stale = git(["rev-parse", "HEAD"]);
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"advance main",
		]);
		git(["push", "origin", "main"]);
		const current = git(["rev-parse", "origin/main"]);
		git(["checkout", "--detach", stale]);
		writeFileSync(join(repo, "retained.txt"), "source work");
		if (state === "unlanded") {
			git(["add", "retained.txt"]);
			git(["-c", "commit.gpgsign=false", "commit", "-m", "unlanded"]);
		}
		const sourceHead = git(["rev-parse", "HEAD"]);
		const destination = await provisionLaneWorktree(repo, join(root, "repo"));
		expect(git(["rev-parse", "HEAD"], destination)).toBe(current);
		expect(git(["rev-parse", "HEAD"])).toBe(sourceHead);
		expect(readFileSync(join(repo, "retained.txt"), "utf8")).toBe(
			"source work",
		);
		expect(existsSync(join(destination, "retained.txt"))).toBe(false);
	},
	30_000,
);

it("does not cut a stale run when origin cannot be fetched", async () => {
	const { root, repo, git } = gitFixture(true);
	git(["remote", "set-url", "origin", join(root, "missing.git")]);
	const destination = join(root, "repo");
	await expect(provisionLaneWorktree(repo, destination)).rejects.toThrow();
	expect(existsSync(destination)).toBe(false);
}, 30_000);

it.each(["slow", "failing"])(
	"clears a %s worktree add, says what happened and lets the next try succeed",
	async (mode) => {
		const { root, repo, git } = gitFixture(true);
		const destination = join(root, "repo");
		// Git runs this hook at the end of `worktree add`, after the checkout
		// exists and while its registration is still locked as initializing.
		const hook = join(repo, ".git", "hooks", "post-checkout");
		writeFileSync(
			hook,
			mode === "slow"
				? "#!/bin/sh\nsleep 3\n"
				: "#!/bin/sh\necho 'disk quota exceeded' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		let ticks = 0;
		const ticking = setInterval(() => ticks++, 20);
		const failure = await provisionLaneWorktree(
			repo,
			destination,
			mode === "slow" ? 1_000 : undefined,
		).catch((error: Error) => error);
		clearInterval(ticking);
		expect(String(failure)).toContain(
			mode === "slow"
				? "git worktree add failed: timed out after 1 s"
				: "git worktree add failed: disk quota exceeded",
		);
		// The runner's timers kept firing while Git worked.
		if (mode === "slow") expect(ticks).toBeGreaterThan(10);
		expect(existsSync(destination)).toBe(false);
		expect(git(["worktree", "list", "--porcelain"])).not.toContain(destination);
		rmSync(hook);
		expect(await provisionLaneWorktree(repo, destination)).toBe(destination);
		expect(readdirSync(root).some((name) => name.includes("orphan"))).toBe(
			false,
		);
	},
	30_000,
);

it("preserves an orphan destination and provisions the retry path", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	mkdirSync(destination);
	writeFileSync(join(destination, "retained.txt"), "unfinished work");
	await provisionLaneWorktree(repo, destination);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(
		git(["rev-parse", "HEAD"]),
	);
	const orphan = readdirSync(root).find((name) =>
		name.startsWith("repo.orphan-"),
	)!;
	expect(readFileSync(join(root, orphan, "repo", "retained.txt"), "utf8")).toBe(
		"unfinished work",
	);
}, 30_000);

it("keeps a dirty registered worktree for inspection and provisions the retry beside it", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	writeFileSync(join(destination, "retained.txt"), "unfinished work");
	const retry = await provisionLaneWorktree(repo, destination);
	expect(retry).toBe(`${destination}-2`);
	expect(git(["rev-parse", "HEAD"], retry)).toBe(git(["rev-parse", "HEAD"]));
	expect(readFileSync(join(destination, "retained.txt"), "utf8")).toBe(
		"unfinished work",
	);
	// Every later retry gets its own path; no checkout is reused while dirty.
	writeFileSync(join(retry, "second.txt"), "second attempt");
	expect(await provisionLaneWorktree(repo, destination)).toBe(
		`${destination}-3`,
	);
	expect(readFileSync(join(retry, "second.txt"), "utf8")).toBe(
		"second attempt",
	);
}, 30_000);

it("keeps a registered worktree holding unlanded commits and provisions beside it", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	git(
		["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "local"],
		destination,
	);
	const local = git(["rev-parse", "HEAD"], destination);
	expect(await provisionLaneWorktree(repo, destination)).toBe(
		`${destination}-2`,
	);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(local);
}, 30_000);

it("records and preserves an unpushed commit until origin/main contains it", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = await provisionLaneWorktree(repo, join(root, "repo"));
	git(
		[
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"queued commit",
		],
		destination,
	);
	const sha = git(["rev-parse", "HEAD"], destination);
	expect(await unpushedLaneCommits(destination)).toEqual([sha]);
	expect(await cleanupLaneWorktree(repo, destination, () => false)).toBe(false);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(sha);
	git(["push", "origin", "HEAD:main"], destination);
	expect(await unpushedLaneCommits(destination)).toEqual([]);
	expect(await cleanupLaneWorktree(repo, destination, () => false)).toBe(true);
}, 30_000);

it("evicts a stale checkout that still holds work, saving it under a ref first", async () => {
	const { root, repo, git } = gitFixture(true);
	const run = join(root, "item-2");
	mkdirSync(run);
	const destination = await provisionLaneWorktree(repo, join(run, "repo"));
	git(
		["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "rebased"],
		destination,
	);
	writeFileSync(join(destination, ".commit-msg.tmp"), "scratch");
	// Fresh work stays even under eviction: it may still be retried or pushed.
	expect(await cleanupLaneWorktree(repo, destination, () => false, true)).toBe(
		false,
	);
	utimesSync(destination, 1, 1);
	expect(await cleanupLaneWorktree(repo, destination, () => false)).toBe(false);
	expect(await cleanupLaneWorktree(repo, destination, () => false, true)).toBe(
		true,
	);
	expect(existsSync(destination)).toBe(false);
	const saved = "refs/lane-evicted/item-2/repo";
	expect(git(["log", "--format=%s", "-2", saved])).toBe(
		"Evicted checkout snapshot\nrebased",
	);
	expect(git(["show", `${saved}:.commit-msg.tmp`])).toBe("scratch");
}, 30_000);

it("evicts a stale checkout whose only changes are ignored files", async () => {
	const { root, repo, git } = gitFixture(true);
	const run = join(root, "item-4");
	mkdirSync(run);
	const destination = await provisionLaneWorktree(repo, join(run, "repo"));
	const common = resolve(
		destination,
		git(["rev-parse", "--git-common-dir"], destination),
	);
	mkdirSync(join(common, "info"), { recursive: true });
	writeFileSync(join(common, "info", "exclude"), "*.generated.json\n");
	writeFileSync(join(destination, "wrangler.local.generated.json"), "{}");
	utimesSync(destination, 1, 1);
	expect(await cleanupLaneWorktree(repo, destination, () => false, true)).toBe(
		true,
	);
	expect(existsSync(destination)).toBe(false);
}, 30_000);

it("deletes a stale folder Git no longer knows only under eviction", async () => {
	const { root, repo } = gitFixture(true);
	const destination = join(root, "repo");
	mkdirSync(destination);
	writeFileSync(join(destination, "README.md"), "leftover");
	utimesSync(destination, 1, 1);
	expect(await cleanupLaneWorktree(repo, destination, () => false)).toBe(false);
	expect(await cleanupLaneWorktree(repo, destination, () => false, true)).toBe(
		true,
	);
	expect(existsSync(destination)).toBe(false);
});

it("counts a checkout whose folder is already gone as removed and frees its path", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = await provisionLaneWorktree(repo, join(root, "repo"));
	rmSync(destination, { recursive: true });
	// The dispatcher's lock keeps the registration through `worktree prune`.
	git(["worktree", "prune"]);
	expect(git(["worktree", "list", "--porcelain"])).toContain(
		"locked Tedix dispatcher checkout",
	);
	const reasons: string[] = [];
	expect(
		await cleanupLaneWorktree(
			repo,
			destination,
			() => false,
			false,
			(reason) => reasons.push(reason),
		),
	).toBe(true);
	expect(reasons).toEqual([]);
	expect(git(["worktree", "list", "--porcelain"])).not.toContain("locked");
	// The next run gets the same path instead of a `repo-2` sibling.
	expect(await provisionLaneWorktree(repo, join(root, "repo"))).toBe(
		destination,
	);
}, 30_000);

it("saves the files of a checkout that lost its Git registration before deleting it", async () => {
	const { root, repo, git } = gitFixture(true);
	const run = join(root, "item-3");
	mkdirSync(run);
	const destination = await provisionLaneWorktree(repo, join(run, "repo"));
	writeFileSync(join(destination, "finished.txt"), "work");
	const registration = readFileSync(join(destination, ".git"), "utf8").match(
		/^gitdir: (.+)$/m,
	)![1]!;
	rmSync(registration, { recursive: true });
	utimesSync(destination, 1, 1);
	const reasons: string[] = [];
	expect(
		await cleanupLaneWorktree(
			repo,
			destination,
			() => false,
			false,
			(reason) => reasons.push(reason),
		),
	).toBe(false);
	// Git's wording for a lost registration differs between versions.
	expect(reasons[0]).toStartWith("git cannot read the checkout: fatal: ");
	expect(await cleanupLaneWorktree(repo, destination, () => false, true)).toBe(
		true,
	);
	expect(existsSync(destination)).toBe(false);
	const saved = "refs/lane-evicted/item-3/repo";
	expect(git(["show", `${saved}:finished.txt`])).toBe("work");
	expect(git(["log", "--format=%s", "-1", saved])).toBe(
		"Evicted checkout snapshot",
	);
	// The source checkout's own index and files are untouched.
	expect(git(["status", "--porcelain"])).toBe("");

	// A checkout that never finished holds nothing `origin/main` lacks.
	const halfMade = join(root, "item-4", "repo");
	mkdirSync(halfMade, { recursive: true });
	writeFileSync(join(halfMade, ".git"), `gitdir: ${registration}\n`);
	utimesSync(halfMade, 1, 1);
	expect(await cleanupLaneWorktree(repo, halfMade, () => false, true)).toBe(
		true,
	);
	expect(existsSync(halfMade)).toBe(false);
	expect(() => git(["rev-parse", "refs/lane-evicted/item-4/repo"])).toThrow();
}, 30_000);

it("reuses a clean registered worktree left by a failed admission at fresh origin/main", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	git(["worktree", "add", "--detach", destination]);
	git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "next"]);
	git(["push", "origin", "main"]);
	expect(await provisionLaneWorktree(repo, destination)).toBe(destination);
	expect(git(["rev-parse", "HEAD"], destination)).toBe(
		git(["rev-parse", "HEAD"]),
	);
	expect(existsSync(`${destination}-2`)).toBe(false);
}, 30_000);

it.each([false, true])(
	"keeps the checkout locked from provisioning until the dispatcher removes it (reused=%s)",
	async (reused) => {
		const { root, repo, git } = gitFixture(true);
		const destination = join(root, "repo");
		if (reused) await provisionLaneWorktree(repo, destination);
		expect(await provisionLaneWorktree(repo, destination)).toBe(destination);
		expect(git(["worktree", "list", "--porcelain"])).toContain(
			"locked Tedix dispatcher checkout",
		);
		// A lane worker following worktree-closeout cannot remove it before proof.
		expect(() => git(["worktree", "remove", destination])).toThrow(/locked/);
		expect(existsSync(destination)).toBe(true);
		expect(await cleanupLaneWorktree(repo, destination, () => false)).toBe(
			true,
		);
		expect(existsSync(destination)).toBe(false);
	},
	30_000,
);

it("keeps its own lock when dispatcher cleanup cannot remove the checkout", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = await provisionLaneWorktree(repo, join(root, "repo"));
	writeFileSync(join(destination, "unsaved.txt"), "work");
	expect(await cleanupLaneWorktree(repo, destination, () => false)).toBe(false);
	expect(git(["worktree", "list", "--porcelain"])).toContain(
		"locked Tedix dispatcher checkout",
	);
}, 30_000);

it("extracts and deduplicates final-message and local commits, accepting only origin/main ancestors", async () => {
	const { root, repo, git } = gitFixture();
	const base = git(["rev-parse", "HEAD"]);
	const remote = join(root, "origin.git");
	git(["init", "--bare", remote]);
	git(["remote", "add", "origin", remote]);
	git([
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"landed",
	]);
	const landed = git(["rev-parse", "HEAD"]);
	git(["push", "origin", "main"]);
	git([
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"unpublished",
	]);
	const unpublished = git(["rev-parse", "HEAD"]);
	expect(await landedLaneCommits(repo, base, "")).toEqual([landed]);
	expect(
		await landedLaneCommits(
			repo,
			base,
			`Result ${landed} ${unpublished} ${"f".repeat(40)}`,
		),
	).toEqual([landed]);
	// Guarded push can rebase/reset the lane, so its final message is also evidence input.
	git(["reset", "--hard", base]);
	expect(await landedLaneCommits(repo, base, `Result ${landed}`)).toEqual([
		landed,
	]);
	// A main commit that predates the lane's base is not this lane's result.
	expect(
		await landedLaneCommits(repo, landed, `Rebased onto ${landed}`),
	).toEqual([]);
	await expect(landedLaneCommits(repo, "f".repeat(40), "")).rejects.toThrow();
});

it("rechecks collected commit reachability and retains unknown proof on Git failure", async () => {
	const { root, repo, git } = gitFixture(true);
	const landed = git(["rev-parse", "HEAD"]);
	git([
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"Unpushed",
	]);
	const unpushed = git(["rev-parse", "HEAD"]);
	expect(await mainLaneCommits(repo, [landed, unpushed])).toEqual([landed]);
	await expect(mainLaneCommits(repo, ["f".repeat(40)])).rejects.toThrow(
		LaneCommitFetchError,
	);
	git(["remote", "set-url", "origin", join(root, "unavailable.git")]);
	await expect(mainLaneCommits(repo, [landed])).rejects.toThrow(
		LaneCommitFetchError,
	);
});

it("accepts cited existing commits only when each is on origin/main and the checkout holds no change of its own", async () => {
	const { root, repo, git } = gitFixture();
	const commit = (subject: string) => {
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			subject,
		]);
		return git(["rev-parse", "HEAD"]);
	};
	const remote = join(root, "origin.git");
	git(["init", "--bare", remote]);
	git(["remote", "add", "origin", remote]);
	const tracked = "fix.txt";
	writeFileSync(join(repo, tracked), "fixed");
	git(["add", tracked]);
	const first = commit("earlier fix");
	const second = commit("later fix");
	git(["push", "origin", "main"]);
	expect(await existingLaneCommits(repo, [first, second])).toBeUndefined();
	expect(await existingLaneCommits(repo, [first, "f".repeat(40)])).toBe(
		"ffffffffffff is not on origin/main",
	);
	// Files the run only created, such as test output, are not a change.
	writeFileSync(join(repo, "test-output.log"), "passed");
	expect(await existingLaneCommits(repo, [first])).toBeUndefined();
	writeFileSync(join(repo, tracked), "changed by the run");
	expect(await existingLaneCommits(repo, [first])).toBe(
		"the checkout has uncommitted changes to tracked files",
	);
	git(["checkout", "--", tracked]);
	const unpushed = commit("not pushed");
	expect(await existingLaneCommits(repo, [first])).toBe(
		"the checkout has 1 commit that is not on origin/main",
	);
	// A commit that never reached main is no evidence, even when cited.
	expect(await existingLaneCommits(repo, [unpushed])).toBe(
		`${unpushed.slice(0, 12)} is not on origin/main`,
	);
	git(["reset", "--hard", second]);
	git(["remote", "set-url", "origin", join(root, "missing.git")]);
	await expect(existingLaneCommits(repo, [first])).rejects.toBeInstanceOf(
		LaneCommitFetchError,
	);
});

describe("historical commit custody", () => {
	const session = "codex:original-session";
	const { root, repo, git } = gitFixture(true, false);
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const commit = (trailers: string) => {
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			`Fix\n\n${trailers}`,
		]);
		return git(["rev-parse", "HEAD"]);
	};
	const sameWork = commit(`Work-Item: ${item().id}\nAgent-Session: ${session}`);
	const unrelated = commit(
		`Work-Item: ${item(2).id}\nAgent-Session: ${session}`,
	);
	const missing = commit(`Work-Item: ${item().id}`);
	const duplicate = commit(
		`Work-Item: ${item().id}\nWork-Item: ${item(2).id}\nAgent-Session: ${session}`,
	);
	git(["push", "origin", "main"]);
	const base = git(["rev-parse", "HEAD"]);
	const unlanded = commit(`Work-Item: ${item().id}\nAgent-Session: ${session}`);
	it("recovers cited same-Work history only with original session custody on origin/main", async () => {
		const verified: string[] = [];
		const recovery = {
			workItemId: item().id,
			verifySession: async (value: string) => {
				verified.push(value);
				return value === session;
			},
		};
		const fetched = { fetch: () => {}, sleep: async () => {} };
		const message = [sameWork, unrelated, missing, duplicate, unlanded].join(
			" ",
		);
		expect(await landedLaneCommits(repo, base, sameWork, fetched)).toEqual([]);
		expect(
			await landedLaneCommits(repo, base, message, fetched, recovery),
		).toEqual([sameWork]);
		expect(verified).toEqual([session]);
		git(["reset", "--hard", base]);
		expect(await landedLaneCommits(repo, base, "", fetched, recovery)).toEqual(
			[],
		);
		expect(
			await landedLaneCommits(repo, base, sameWork, fetched, {
				...recovery,
				verifySession: async () => false,
			}),
		).toEqual([]);
	});
});

it("finishes repository reads before awaiting recovered commit custody", async () => {
	const { repo, git } = gitFixture(true);
	const session = "codex:original-session";
	const commits = [1, 2].map(() => {
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			`Fix\n\nWork-Item: ${item().id}\nAgent-Session: ${session}`,
		]);
		return git(["rev-parse", "HEAD"]);
	});
	git(["push", "origin", "main"]);
	const base = git(["rev-parse", "HEAD"]);
	let removed = false;
	expect(
		await landedLaneCommits(
			repo,
			base,
			commits.join(" "),
			{
				fetch: () => {},
				sleep: async () => {},
			},
			{
				workItemId: item().id,
				verifySession: async () => {
					if (!removed) {
						removed = true;
						rmSync(repo, { recursive: true });
					}
					return true;
				},
			},
		),
	).toEqual(commits);
});

it.each([false, true])(
	"retries commit fetch with backoff, exhausted=%s",
	async (exhausted) => {
		const { repo, git } = gitFixture();
		const base = git(["rev-parse", "HEAD"]);
		const delays: number[] = [];
		let calls = 0;
		const proof = landedLaneCommits(repo, base, "b".repeat(40), {
			fetch: () => {
				if (++calls < 3 || exhausted) throw new Error("offline");
			},
			sleep: async (ms) => {
				delays.push(ms);
			},
		});
		if (exhausted)
			await expect(proof).rejects.toBeInstanceOf(LaneCommitFetchError);
		else expect(await proof).toEqual([]);
		expect(calls).toBe(3);
		expect(delays).toEqual([1000, 2000]);
	},
);

describe("retained run sweep", () => {
	const prepared = fixture({ autoCleanup: false });
	afterAll(async () => {
		await prepared.cleanup();
		rmSync(prepared.dir, { recursive: true, force: true });
	});
	const { dir, items, control } = prepared;
	items.splice(0);
	control.cleanupResult = false;
	for (let n = 10; n < 725; n++) {
		const old = item(n);
		const repo = join(dir, "runs", `${old.id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			join(dir, `${old.id}-2.json`),
			JSON.stringify({
				itemId: old.id,
				version: 2,
				phase: "settled",
				outcome: "failed",
				repo,
			}),
		);
	}
	it("queries ready work before sweeping every retained run checkout", async () => {
		const { dispatcher, dir, control } = prepared;
		await dispatcher.tick();
		await dispatcher.drain();
		// The startup sweep revisits every settled run in one pass instead of
		// reclaiming a single checkout per tick.
		expect(control.cleanups).toBe(715);
		expect(control.cleanupAfterPickup).toEqual(
			Array.from({ length: 715 }, () => true),
		);
		expect(dispatcher.nextTickDelayMs()).toBe(30_000);
		expect(
			existsSync(join(dir, "dispatcher.log")) &&
				readFileSync(join(dir, "dispatcher.log"), "utf8").includes(
					"worktree-retained",
				),
		).toBe(false);
	});
});

it("backs off retained cleanup and archives only removed run metadata", async () => {
	const { dispatcher, restart, dir, items, control } = fixture();
	items.splice(0);
	const repo = join(dir, "runs", "finished", "repo");
	mkdirSync(repo, { recursive: true });
	const path = join(dir, `${item().id}-2.json`);
	writeFileSync(
		path,
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "settled",
			outcome: "failed",
			repo,
		}),
	);
	control.cleanupResult = false;
	await dispatcher.tick();
	await dispatcher.tick();
	expect(control.cleanups).toBe(1);
	expect(existsSync(repo)).toBe(true);
	expect(existsSync(join(dir, "dispatcher.log"))).toBe(false);
	writeFileSync(join(dirname(repo), "last.txt"), "Result in OS");
	control.cleanupResult = true;
	control.cleanupRemoves = true;
	const recovering = restart();
	await recovering.tick();
	await recovering.drain();
	expect(existsSync(dirname(repo))).toBe(false);
	const archived = readdirSync(join(dir, "archive"));
	expect(archived).toHaveLength(1);
	expect(
		readFileSync(join(dir, "archive", archived[0]!, "last.txt"), "utf8"),
	).toBe("Result in OS");
});

it.each(["admitted", "unknown"])(
	"retries the same terminal failed Work with a foreign PID only when admission is %s",
	async (admissionState) => {
		const child = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 30000)"],
			{ detached: true, stdio: "ignore" },
		);
		await once(child, "spawn");
		const f = fixture();
		f.items.splice(1);
		const repo = join(f.dir, "runs", `${item().id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "checkpoint.txt"), "retain failed work");
		f.control.provisionError = new Error(
			"Retained failed checkout must be reused",
		);
		writeFileSync(
			join(f.dir, `${item().id}-2.json`),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "settled",
				outcome: "failed",
				admissionState,
				attemptId: "old-attempt",
				session: "codex:old-session",
				pid: child.pid,
				processIdentity: "old-process-identity",
				repo,
			}),
		);
		f.control.history.data = [
			{
				id: "old-attempt",
				externalSessionKey: "codex:old-session",
				outcome: "failed",
				metadata: { dispatchVersion: 2 },
			},
		];
		const signals = spyOn(process, "kill");
		try {
			await f.dispatcher.tick();
			if (admissionState === "admitted")
				await until(() => f.releases.length === 1);
			expect(f.releases).toHaveLength(admissionState === "admitted" ? 1 : 0);
			expect(readFileSync(join(repo, "checkpoint.txt"), "utf8")).toBe(
				"retain failed work",
			);
			expect(
				signals.mock.calls.filter(
					([pid, signal]) => Math.abs(pid) === child.pid && signal !== 0,
				),
			).toHaveLength(0);
		} finally {
			signals.mockRestore();
			for (const release of f.releases) release();
			await f.dispatcher.drain();
			const exited = once(child, "exit");
			process.kill(-child.pid!, "SIGTERM");
			await exited;
		}
	},
);

it.each(["succeeded", "failed"])(
	"only retries settled failures on the same revision: %s",
	async (outcome) => {
		const { dispatcher, dir, items, releases, events, control } = fixture();
		items.splice(1);
		writeFileSync(
			join(dir, `${item().id}-2.json`),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "settled",
				outcome,
				attemptId: "old-attempt",
				recheckAt: 0,
			}),
		);
		control.history.data = [
			{ id: "old-attempt", outcome, metadata: { dispatchVersion: 2 } },
		];
		await dispatcher.tick();
		if (outcome === "failed") {
			await until(() => releases.length === 1);
			releases[0]!();
		}
		await dispatcher.drain();
		expect(events.filter((e) => e.verb === "start" && e.input)).toHaveLength(
			outcome === "failed" ? 1 : 0,
		);
	},
);

it.each([
	"dirty",
	"unlanded",
	"live",
	"locked",
	"ignored",
	"landed",
	"emptied",
])("cleanup protects work and uses origin/main: %s", async (state) => {
	const { root, repo, git } = gitFixture(true);
	if (state === "emptied") {
		writeFileSync(join(repo, "tracked.txt"), "committed");
		git(["add", "tracked.txt"]);
		git(["-c", "commit.gpgsign=false", "commit", "-m", "track a file"]);
		git(["push", "origin", "main"]);
	}
	const destination = join(root, "runs", "finished", "repo");
	git(["worktree", "add", "--detach", destination]);
	if (state === "emptied") rmSync(join(destination, "tracked.txt"));
	if (state === "dirty")
		writeFileSync(join(destination, "unfinished.txt"), "keep");
	if (state === "unlanded" || state === "landed") {
		git(
			[
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"run work",
			],
			destination,
		);
		if (state === "landed") {
			git(["push", "origin", "HEAD:main"], destination);
			git(["fetch", "origin", "main"]);
			expect(git(["rev-parse", "HEAD"])).not.toBe(
				git(["rev-parse", "HEAD"], destination),
			);
		}
	}
	if (state === "locked") git(["worktree", "lock", destination]);
	if (state === "ignored") {
		writeFileSync(join(destination, ".gitignore"), ".env\n");
		git(["add", ".gitignore"], destination);
		git(
			["-c", "commit.gpgsign=false", "commit", "-m", "ignore local settings"],
			destination,
		);
		git(["push", "origin", "HEAD:main"], destination);
		git(["fetch", "origin", "main"]);
		writeFileSync(join(destination, ".env"), "LOCAL_SETTING=keep");
	}
	const removed = state === "landed" || state === "emptied";
	expect(
		await cleanupLaneWorktree(repo, destination, () => state === "live"),
	).toBe(removed);
	expect(existsSync(destination)).toBe(!removed);
});

it("reclaims one run directory per pass that no receipt refers to", async () => {
	const { dispatcher, dir, items, control } = fixture();
	items.splice(0);
	const current = item(1);
	const orphan = join(dir, "runs", `${current.id}-1`);
	const kept = join(dir, "runs", `${current.id}-2`);
	const briefOnly = join(dir, "runs", `${item(2).id}-3`);
	mkdirSync(join(orphan, "repo"), { recursive: true });
	mkdirSync(join(kept, "repo"), { recursive: true });
	mkdirSync(briefOnly, { recursive: true });
	writeFileSync(join(briefOnly, "brief.txt"), "Done");
	// The current receipt resumes the newer checkout; its directory stays.
	writeFileSync(
		join(dir, `${current.id}-3.json`),
		JSON.stringify({
			itemId: current.id,
			version: 3,
			phase: "deferred",
			outcome: "expired",
			admissionState: "admitted",
			attemptId: "attempt",
			session: "codex:fictional",
			repo: join(kept, "repo"),
		}),
	);
	control.cleanupRemoves = true;
	// The first pass sweeps every orphaned run directory; the retained
	// receipt's checkout keeps its directory.
	for (let pass = 0; pass < 3; pass++) {
		await dispatcher.tick();
		await dispatcher.drain();
	}
	expect(control.cleanups).toBe(1);
	expect(existsSync(orphan)).toBe(false);
	expect(existsSync(briefOnly)).toBe(false);
	expect(existsSync(kept)).toBe(true);
	expect(readdirSync(join(dir, "archive"))).toHaveLength(2);
	const log = readFileSync(join(dir, "dispatcher.log"), "utf8");
	expect(log).toContain('"event":"run-archived"');
	expect(log).not.toContain(kept);
});

it("keeps a run directory whose checkout cleanup refuses", async () => {
	const { dispatcher, dir, items, control } = fixture();
	items.splice(0);
	const run = join(dir, "runs", `${item(1).id}-1`);
	mkdirSync(join(run, "repo"), { recursive: true });
	control.cleanupResult = false;
	await dispatcher.tick();
	await dispatcher.drain();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.cleanups).toBe(1);
	expect(existsSync(join(run, "repo"))).toBe(true);
});

it("reports only repeated skips for accepted tasks assigned to the runner", async () => {
	const { dispatcher, dir, items } = fixture();
	writeDispatcherHealthSource(dir, options);
	const skipped = items[0]!;
	skipped.projectId = null;
	items[1]!.executorId = "devin";
	items[2]!.disposition = "proposed";
	const health = () =>
		JSON.parse(readFileSync(join(dir, "health-source.json"), "utf8")).skips;

	await dispatcher.tick();
	const firstPoll = health().observedAt;
	expect(health().entries).toEqual([]);
	await dispatcher.tick();
	expect(health().entries).toEqual([
		{ workItemId: skipped.id, reason: "Work has no project", since: firstPoll },
	]);

	skipped.projectId = item(1).projectId;
	skipped.activeAttempt = {
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	await dispatcher.tick();
	expect(health().entries).toEqual([]);
	await dispatcher.tick();
	expect(health().entries).toMatchObject([
		{ workItemId: skipped.id, reason: "Work already has a live Attempt" },
	]);
	items.splice(0);
	await dispatcher.tick();
	expect(health().entries).toEqual([]);
});

it("holds new admissions on low disk and still reclaims checkouts", async () => {
	const { dispatcher, dir, items, events, control } = fixture();
	items.splice(1);
	writeDispatcherHealthSource(dir, options);
	const run = join(dir, "runs", `${item(9).id}-1`);
	mkdirSync(join(run, "repo"), { recursive: true });
	control.freeDiskBytes = MIN_FREE_DISK_BYTES - 1;
	control.cleanupRemoves = true;
	await dispatcher.tick();
	await dispatcher.drain();
	expect(events.filter((e) => e.verb === "dispatch-list")).toHaveLength(0);
	expect(control.cleanups).toBe(1);
	expect(existsSync(run)).toBe(false);
	expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
		'"event":"disk-low"',
	);
	await dispatcher.tick();
	expect(
		JSON.parse(readFileSync(join(dir, "health-source.json"), "utf8")).skips
			.entries,
	).toMatchObject([
		{ workItemId: items[0]!.id, reason: "The runner is low on disk space" },
	]);
	expect(events.some((event) => event.verb === "start")).toBe(false);
	control.freeDiskBytes = MIN_FREE_DISK_BYTES;
	items.splice(0);
	await dispatcher.tick();
	await dispatcher.drain();
	expect(events.filter((e) => e.verb === "dispatch-list")).toHaveLength(1);
});

it("keeps polling and picking up unrelated work while a large worktree is removed", async () => {
	const { dispatcher, dir, items, control, releases } = fixture();
	const ready = items.splice(0);
	const old = item(99);
	const repo = join(dir, "runs", "old", "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(dir, `${old.id}-2.json`),
		JSON.stringify({
			itemId: old.id,
			version: 2,
			phase: "settled",
			outcome: "succeeded",
			repo,
		}),
	);
	let finish!: (value: boolean) => void;
	control.cleanupWait = new Promise<boolean>((resolve) => {
		finish = resolve;
	});
	await dispatcher.tick();
	expect(control.cleanups).toBe(1);
	items.push(ready[0]!);
	try {
		await dispatcher.tick();
		await until(() => releases.length === 1);
		expect(control.cleanups).toBe(1);
	} finally {
		finish(false);
		for (const release of releases) release();
		await dispatcher.drain();
	}
});

it("detects a live process inside a landed worktree independently of its receipt", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "runs", "old", "repo");
	git(["worktree", "add", "--detach", destination]);
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
		cwd: destination,
		detached: true,
		stdio: "ignore",
	});
	const ended = once(child, "exit");
	await once(child, "spawn");
	try {
		expect(await cleanupLaneWorktree(repo, destination)).toBe(false);
		expect(existsSync(destination)).toBe(true);
	} finally {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGTERM");
		await ended;
	}
});

it("keeps even an empty pending-proof marker fenced from retry and cleanup", async () => {
	const { dispatcher, dir, items, releases, control } = fixture();
	items.splice(1);
	const repo = join(dir, "runs", "pending", "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(dir, `${item().id}-2.json`),
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "settled",
			outcome: "failed",
			pendingCommitProof: "",
			repo,
		}),
	);
	await dispatcher.tick();
	await dispatcher.drain();
	expect(releases).toHaveLength(0);
	expect(control.cleanups).toBe(0);
	expect(existsSync(repo)).toBe(true);
});

it("sweeps every settled run and keeps each Work item's latest receipt", async () => {
	const { dispatcher, dir, items, control } = fixture();
	items.splice(0);
	const rows = [item(1), item(2)].map((work) => {
		const repo = join(dir, "runs", `${work.id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		const path = join(dir, `${work.id}-2.json`);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: work.id,
				version: 2,
				phase: "settled",
				outcome: "succeeded",
				repo,
			}),
		);
		return { repo, path };
	});
	control.cleanupRemoves = true;
	await dispatcher.tick();
	await dispatcher.drain();
	expect(control.cleanups).toBe(2);
	for (const row of rows) {
		expect(existsSync(row.repo)).toBe(false);
		expect(JSON.parse(readFileSync(row.path, "utf8")).phase).toBe("settled");
	}
	expect(readdirSync(join(dir, "archive"))).toHaveLength(2);
});

it.each([0, 3, 9])(
	"deletes only unprotected settled receipts from older Work revisions (cursor %i)",
	async (cursor) => {
		const { dispatcher, dir, items } = fixture();
		items.splice(0);
		const protectedRows = [
			{ pendingCommitProof: "" },
			// Keep reconciliation from consuming the protection this sweep tests.
			{ pendingObservation: {}, reportRetryAt: Number.MAX_SAFE_INTEGER },
			{ completionPending: true, completionRetryAt: Number.MAX_SAFE_INTEGER },
		];
		for (let n = 0; n <= protectedRows.length; n++) {
			const work = item(n + 1);
			for (const version of [1, 2])
				writeFileSync(
					join(dir, `${work.id}-${version}.json`),
					JSON.stringify({
						itemId: work.id,
						version,
						phase: "settled",
						outcome: "succeeded",
						...(version === 1 ? protectedRows[n - 1] : undefined),
					}),
				);
		}
		const runProtected = item(5);
		for (const version of [1, 2])
			writeFileSync(
				join(dir, `${runProtected.id}-${version}.json`),
				JSON.stringify({
					itemId: runProtected.id,
					version,
					phase: "settled",
					outcome: "succeeded",
				}),
			);
		mkdirSync(join(dir, "runs", `${runProtected.id}-1`, "repo"), {
			recursive: true,
		});

		dispatcher["reconciliationCursor"] = cursor;
		await dispatcher.tick();
		await dispatcher.drain();

		expect(existsSync(join(dir, `${item(1).id}-1.json`))).toBe(false);
		for (let n = 2; n <= 5; n++)
			expect(existsSync(join(dir, `${item(n).id}-1.json`))).toBe(true);
		for (let n = 1; n <= 5; n++)
			expect(existsSync(join(dir, `${item(n).id}-2.json`))).toBe(true);
		expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
			'"event":"receipts-pruned"',
		);
	},
);

it.each(["settled", "deferred"])(
	"keeps Work-recorded unpushed commits through %s cleanup and cap pressure",
	async (phase) => {
		const { repo: source, git } = gitFixture(true);
		const f = fixture({ capBytes: 1 });
		f.items.splice(0);
		f.control.runSize = 2;
		f.config.repo = source;
		delete f.deps.cleanup;
		const destination = join(f.dir, "runs", `${item().id}-2`, "repo");
		git(["worktree", "add", "--detach", destination]);
		git(
			[
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"queued work",
			],
			destination,
		);
		const sha = git(["rev-parse", "HEAD"], destination);
		const path = join(f.dir, `${item().id}-2.json`);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase,
				outcome: phase === "settled" ? "succeeded" : "expired",
				repo: destination,
				unpushedCommits: [sha],
				unpushedCommented: JSON.stringify([destination, [sha]]),
			}),
		);
		const dispatcher = f.restart();
		await dispatcher.tick();
		await dispatcher.drain();
		expect(existsSync(destination)).toBe(true);
		expect(git(["rev-parse", "HEAD"], destination)).toBe(sha);
		expect(JSON.parse(readFileSync(path, "utf8")).repo).toBe(destination);
		git(["push", "origin", "HEAD:main"], destination);
		expect(await cleanupLaneWorktree(source, destination, () => false)).toBe(
			true,
		);
	},
);

it("never sweeps or evicts a checkout whose Attempt process is still live", async () => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
		detached: true,
		stdio: "ignore",
	});
	await once(child, "spawn");
	try {
		const { dispatcher, dir, items, control } = fixture();
		items.splice(0);
		const repo = join(dir, "runs", `${item().id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			join(dir, `${item().id}-2.json`),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "settled",
				outcome: "failed",
				attemptId: "attempt",
				session: "codex:live",
				pid: child.pid,
				repo,
			}),
		);
		control.cleanupRemoves = true;
		control.runSize = 100 * 1024 ** 3;
		await dispatcher.tick();
		await dispatcher.drain();
		expect(control.cleanups).toBe(0);
		expect(existsSync(repo)).toBe(true);
	} finally {
		const exited = once(child, "exit");
		process.kill(-child.pid!, "SIGTERM");
		await exited;
	}
});

it("evicts the oldest removable run checkouts until the retained cap holds", async () => {
	const { dispatcher, dir, items, control } = fixture({
		capBytes: 5 * 1024 ** 3,
	});
	items.splice(0);
	const gb = 1024 ** 3;
	// Checkouts kept for an interrupted run's retry survive the ordinary
	// sweep; only cap pressure can evict them.
	const runs = [item(1), item(2), item(3)].map((work, n) => {
		const run = join(dir, "runs", `${work.id}-2`);
		const repo = join(run, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			join(dir, `${work.id}-2.json`),
			JSON.stringify({
				itemId: work.id,
				version: 2,
				phase: "deferred",
				outcome: "expired",
				admissionState: "admitted",
				attemptId: `attempt-${n}`,
				session: "codex:interrupted",
				repo,
			}),
		);
		utimesSync(run, n + 1, n + 1);
		control.runSizes.set(run, 3 * gb);
		return run;
	});
	control.cleanupRemoves = true;
	await dispatcher.tick();
	await dispatcher.drain();
	// 9 GB over a 5 GB cap frees the two oldest run directories; the newest
	// retained checkout stays.
	expect(existsSync(runs[0]!)).toBe(false);
	expect(existsSync(runs[1]!)).toBe(false);
	expect(existsSync(runs[2]!)).toBe(true);
	const log = readFileSync(join(dir, "dispatcher.log"), "utf8");
	expect(log).toContain('"event":"checkout-cap"');
	expect(log).toContain('"event":"checkout-evicted"');
});

it("admits ready high-priority opencode Work in one pass despite a refused checkout cap", async () => {
	const f = fixture({ executor: "opencode", capBytes: 1 });
	const ready = { ...f.items[0]!, priority: "high" as const };
	f.items.splice(0);
	const repo = join(f.dir, "runs", `${item(99).id}-2`, "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(f.dir, `${item(99).id}-2.json`),
		JSON.stringify({
			itemId: item(99).id,
			version: 2,
			phase: "settled",
			outcome: "failed",
			repo,
		}),
	);
	f.control.runSize = 42 * 1024 ** 3;
	f.control.cleanupResult = false;
	await f.dispatcher.tick();
	await f.dispatcher.drain();
	expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toContain(
		'"event":"checkout-cap-held"',
	);
	f.items.push(ready);
	await f.dispatcher.tick();
	await until(() => f.releases.length === 1);
	expect(
		f.events.filter(
			(event) => event.verb === "start" && event.args[4] === "work",
		),
	).toHaveLength(1);
	expect(existsSync(repo)).toBe(true);
	f.releases[0]!();
	await f.dispatcher.drain();
});

it("removes stale recovery folders and says when the cap cannot be met", async () => {
	const { dispatcher, dir, items, control } = fixture({ capBytes: 1 });
	items.splice(0);
	const run = join(dir, "runs", `${item().id}-2`);
	const sibling = join(dir, "runs", `${item().id}-3`);
	const stale = join(run, "repo.orphan-old");
	const fresh = join(run, "repo.orphan-new");
	const siblingFresh = join(sibling, "repo.orphan-new");
	mkdirSync(join(stale, "repo"), { recursive: true });
	mkdirSync(join(fresh, "repo"), { recursive: true });
	mkdirSync(join(siblingFresh, "repo"), { recursive: true });
	utimesSync(stale, 1, 1);
	control.runSize = 2;
	control.cleanupResult = false;
	await dispatcher.tick();
	await dispatcher.drain();
	expect(existsSync(stale)).toBe(false);
	expect(existsSync(fresh)).toBe(true);
	const log = readFileSync(join(dir, "dispatcher.log"), "utf8");
	expect(log).toContain('"event":"recovery-removed"');
	expect(log).toContain('"event":"checkout-cap-held"');
	expect(log).toContain("2 removable run folders refused removal");
	expect(log.match(/"event":"checkout-held"/g)).toHaveLength(2);
	expect(log).toContain(`${item().id}-2: refused`);
	expect(log).toContain(`${item().id}-3: refused`);
	expect(log).toContain("refused: it still has a checkout inside");
});

it("archives a run whose checkout is already gone and evicts the sibling an earlier try left", async () => {
	const { repo: source, git } = gitFixture(true);
	const f = fixture({ capBytes: 1 });
	f.items.splice(0);
	f.control.runSize = 2;
	f.config.repo = source;
	// This fixture has no worker; the live-child test exercises process detection.
	f.deps.cleanup = (source, destination, evict, refused) =>
		cleanupLaneWorktree(source, destination, () => false, evict, refused);
	// The checkout the receipt names was removed earlier; a recovery folder
	// kept the run folder then and is gone now. Only logs remain.
	const emptied = join(f.dir, "runs", `${item(1).id}-2`);
	mkdirSync(emptied, { recursive: true });
	writeFileSync(join(emptied, "brief.txt"), "brief");
	writeFileSync(
		join(f.dir, `${item(1).id}-2.json`),
		JSON.stringify({
			itemId: item(1).id,
			version: 2,
			phase: "settled",
			outcome: "succeeded",
			repo: join(emptied, "repo"),
		}),
	);
	// A retry moved to `repo-2`, which is gone; the first checkout still
	// holds a commit and a registration that was pruned.
	const run = join(f.dir, "runs", `${item(2).id}-2`);
	const sibling = join(run, "repo");
	git(["worktree", "add", "--detach", sibling]);
	git(
		["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "finished"],
		sibling,
	);
	const sha = git(["rev-parse", "HEAD"], sibling);
	const halfMade = join(run, "repo-3");
	mkdirSync(halfMade);
	writeFileSync(
		join(halfMade, ".git"),
		"gitdir: /nonexistent/worktrees/repo\n",
	);
	utimesSync(sibling, 1, 1);
	utimesSync(halfMade, 1, 1);
	writeFileSync(
		join(f.dir, `${item(2).id}-2.json`),
		JSON.stringify({
			itemId: item(2).id,
			version: 2,
			phase: "settled",
			outcome: "failed",
			repo: join(run, "repo-2"),
		}),
	);
	const dispatcher = f.restart();
	await dispatcher.tick();
	await dispatcher.drain();
	expect(existsSync(emptied)).toBe(false);
	expect(existsSync(run)).toBe(false);
	expect(git(["rev-parse", `refs/lane-evicted/${item(2).id}-2/repo`])).toBe(
		sha,
	);
	const log = readFileSync(join(f.dir, "dispatcher.log"), "utf8");
	expect(log).not.toContain("git cannot read the checkout");
	expect(log).not.toContain('"event":"checkout-held"');
	expect(
		readdirSync(join(f.dir, "archive"))
			.map((name) => name.slice(0, 38))
			.sort(),
	).toEqual([`${item(1).id}-2`, `${item(2).id}-2`]);
}, 30_000);

it("measures a finished run once, across sweeps and a runner restart", async () => {
	const f = fixture();
	f.items.splice(0);
	const run = join(f.dir, "runs", `${item().id}-2`);
	const repo = join(run, "repo");
	mkdirSync(repo, { recursive: true });
	// A checkout kept for a retry stays through every sweep.
	writeFileSync(
		join(f.dir, `${item().id}-2.json`),
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "deferred",
			outcome: "expired",
			admissionState: "admitted",
			attemptId: "attempt",
			session: "codex:interrupted",
			repo,
		}),
	);
	let measured = 0;
	f.deps.directoryBytes = async () => {
		measured++;
		return 1;
	};
	const sweep = async (dispatcher: LaneDispatcher) => {
		await dispatcher.tick();
		await dispatcher.drain();
	};
	const first = f.restart();
	await sweep(first);
	expect(measured).toBe(1);
	const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
	try {
		await sweep(first);
		await sweep(f.restart());
		expect(measured).toBe(1);
		// A new entry in the run directory changes what it holds.
		mkdirSync(join(run, "repo-2"));
		await sweep(f.restart());
		expect(measured).toBe(2);
	} finally {
		clock.mockRestore();
	}
});

it("retries a run folder it could not measure hourly, not on every sweep", async () => {
	const { restart, dir, items, deps } = fixture();
	items.splice(0);
	const repo = join(dir, "runs", `${item().id}-2`, "repo");
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(dir, `${item().id}-2.json`),
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "deferred",
			outcome: "expired",
			admissionState: "admitted",
			attemptId: "attempt",
			session: "codex:interrupted",
			repo,
		}),
	);
	let measured = 0;
	deps.directoryBytes = async () => {
		measured++;
		throw new Error("Command failed: du -sk");
	};
	const dispatcher = restart();
	const start = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(start);
	try {
		const measuredAfter = async (minutes: number) => {
			clock.mockReturnValue(start + minutes * 60_000);
			await dispatcher.tick();
			await dispatcher.drain();
			return measured;
		};
		expect(await measuredAfter(0)).toBe(1);
		expect(await measuredAfter(11)).toBe(1);
		expect(await measuredAfter(61)).toBe(2);
	} finally {
		clock.mockRestore();
	}
	expect(readFileSync(join(dir, "dispatcher.log"), "utf8")).toContain(
		'"event":"run-size-deferred"',
	);
});

it("waits longer after each refused checkout cleanup", async () => {
	const { dispatcher, dir, items, control } = fixture();
	items.splice(0);
	mkdirSync(join(dir, "runs", `${item().id}-1`, "repo"), { recursive: true });
	control.cleanupResult = false;
	const start = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(start);
	try {
		const cleanupsAfter = async (minutes: number) => {
			clock.mockReturnValue(start + minutes * 60_000);
			await dispatcher.tick();
			await dispatcher.drain();
			return control.cleanups;
		};
		expect(await cleanupsAfter(0)).toBe(1);
		expect(await cleanupsAfter(11)).toBe(2);
		// The second refusal doubles the wait to twenty minutes.
		expect(await cleanupsAfter(22)).toBe(2);
		expect(await cleanupsAfter(33)).toBe(3);
	} finally {
		clock.mockRestore();
	}
});

it("removes the checkouts earlier retries left beside the receipt's own", async () => {
	const { dispatcher, dir, items, control } = fixture();
	items.splice(0);
	const run = join(dir, "runs", `${item().id}-2`);
	for (const name of ["repo", "repo-2", "repo-3"])
		mkdirSync(join(run, name), { recursive: true });
	writeFileSync(
		join(dir, `${item().id}-2.json`),
		JSON.stringify({
			itemId: item().id,
			version: 2,
			phase: "deferred",
			outcome: "expired",
			admissionState: "admitted",
			attemptId: "attempt",
			session: "codex:interrupted",
			repo: join(run, "repo-3"),
		}),
	);
	control.cleanupRemoves = true;
	await dispatcher.tick();
	await dispatcher.drain();
	expect(readdirSync(run)).toEqual(["repo-3"]);
});

it("keeps only the newest archived run folders", async () => {
	const { dispatcher, dir, items } = fixture();
	items.splice(0);
	for (let n = 0; n < ARCHIVED_RUNS_KEPT + 2; n++)
		mkdirSync(join(dir, "archive", `${item(n).id}-2-${1000 + n}`), {
			recursive: true,
		});
	await dispatcher.tick();
	await dispatcher.drain();
	const kept = readdirSync(join(dir, "archive"));
	expect(kept).toHaveLength(ARCHIVED_RUNS_KEPT);
	expect(kept).not.toContain(`${item(0).id}-2-1000`);
	expect(kept).not.toContain(`${item(1).id}-2-1001`);
});

it("parses a retained-checkout cap from the flag or environment", () => {
	const args = ["--executor", "codex", "--rules", projectId];
	const env = { TEDIX_WORKSPACE: "acme", TEDIX_ORGANIZATION: "org_acme" };
	expect(
		parseServeOptions([...args, "--checkout-cap-gb", "25"], env)
			.checkoutCapBytes,
	).toBe(25 * 1024 ** 3);
	expect(
		parseServeOptions([...args, "--checkout-cap-gb", "0.5"], env)
			.checkoutCapBytes,
	).toBe(Math.round(0.5 * 1024 ** 3));
	expect(
		parseServeOptions(args, {
			...env,
			TEDIX_LANE_CHECKOUT_CAP_GB: "2",
		}).checkoutCapBytes,
	).toBe(2 * 1024 ** 3);
	expect(
		parseServeOptions([...args, "--checkout-cap-gb", "3"], {
			...env,
			TEDIX_LANE_CHECKOUT_CAP_GB: "2",
		}).checkoutCapBytes,
	).toBe(3 * 1024 ** 3);
	for (const gb of ["0", "-1", "NaN", "lots"])
		expect(() =>
			parseServeOptions([...args, "--checkout-cap-gb", gb], env),
		).toThrow("positive number of GB");
	// The cap survives a service-install round trip.
	const duty = runnerDutyFromServeOptions(
		parseServeOptions([...args, "--checkout-cap-gb", "25"], env),
	);
	expect(duty.checkoutCapGb).toBe(25);
	expect(runnerServeArgs(duty)).toContain("--checkout-cap-gb");
	expect(runnerServeArgs(duty)).toContain("25");
});

it.each([
	["codex", "resume", "expired"],
	["claude-code", "--resume", "failed"],
	["opencode", "--session", "failed"],
] as const)(
	"continues the %s thread under fresh server admission beyond two resumes",
	async (executor, resumeArg, outcome) => {
		const f = fixture({ executor });
		f.deps.provision = (_source, destination) => {
			mkdirSync(destination, { recursive: true });
			return destination;
		};
		const launch = spyOn(f.deps, "launch");
		const clock = spyOn(Date, "now");
		let now = Date.now();
		clock.mockImplementation(() => now);
		f.items.splice(1);
		f.control.uniqueAttempts = true;
		f.control.cleanupRemoves = true;
		f.control.telemetryOutcome = outcome === "expired" ? "stopped" : "failed";
		f.control.exitCode = outcome === "expired" ? 0 : 1;
		f.control.declareCompleted = false;
		const path = join(f.dir, `${item().id}-2.json`);
		let session: string | undefined;
		try {
			for (const [index, message] of [
				"stream disconnected before completion",
				"socket hang up",
				"connection reset by peer",
				"broken pipe",
			].entries()) {
				if (index === 1 && executor !== "codex") {
					f.control.startError =
						executor === "claude-code"
							? new Error("Admission response lost")
							: new CliReadError(
									"Admission refused: resource capacity",
									"CONFLICT",
								);
					const retry = f.restart();
					await retry.tick();
					await retry.drain();
					const pending = JSON.parse(readFileSync(path, "utf8"));
					expect(pending.session).toBe(session!);
					expect(pending.attemptId).toBeUndefined();
					expect(pending.retainedAttemptId).toBe("fictional-attempt-1");
					expect(pending.nativeResumeCount ?? 0).toBe(0);
					expect(launch).toHaveBeenCalledTimes(1);
					f.control.startError = undefined;
					now++;
					if (executor === "claude-code") {
						await retry.tick();
						await retry.drain();
						const reconciled = JSON.parse(readFileSync(path, "utf8"));
						expect(reconciled.admissionState).toBe("not_sent");
						expect(reconciled.attemptId).toBeUndefined();
					}
				}
				f.control.finalMessage =
					outcome === "expired"
						? `Lease lost during turn ${index + 1}`
						: message;
				const dispatcher = f.restart();
				await dispatcher.tick();
				await until(() => f.releases.length === index + 1);
				const active = JSON.parse(readFileSync(path, "utf8"));
				session ??= active.session;
				const nativeId = session!.slice(executor.length + 1);
				expect(active.session).toBe(session!);
				expect(active.attemptId).toBe(`fictional-attempt-${index + 1}`);
				expect(active.nativeResumeCount ?? 0).toBe(index);
				if (index) {
					expect(f.control.threadSessions.at(-1)).toBe(nativeId);
					const [args] = launch.mock.calls[index]!;
					expect(
						args.slice(args.indexOf(resumeArg), args.indexOf(resumeArg) + 2),
					).toEqual([resumeArg, nativeId]);
				}
				f.releases[index]!();
				await dispatcher.drain();
				const saved = JSON.parse(readFileSync(path, "utf8"));
				expect(saved).toMatchObject({
					phase: "deferred",
					outcome,
				});
				expect(existsSync(saved.repo)).toBe(true);
				now++;
				f.control.history.data.unshift({
					id: saved.attemptId,
					externalSessionKey: saved.session,
					outcome: outcome === "expired" ? null : outcome,
					expiresAt: new Date(now - 1).toISOString(),
					metadata: { dispatchVersion: 2 },
				});
			}
			expect(launch).toHaveBeenCalledTimes(4);
			expect(f.events.filter((event) => event.verb === "comment")).toHaveLength(
				0,
			);
		} finally {
			clock.mockRestore();
		}
	},
);

it("does not charge settlement retries as additional execution failures", async () => {
	const f = fixture({ failSettle: true });
	f.items.splice(1);
	f.control.exitCode = 1;
	f.control.telemetryOutcome = "failed";
	await f.dispatcher.tick();
	await until(() => f.releases.length === 1);
	f.releases[0]!();
	await f.dispatcher.drain();
	const path = join(f.dir, `${item().id}-2.json`);
	const saved = JSON.parse(readFileSync(path, "utf8"));
	f.control.history.data = [
		{
			id: saved.attemptId,
			externalSessionKey: saved.session,
			outcome: null,
			expiresAt: new Date(Date.now() + 300000).toISOString(),
		},
	];
	saved.recheckAt = 0;
	writeFileSync(path, JSON.stringify(saved));
	await f.restart().tick();
	const retained = JSON.parse(readFileSync(path, "utf8"));
	expect(retained).toMatchObject({
		phase: "settling",
		settlementRetries: 2,
	});
	expect(f.releases).toHaveLength(1);
});

describe("structured dispatcher outcomes", () => {
	const interactionId = "55555555-5555-4555-8555-555555555555";
	const orgId = "66666666-6666-4666-8666-666666666666";
	const common = () => ({
		workItemId: item().id,
		workVersion: 2,
		contractVersion: 1,
		outcomeText: item().acceptanceContract!.doneLooksLike,
	});
	const waiting = () => ({
		...common(),
		outcome: "waiting_on_user",
		interactionId,
		requestVersion: 1,
		orgId,
		userId: "fictional-owner",
	});
	const existing = () => ({
		...common(),
		outcome: "already_satisfied",
		ciApprovalId: "77777777-7777-4777-8777-777777777777",
		commitSha: "b".repeat(40),
		runId: 123,
		workflowName: "Full suite hourly",
		minimumCommit: "abcdef1",
		rootCause: "Fixture parity mismatch",
	});
	function liveFence(f: ReturnType<typeof fixture>) {
		const saved = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		f.control.history.data = [
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: null,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
				metadata: { dispatchVersion: 2 },
			},
		];
		return saved;
	}
	it.each([
		"proven",
		"dirty",
		"foreignSession",
		"noEvidence",
		"incomplete",
		"ledgerUnavailable",
		"unconfigured",
	])("honors a configured local-only branch delivery: %s", async (state) => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		const branch = "prepare/fictional-gap3";
		const git = (repo: string, args: string[]) => {
			const result = spawnSync(
				"git",
				[
					"-C",
					repo,
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.com",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ encoding: "utf8" },
			);
			if (result.status !== 0) throw new Error(result.stderr);
			return result.stdout.trim();
		};
		const source = gitFixture();
		const base = source.git(["rev-parse", "HEAD"]);
		if (state !== "unconfigured")
			f.items[0]!.metadata = {
				...f.items[0]!.metadata,
				artifactKind: "local_branch",
				artifactLocalBranch: { branch, baseCommit: base },
			};
		f.deps.provision = (_source, destination) => {
			source.git(["clone", source.repo, destination]);
			git(destination, ["remote", "remove", "origin"]);
			return destination;
		};
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		const saved = liveFence(f);
		Object.assign(f.control.history.data[0]!, {
			workItemId: item().id,
			admissionId: "fictional-admission",
			startedAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const repo: string = saved.repo;
		git(repo, ["checkout", "-b", branch]);
		writeFileSync(join(repo, "change.txt"), "local change");
		git(repo, ["add", "change.txt"]);
		git(repo, [
			"commit",
			"-m",
			`Change\n\nWork-Item: ${item().id}\nAgent-Session: ${state === "foreignSession" ? "codex:foreign" : saved.session}`,
		]);
		const sha = git(repo, ["rev-parse", "HEAD"]);
		if (state === "dirty") writeFileSync(join(repo, "change.txt"), "edited");
		const evidenceId = "55555555-5555-4555-8555-555555555555";
		if (state !== "noEvidence")
			f.control.evidence.data = [
				{
					id: evidenceId,
					attemptId: saved.attemptId,
					kind: "test_report",
					uri: "artifact://fictional-test-report",
					disposition: "pending",
				},
			];
		if (state === "ledgerUnavailable")
			f.control.evidenceError = new Error("gateway unavailable");
		const result = {
			...completedResult(),
			commitSha: sha,
			...(state === "incomplete"
				? { outcome: "incomplete", remaining: "Tests remain" }
				: {}),
		};
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(result)}`;
		f.releases[0]!();
		await dispatcher.drain();
		const settled = f.events.filter((e) => e.verb === "settle");
		const receipt = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		if (state === "ledgerUnavailable") {
			expect(settled).toHaveLength(0);
			expect(receipt.phase).toBe("settling");
			expect(receipt.pendingCommitProof).toBeDefined();
			return;
		}
		expect(settled).toHaveLength(1);
		expect(settled[0]!.args[settled[0]!.args.indexOf("--outcome") + 1]).toBe(
			state === "proven"
				? "succeeded"
				: state === "incomplete"
					? "rejected"
					: "failed",
		);
		expect(settled[0]!.args).not.toContain("--commit");
		const metadata = settled[0]!.input?.metadata as Record<string, unknown>;
		expect(metadata.recoveredCommits).toBeUndefined();
		if (state === "proven") {
			expect(metadata.settlement).toEqual({
				mode: "local_branch",
				branch,
				baseCommit: base,
				commitSha: sha,
				commitShas: [sha],
				evidenceId,
				evidenceUri: "artifact://fictional-test-report",
			});
			expect(f.briefs[0]).toContain(
				`local branch ${branch} based on ${base}; do not push it`,
			);
			expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(1);
			// Nothing was pushed: the commit exists only on the retained branch.
			expect(git(repo, ["rev-parse", `refs/heads/${branch}`])).toBe(sha);
			expect(git(repo, ["remote"])).toBe("");
		} else {
			expect(metadata.settlement).toBeUndefined();
			expect(f.events.some((e) => e.verb === "complete")).toBe(false);
			expect(receipt.note).toContain(
				state === "unconfigured"
					? "No landed commit SHA on origin/main"
					: state === "incomplete"
						? "Accepted outcome incomplete"
						: "Local branch delivery is not proven",
			);
		}
	});
	describe("recovered proof lifetime", () => {
		const { root, repo, git } = gitFixture(true, false);
		afterAll(() => rmSync(root, { recursive: true, force: true }));
		const originalSession = "codex:original-session";
		git([
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			`Fix\n\nWork-Item: ${item().id}\nAgent-Session: ${originalSession}`,
		]);
		const sha = git(["rev-parse", "HEAD"]);
		git(["push", "origin", "main"]);
		const committedAt = Date.parse(git(["show", "-s", "--format=%cI", sha]));
		it.each([
			"recovered",
			"laterSessionAttempt",
			"originalVersion",
			"originalSucceeded",
			"originalCancelled",
			"interactiveOriginal",
			"work",
			"version",
			"contract",
			"text",
			"attempt",
			"session",
			"expired",
			"dispatchVersion",
			"originalWork",
			"originalAdmission",
			"outsideInterval",
			"missing",
			"ambiguous",
			"peer",
			"truncated",
			"offline",
		])(
			"retains historical commit proof and original custody across restart: %s",
			async (state) => {
				const f = fixture();
				f.items.splice(1);
				f.items[0]!.workKind = "coding";
				const result = { ...completedResult(), commitSha: sha };
				f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(result)}`;
				f.deps.baseCommit = () => sha;
				let offline = true;
				f.deps.landedCommits = (_repo, base, message, deps, recovery) => {
					if (offline) throw new LaneCommitFetchError("offline");
					return landedLaneCommits(repo, base, message, deps, recovery);
				};
				const dispatcher = f.restart();
				await dispatcher.tick();
				await until(() => f.releases.length === 1);
				const saved = liveFence(f);
				Object.assign(f.control.history.data[0]!, { workItemId: item().id });
				const original = {
					id: "original-attempt",
					workItemId: item().id,
					externalSessionKey: originalSession,
					outcome: "expired" as string | null,
					admissionId: "original-admission",
					startedAt: new Date(committedAt - 60000).toISOString(),
					expiresAt: new Date(Date.now() + 60000).toISOString(),
					finishedAt: new Date(Date.now() + 60000).toISOString(),
					metadata: { dispatchVersion: 2 },
				};
				f.control.history.data.push(original);
				f.releases[0]!();
				await dispatcher.drain();
				const path = join(f.dir, `${item().id}-2.json`);
				const pending = JSON.parse(readFileSync(path, "utf8"));
				expect(pending.pendingCommitProof).toContain(sha);
				offline = false;
				const current = f.control.history.data[0]!;
				if (state === "work") f.items[0]!.id = item(2).id;
				if (state === "version") f.items[0]!.version++;
				if (state === "contract") f.items[0]!.acceptanceContract!.version++;
				if (state === "text")
					f.items[0]!.acceptanceContract!.doneLooksLike = "Changed outcome";
				if (state === "attempt") current.id = "different-attempt";
				if (state === "session") current.externalSessionKey = "codex:foreign";
				if (state === "expired")
					current.expiresAt = new Date(Date.now() - 1).toISOString();
				if (state === "dispatchVersion")
					current.metadata = { dispatchVersion: 1 };
				// An earlier dispatch of the same Work, an Attempt that already
				// settled succeeded with the commit, or an interactive session with no
				// dispatch metadata all vouch for the commit they landed.
				if (state === "originalVersion") original.metadata.dispatchVersion = 1;
				if (state === "originalSucceeded") original.outcome = "succeeded";
				if (state === "originalCancelled") original.outcome = "cancelled";
				if (state === "interactiveOriginal") {
					original.outcome = "succeeded";
					(original as { metadata?: unknown }).metadata = undefined;
				}
				if (state === "originalWork") original.workItemId = item(2).id;
				if (state === "originalAdmission") original.admissionId = "";
				if (state === "outsideInterval")
					original.startedAt = original.finishedAt;
				if (state === "laterSessionAttempt")
					f.control.history.data.push({
						...original,
						id: "later-attempt",
						startedAt: original.finishedAt,
					});
				if (state === "missing") f.control.history.data.pop();
				if (state === "ambiguous")
					f.control.history.data.push({ ...original, id: "duplicate-attempt" });
				if (state === "peer") original.outcome = null;
				if (state === "truncated") f.control.history.nextCursor = "more";
				if (state === "offline") offline = true;
				pending.recheckAt = 0;
				writeFileSync(path, JSON.stringify(pending));
				try {
					await f.restart().tick();
				} catch (error) {
					if (state !== "attempt" && state !== "session") throw error;
				}
				await f.dispatcher.drain();
				const settled = f.events.filter((e) => e.verb === "settle");
				expect(settled).toHaveLength(
					[
						"recovered",
						"laterSessionAttempt",
						"originalVersion",
						"originalSucceeded",
						"originalCancelled",
						"interactiveOriginal",
						"originalWork",
						"originalAdmission",
						"outsideInterval",
						"missing",
						"ambiguous",
						"peer",
					].includes(state)
						? 1
						: 0,
				);
				const vouched = [
					"recovered",
					"laterSessionAttempt",
					"originalVersion",
					"originalSucceeded",
					"originalCancelled",
					"interactiveOriginal",
				].includes(state);
				if (vouched) {
					expect(settled[0]!.args).toContain(sha);
					expect(settled[0]!.input?.metadata).toMatchObject({
						laneResult: result,
						settlement: { mode: "commit", commitSha: sha, commitShas: [sha] },
						recoveredCommits: [
							{
								commitSha: sha,
								attemptId: original.id,
								session: originalSession,
							},
						],
					});
					expect(settled[0]!.env.TEDIX_AGENT_SESSION).toBe(saved.session);
					expect(
						settled[0]!.args[settled[0]!.args.indexOf("--outcome") + 1],
					).toBe("succeeded");
					expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(1);
					await f.restart().tick();
					await f.dispatcher.drain();
					expect(f.events.filter((e) => e.verb === "settle")).toHaveLength(1);
					expect(
						f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
					).toHaveLength(1);
				} else {
					expect(settled.some((e) => e.args.includes("succeeded"))).toBe(false);
					if (settled.length === 1) {
						const log = readFileSync(join(f.dir, "dispatcher.log"), "utf8");
						expect(log).toContain('"event":"custody-rejected"');
						if (state === "peer")
							expect(log).toContain(
								"the original Attempt has not reached a terminal outcome",
							);
					}
				}
				expect(f.releases).toHaveLength(1);
				expect(JSON.stringify(original)).not.toContain(sha);
			},
		);
	});
	it("retains one human request across ticks and restart, then releases it on a Work edit while fresh Work advances", async () => {
		const f = fixture();
		f.items.splice(1);
		Object.assign(f.items[0]!, { workKind: "coding", orgId });
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(waiting())}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();
		const path = join(f.dir, `${item().id}-2.json`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			phase: "settled",
			outcome: "cancelled",
			laneResult: waiting(),
		});
		expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(0);
		expect(
			f.events.filter((e) => e.verb === "settle")[0]!.input?.metadata,
		).toMatchObject({ laneResult: waiting() });
		const cli = f.deps.cli!;
		f.deps.cli = async <T>(
			args: string[],
			env: NodeJS.ProcessEnv,
		): Promise<T> => {
			if (args[5] === "interaction-get")
				throw new CliReadError("Owner only", "FORBIDDEN");
			return cli<T>(args, env);
		};
		f.items[0]!.version = 3;
		f.items.push(item(2));
		f.control.history.data = [];
		f.control.finalMessage = "Fresh result recorded";
		f.control.commits = ["b".repeat(40)];
		const restarted = f.restart();
		await restarted.tick();
		await until(() => f.releases.length === 3);
		f.releases[1]!();
		f.releases[2]!();
		await restarted.drain();
		await restarted.tick();
		await restarted.drain();
		// The old revision's wait released without an Interaction read: the
		// revised Work is admitted and checked on its own.
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			phase: "deferred",
			waitReleasedAt: expect.any(Number),
		});
		expect(
			f.events.filter(
				(e) =>
					e.verb === "start" && e.args[4] === "work" && e.args[6] === item().id,
			),
		).toHaveLength(2);
		expect(
			f.events.some((e) => e.verb === "complete" && e.args[6] === item(2).id),
		).toBe(true);
		expect(
			f.events.some((e) =>
				["interaction-create", "interaction-respond"].includes(e.verb),
			),
		).toBe(false);
	});
	it.each(["cancelled", "expired"] as const)(
		"re-checks the Work when the waited request is %s without a response",
		async (state) => {
			const f = fixture();
			f.items.splice(1);
			Object.assign(f.items[0]!, { workKind: "coding", orgId });
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(waiting())}`;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			liveFence(f);
			f.releases[0]!();
			await f.dispatcher.drain();
			f.control.history.data[0]!.outcome = "cancelled";
			f.control.history.data[0]!.metadata = {
				dispatchVersion: 2,
				laneResult: waiting(),
			};
			const at = "2026-10-31T12:00:00.000Z";
			const cli = f.deps.cli!;
			f.deps.cli = async <T>(
				args: string[],
				env: NodeJS.ProcessEnv,
			): Promise<T> => {
				if (args[5] !== "interaction-get") return cli<T>(args, env);
				return {
					request: {
						id: interactionId,
						orgId,
						workItemId: item().id,
						caseId: null,
						projectId: null,
						kind: "question",
						subject: "Confirm controls",
						prompt: "Confirm controls",
						requestedFromType: "user",
						requestedFromId: "fictional-owner",
						creatorType: "user",
						creatorId: "requester",
						creatorSessionId: null,
						state: state === "expired" ? "open" : state,
						requestedAt: at,
						dueAt: null,
						expiresAt: state === "expired" ? at : null,
						resolvedAt: state === "cancelled" ? at : null,
						version: 2,
						metadata: {},
					},
					effectiveState: state,
					canRespond: false,
					canCancel: false,
					responses: { data: [], hasMore: false, nextCursor: null },
				} as T;
			};
			f.control.finalMessage = "The closed request was re-checked.";
			f.control.commits = ["b".repeat(40)];
			const restarted = f.restart();
			await restarted.tick();
			await until(() => f.releases.length === 2);
			f.releases[1]!();
			await restarted.drain();
			expect(
				f.events.filter(
					(e) =>
						e.verb === "start" &&
						e.args[4] === "work" &&
						e.args[6] === item().id,
				),
			).toHaveLength(2);
			expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(1);
			await restarted.tick();
			await restarted.drain();
			expect(f.releases).toHaveLength(2);
		},
	);
	it.each(["cancelled", "open"] as const)(
		"checks the question of a wait whose lease expired (request %s)",
		async (state) => {
			const f = fixture();
			f.items.splice(1);
			Object.assign(f.items[0]!, { workKind: "coding", orgId });
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(waiting())}`;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			liveFence(f);
			f.releases[0]!();
			await f.dispatcher.drain();
			// The lease elapsed while the run waited: the receipt keeps the wait
			// but is deferred and expired rather than settled and cancelled.
			const path = join(f.dir, `${item().id}-2.json`);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			writeFileSync(
				path,
				JSON.stringify({ ...receipt, phase: "deferred", outcome: "expired" }),
			);
			f.control.history.data[0]!.outcome = "expired";
			f.control.history.data[0]!.metadata = {
				dispatchVersion: 2,
				laneResult: waiting(),
			};
			const at = "2026-10-31T12:00:00.000Z";
			const cli = f.deps.cli!;
			f.deps.cli = async <T>(
				args: string[],
				env: NodeJS.ProcessEnv,
			): Promise<T> => {
				if (args[5] !== "interaction-get") return cli<T>(args, env);
				return {
					request: {
						id: interactionId,
						orgId,
						workItemId: item().id,
						caseId: null,
						projectId: null,
						kind: "question",
						subject: "Confirm controls",
						prompt: "Confirm controls",
						requestedFromType: "user",
						requestedFromId: "fictional-owner",
						creatorType: "user",
						creatorId: "requester",
						creatorSessionId: null,
						state,
						requestedAt: at,
						dueAt: null,
						expiresAt: null,
						resolvedAt: state === "cancelled" ? at : null,
						version: 2,
						metadata: {},
					},
					effectiveState: state,
					canRespond: false,
					canCancel: false,
					responses: { data: [], hasMore: false, nextCursor: null },
				} as T;
			};
			f.control.finalMessage = "The closed request was re-checked.";
			f.control.commits = ["b".repeat(40)];
			const restarted = f.restart();
			await restarted.tick();
			if (state === "open") {
				await restarted.drain();
				expect(f.releases).toHaveLength(1);
				expect(
					JSON.parse(readFileSync(path, "utf8")).waitReleasedAt,
				).toBeUndefined();
				return;
			}
			await until(() => f.releases.length === 2);
			f.releases[1]!();
			await restarted.drain();
			expect(
				f.events.filter(
					(e) =>
						e.verb === "start" &&
						e.args[4] === "work" &&
						e.args[6] === item().id,
				),
			).toHaveLength(2);
		},
	);
	it("keeps holding while the waited request remains open", async () => {
		const f = fixture();
		f.items.splice(1);
		Object.assign(f.items[0]!, { workKind: "coding", orgId });
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(waiting())}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();
		f.control.history.data[0]!.outcome = "cancelled";
		f.control.history.data[0]!.metadata = {
			dispatchVersion: 2,
			laneResult: waiting(),
		};
		const at = "2026-10-31T12:00:00.000Z";
		const cli = f.deps.cli!;
		f.deps.cli = async <T>(
			args: string[],
			env: NodeJS.ProcessEnv,
		): Promise<T> => {
			if (args[5] !== "interaction-get") return cli<T>(args, env);
			return {
				request: {
					id: interactionId,
					orgId,
					workItemId: item().id,
					caseId: null,
					projectId: null,
					kind: "question",
					subject: "Confirm controls",
					prompt: "Confirm controls",
					requestedFromType: "user",
					requestedFromId: "fictional-owner",
					creatorType: "user",
					creatorId: "requester",
					creatorSessionId: null,
					state: "open",
					requestedAt: at,
					dueAt: null,
					expiresAt: null,
					resolvedAt: null,
					version: 2,
					metadata: {},
				},
				effectiveState: "open",
				canRespond: false,
				canCancel: false,
				responses: { data: [], hasMore: false, nextCursor: null },
			} as T;
		};
		const restarted = f.restart();
		await restarted.tick();
		await restarted.drain();
		expect(f.releases).toHaveLength(1);
		expect(
			f.events.filter(
				(e) =>
					e.verb === "start" && e.args[4] === "work" && e.args[6] === item().id,
			),
		).toHaveLength(1);
		expect(
			JSON.parse(readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"))
				.waitReleasedAt,
		).toBeUndefined();
	});
	it("consumes a resolving human response once, then uses fresh admission on the same Work revision", async () => {
		const f = fixture();
		f.items.splice(1);
		Object.assign(f.items[0]!, { workKind: "coding", orgId });
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(waiting())}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();
		f.control.history.data[0]!.outcome = "cancelled";
		f.control.history.data[0]!.metadata = {
			dispatchVersion: 2,
			laneResult: waiting(),
		};
		const at = "2026-10-31T12:00:00.000Z";
		const responseId = "77777777-7777-4777-8777-777777777777";
		const cli = f.deps.cli!;
		f.deps.cli = async <T>(
			args: string[],
			env: NodeJS.ProcessEnv,
		): Promise<T> => {
			if (args[5] !== "interaction-get") return cli<T>(args, env);
			return {
				request: {
					id: interactionId,
					orgId,
					workItemId: item().id,
					caseId: null,
					projectId: null,
					kind: "question",
					subject: "Confirm controls",
					prompt: "Confirm controls",
					requestedFromType: "user",
					requestedFromId: "fictional-owner",
					creatorType: "user",
					creatorId: "requester",
					creatorSessionId: null,
					state: "resolved",
					requestedAt: at,
					dueAt: null,
					expiresAt: null,
					resolvedAt: at,
					version: 2,
					metadata: {},
				},
				effectiveState: "resolved",
				canRespond: false,
				canCancel: false,
				responses: {
					data: [
						{
							id: responseId,
							requestId: interactionId,
							responseKind: "answer",
							body: "Controls confirmed",
							artifactRef: null,
							artifactVersion: null,
							artifactDigest: null,
							resolvesRequest: true,
							respondedByType: "user",
							respondedById: "fictional-owner",
							respondedBySessionId: null,
							respondedAt: at,
							metadata: {},
						},
					],
					hasMore: false,
					nextCursor: null,
				},
			} as T;
		};
		f.control.finalMessage = "Fresh verification and follow-up change";
		f.control.commits = ["b".repeat(40)];
		const resumed = f.restart();
		await resumed.tick();
		await until(() => f.releases.length === 2);
		f.releases[1]!();
		await resumed.drain();
		await resumed.tick();
		await resumed.drain();
		const starts = f.events.filter(
			(e) => e.verb === "start" && e.args[4] === "work",
		);
		expect(starts).toHaveLength(2);
		expect(starts[1]!.env.TEDIX_AGENT_SESSION).not.toBe(
			starts[0]!.env.TEDIX_AGENT_SESSION,
		);
		expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(1);
		expect(f.releases).toHaveLength(2);
	});
	it.each(["timer", "answer", "approval"])(
		"re-admits deferred Work after %s with fresh admission",
		async (wake) => {
			const f = fixture();
			f.items.splice(1);
			const recheckAt = new Date(Date.now() + 3_600_000).toISOString();
			const deferred = () => ({
				...common(),
				outcome: "deferred",
				reason: "Waiting on production access",
				until: recheckAt,
			});
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(deferred())}`;
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			liveFence(f);
			f.releases[0]!();
			await f.dispatcher.drain();
			const settle = f.events.find((e) => e.verb === "settle")!;
			expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe(
				"cancelled",
			);
			expect(settle.args[settle.args.indexOf("--note") + 1]).toContain(
				"Deferred: Waiting on production access",
			);
			expect(settle.input?.metadata).toMatchObject({ laneResult: deferred() });
			expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(0);
			const path = join(f.dir, `${item().id}-2.json`);
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({
				phase: "deferred",
				outcome: "cancelled",
				laneResult: deferred(),
			});
			expect(saved.recheckAt).toBe(Date.parse(recheckAt));
			expect(saved.held).toBeUndefined();
			// The wait parks until its recheck time instead of retrying at once.
			await f.restart().tick();
			expect(f.releases).toHaveLength(1);
			if (wake === "timer") {
				saved.recheckAt = 0;
				writeFileSync(path, JSON.stringify(saved));
			} else {
				f.items[0]!.metadata = {
					...f.items[0]!.metadata,
					decisionContinuation: {
						kind: wake,
						requestId: "66666666-6666-4666-8666-666666666666",
						responseId: "77777777-7777-4777-8777-777777777777",
						at: new Date().toISOString(),
					},
				};
			}
			f.control.history.data[0]!.outcome = "cancelled";
			f.control.history.data[0]!.metadata = {
				dispatchVersion: 2,
				laneResult: deferred(),
			};
			f.control.finalMessage = "Access granted; result recorded.";
			const restarted = f.restart();
			await restarted.tick();
			await until(() => f.releases.length === 2);
			f.releases[1]!();
			await restarted.drain();
			expect(
				f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
			).toHaveLength(2);
			expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(1);
		},
	);
	it("records a deferred run's not-before date as the Work's start date, once, and starts nothing earlier", async () => {
		const f = fixture();
		f.items.splice(1);
		const notBefore = new Date(Date.now() + 3 * 86_400_000).toISOString();
		const deferred = () => ({
			...common(),
			outcome: "deferred",
			reason: "The measurement needs three days of production data",
			notBefore,
		});
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(deferred())}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();
		f.control.history.data[0]!.outcome = "cancelled";
		f.control.history.data[0]!.metadata = {
			dispatchVersion: 2,
			laneResult: deferred(),
		};
		const path = join(f.dir, `${item().id}-2.json`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			phase: "deferred",
			outcome: "cancelled",
			recheckAt: Date.parse(notBefore),
		});
		for (let pass = 0; pass < 3; pass++) await f.restart().tick();
		const records = f.events.filter((e) => e.verb === "dispatch-hold");
		expect(records).toHaveLength(1);
		expect(records[0]!.input).toEqual({
			expectedWorkItemVersion: 2,
			startAt: notBefore,
		});
		expect(f.items[0]).toMatchObject({ version: 3, startAt: notBefore });
		const comments = f.events.filter(
			(e) => e.verb === "comment" && e.args.join(" ").includes(notBefore),
		);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.args.join(" ")).toContain(
			"The measurement needs three days of production data",
		);
		expect(JSON.parse(readFileSync(path, "utf8")).notBeforeRecorded).toBe(true);
		// The new Work version stays listed in this fake, and is still not started.
		expect(f.releases).toHaveLength(1);
		expect(
			f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
		).toHaveLength(1);
		expect(f.events.some((e) => e.verb === "interaction-create")).toBe(false);
	});
	it("retries a second deferral on schedule despite the first deferral's cancelled Attempt", async () => {
		const f = fixture();
		f.items.splice(1);
		const deferred = () => ({
			...common(),
			outcome: "deferred",
			reason: "Waiting on production access",
		});
		// An earlier dispatch of this revision already deferred once.
		const first = {
			id: "first-deferral",
			externalSessionKey: "codex:first-deferral",
			outcome: "cancelled",
			metadata: { dispatchVersion: 2, laneResult: deferred() },
		};
		f.control.history.data = [first];
		f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(deferred())}`;
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		const live = liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();
		const path = join(f.dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({ phase: "deferred", outcome: "cancelled" });
		expect(saved.held).toBeUndefined();
		saved.recheckAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		f.control.history.data = [
			first,
			{
				id: live.attemptId,
				externalSessionKey: live.session,
				outcome: "cancelled",
				metadata: { dispatchVersion: 2, laneResult: deferred() },
			},
		];
		f.control.finalMessage = "Access granted; result recorded.";
		const restarted = f.restart();
		await restarted.tick();
		await until(() => f.releases.length === 2);
		f.releases[1]!();
		await restarted.drain();
		expect(
			f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
		).toHaveLength(2);
		expect(JSON.parse(readFileSync(path, "utf8")).held).toBeUndefined();
	});
	it("retries a run the stopping runner cancelled before its agent turn", async () => {
		const f = fixture();
		f.items.splice(1);
		const recall = f.deps.recall!;
		let runner!: ReturnType<typeof f.restart>;
		f.deps.recall = async (...args) => {
			runner.stop();
			return recall(...args);
		};
		runner = f.restart();
		await runner.tick();
		await runner.drain();
		const settle = f.events.find((e) => e.verb === "settle")!;
		expect(settle.args).toContain("cancelled");
		expect(settle.input?.metadata).toMatchObject({ agentTurnStarted: false });
		expect(f.releases).toHaveLength(0);
		const path = join(f.dir, `${item().id}-2.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({ phase: "deferred", outcome: "cancelled" });
		saved.recheckAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		// A different runner's stop-cancel of this revision is no verdict either.
		f.control.history.data = [
			{
				id: "other-runner-stop",
				externalSessionKey: "codex:other-runner",
				outcome: "cancelled",
				metadata: { dispatchVersion: 2, agentTurnStarted: false },
			},
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: "cancelled",
				metadata: settle.input!.metadata,
			},
		];
		f.deps.recall = recall;
		const next = f.restart();
		await next.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await next.drain();
		expect(
			f.events.filter((e) => e.verb === "start" && e.args[4] === "work"),
		).toHaveLength(2);
	});
	it("still holds a revision that a person or the agent cancelled", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.history.data = [
			{
				id: "cancelled-verdict",
				externalSessionKey: "codex:another-session",
				outcome: "cancelled",
				metadata: { dispatchVersion: 2 },
			},
		];
		await f.dispatcher.tick();
		await f.dispatcher.drain();
		const saved = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		expect(saved.held).toBe(true);
		expect(saved.note).toContain(
			"Attempt cancelled-verdict already recorded a cancelled result",
		);
		expect(
			f.events.some((e) => e.verb === "start" && e.args[4] === "work"),
		).toBe(false);
	});
	it("rejects already_satisfied without CI approval with actionable guidance", async () => {
		const f = fixture();
		f.items.splice(1);
		f.items[0]!.workKind = "coding";
		f.control.finalMessage = `Already fixed on main\nTEDIX_LANE_RESULT ${JSON.stringify({ ...existing(), ciApprovalId: undefined })}`;
		f.deps.verifyExisting = async () => {
			throw new Error("Must not request CI proof without CI approval");
		};
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		expect(f.briefs[0]).toContain(
			"Reserve outcome=already_satisfied for approved CI recovery only",
		);
		expect(f.briefs[0]).toContain(
			"Non-CI tasks must use outcome=landed_unverified with existingCommits and unverified",
		);
		f.releases[0]!();
		await dispatcher.drain();
		const settle = f.events.find((e) => e.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("rejected");
		const note = settle.args[settle.args.indexOf("--note") + 1]!;
		expect(note).toContain("Result rejected");
		expect(note).toContain("outcome=landed_unverified with existingCommits");
		expect(note).toContain("Already fixed on main");
		expect(note).not.toContain("runner fault");
		expect(f.events.some((e) => e.verb === "approval-audit-list")).toBe(false);
		expect(f.events.some((e) => e.verb === "complete")).toBe(false);
	});
	it.each(["verified", "unavailable", "stale-session", "stale-version"])(
		"fences preexisting completion: %s",
		async (mode) => {
			const f = fixture();
			f.items.splice(1);
			f.items[0]!.workKind = "coding";
			f.control.finalMessage = `TEDIX_LANE_RESULT ${JSON.stringify(existing())}`;
			f.deps.verifyExisting = async () => {
				if (mode === "unavailable")
					throw new LaneOutcomeReadError("Provider unavailable");
				return {
					mode: "verified_existing",
					ciApprovalId: existing().ciApprovalId,
					commitSha: "b".repeat(40),
					runId: 123,
					runAttempt: 1,
					runCommitSha: "c".repeat(40),
					evidenceUri: "https://github.com/example/project/actions/runs/123",
					rootCause: "Fixture parity mismatch",
				};
			};
			const dispatcher = f.restart();
			await dispatcher.tick();
			await until(() => f.releases.length === 1);
			liveFence(f);
			if (mode === "stale-session")
				f.control.history.data[0]!.externalSessionKey = "codex:foreign";
			if (mode === "stale-version") f.items[0] = { ...f.items[0]!, version: 3 };
			f.releases[0]!();
			await dispatcher.drain();
			const settlements = f.events.filter((e) => e.verb === "settle");
			if (mode === "verified") {
				expect(settlements).toHaveLength(1);
				expect(settlements[0]!.args).not.toContain("--commit");
				expect(
					f.events.find((e) => e.verb === "approval-audit-list")?.input,
				).toEqual({ proposalId: existing().ciApprovalId, limit: 1 });
				expect(settlements[0]!.input?.metadata).toMatchObject({
					settlement: {
						mode: "verified_existing",
						commitSha: "b".repeat(40),
						ciApprovalId: existing().ciApprovalId,
					},
				});
				// Completion rechecks the exact succeeded Attempt through the existing recovery path.
				expect(
					JSON.parse(readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"))
						.completionPending,
				).toBe(true);
				f.control.history.data[0]!.outcome = "succeeded";
				const path = join(f.dir, `${item().id}-2.json`);
				const saved = JSON.parse(readFileSync(path, "utf8"));
				saved.completionRetryAt = 0;
				writeFileSync(path, JSON.stringify(saved));
				await f.restart().tick();
				expect(f.events.filter((e) => e.verb === "complete")).toHaveLength(1);
			} else {
				expect(settlements).toHaveLength(0);
				expect(
					JSON.parse(readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"))
						.pendingCommitProof,
				).toBeDefined();
			}
			expect(f.releases).toHaveLength(1);
		},
	);
});

it("publishes only canonical completed Work, never a cancelled succeeded receipt", async () => {
	const f = fixture();
	writeDispatcherHealthSource(f.dir, options);
	const receipt = {
		itemId: item(1).id,
		version: 2,
		phase: "settled" as const,
		outcome: "succeeded",
		attemptId: "retained-attempt",
		session: "fixture:retained-session",
		executorKey: "fixture-agent",
		completionPending: true,
		laneResult: completedResult(item(1)),
	};
	Object.assign(f.items[0]!, { disposition: "cancelled", completedAt: null });
	await f.dispatcher["complete"]({ ...receipt }, true);
	expect(
		JSON.parse(readFileSync(join(f.dir, "health-source.json"), "utf8"))
			.lastCompleted,
	).toBeUndefined();
	const at = "2026-11-01T10:00:00.000Z";
	Object.assign(f.items[0]!, { disposition: "completed", completedAt: at });
	await f.dispatcher["complete"]({ ...receipt }, true);
	expect(
		JSON.parse(readFileSync(join(f.dir, "health-source.json"), "utf8"))
			.lastCompleted,
	).toEqual({ id: item(1).id, completedAt: at });
});

it("asks again after a lost request reply without holding the Work twice, and drops a hold the Work outgrew", async () => {
	const f = fixture();
	f.items.splice(2);
	const held = (n: number) => ({
		itemId: item(n).id,
		version: 2,
		phase: "deferred",
		held: true,
		note: "Stopped by fictional-owner",
	});
	const paths = [1, 2].map((n) => join(f.dir, `${item(n).id}-2.json`));
	writeFileSync(paths[0]!, JSON.stringify(held(1)));
	writeFileSync(paths[1]!, JSON.stringify(held(2)));
	// The second Work was revised after its receipt was written.
	f.items[1]!.version = 3;
	f.items[1]!.startAt = new Date(Date.now() + 60_000).toISOString();
	let lost = 0;
	const base = f.deps.cli!;
	f.deps.cli = async <T>(args: string[], env: NodeJS.ProcessEnv) => {
		if (args[5] === "interaction-create" && !lost++)
			throw new Error("Gateway timeout");
		return base<T>(args, env);
	};
	const first = f.restart();
	await first.tick();
	expect(JSON.parse(readFileSync(paths[0]!, "utf8")).holdRecorded).toBe(
		undefined,
	);
	expect(JSON.parse(readFileSync(paths[1]!, "utf8")).holdRecorded).toBe(true);
	// Inside the recheck window the same runner does not read again.
	const reads = f.events.length;
	await first.tick();
	expect(
		f.events.slice(reads).filter((e) => e.verb !== "dispatch-list"),
	).toEqual([]);
	for (let pass = 0; pass < 2; pass++) await f.restart().tick();
	expect(JSON.parse(readFileSync(paths[0]!, "utf8")).holdRecorded).toBe(true);
	const holds = f.events.filter((e) => e.verb === "dispatch-hold");
	expect(holds.map((e) => e.args[6])).toEqual([item(1).id]);
	const requests = f.events.filter((e) => e.verb === "interaction-create");
	expect(requests).toHaveLength(1);
	expect(requests[0]!.input).toMatchObject({
		workItemId: item(1).id,
		metadata: { laneBlocker: { workVersion: 3 } },
	});
	expect(f.releases).toHaveLength(0);
});

it("records a pre-agent failure distinctly and retries without feeding the hold", async () => {
	const f = fixture();
	f.items.splice(1);
	const launch = f.deps.launch!;
	f.deps.launch = () =>
		Promise.reject(new Error("spawn ENOENT: the lane checkout is missing"));
	const dispatcher = f.restart();
	await dispatcher.tick();
	await dispatcher.drain();
	f.deps.launch = launch;
	const settle = f.events.find((e) => e.verb === "settle")!;
	expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("failed");
	expect(settle.input?.metadata).toMatchObject({ agentTurnStarted: false });
	const path = join(f.dir, `${item().id}-2.json`);
	const saved = JSON.parse(readFileSync(path, "utf8"));
	expect(saved.outcome).toBe("failed");
	expect(saved.identicalFailures).toBeUndefined();
	expect(saved.held).not.toBe(true);
	// A dispatcher fault retries instead of holding the revision for a human.
	saved.recheckAt = 0;
	writeFileSync(path, JSON.stringify(saved));
	const resumed = f.restart();
	await resumed.tick();
	await until(() => f.releases.length === 1);
	f.releases[0]!();
	await resumed.drain();
	expect(f.events.filter((e) => e.verb === "start" && e.input)).toHaveLength(2);
});

it("does not count manual or older revision failures against automatic execution", async () => {
	const f = fixture();
	f.items.splice(1);
	f.control.history.data = [
		...Array.from({ length: 4 }, (_, n) => ({
			id: `manual-${n}`,
			outcome: "failed",
		})),
		...Array.from({ length: 4 }, (_, n) => ({
			id: `old-${n}`,
			outcome: "failed",
			metadata: { dispatchVersion: 1 },
		})),
		{ id: "current", outcome: "failed", metadata: { dispatchVersion: 2 } },
	];
	await f.dispatcher.tick();
	await until(() => f.releases.length === 1);
	f.releases[0]!();
	await f.dispatcher.drain();
	expect(f.events.filter((e) => e.verb === "start" && e.input)).toHaveLength(1);
});

it("keeps a slow but progressing pass from looking hung to the supervisor", async () => {
	const f = fixture();
	writeDispatcherHealthSource(f.dir, options);
	const seen: number[] = [];
	const cli = f.deps.cli!;
	f.deps.cli = async (args, ...rest) => {
		const due = dispatcherNextCheckAt(f.dir, process.pid);
		if (due !== undefined) seen.push(due - Date.now());
		return cli(args, ...rest);
	};
	const dispatcher = f.restart();
	const before = dispatcherNextCheckAt(f.dir, process.pid);
	await dispatcher.tick();
	expect(before).toBeUndefined();
	// From the start of the pass, and so before its first call has returned,
	// the due time sits about one read ceiling ahead instead of at the process
	// start; a first call slower than the supervisor's grace no longer looks
	// like a hung startup.
	expect(seen.length).toBeGreaterThan(0);
	expect(Math.min(...seen)).toBeGreaterThan(4 * 60_000);
	expect(Math.max(...seen)).toBeLessThanOrEqual(5 * 60_000);
});

it("retries claim preflight deadlines inside one logged budget before admission", async () => {
	const f = fixture();
	f.items.splice(1);
	const cli = f.deps.cli!;
	const launch = f.deps.launch!;
	const launched = Promise.withResolvers<void>();
	f.deps.launch = (...args) => {
		const running = launch(...args);
		launched.resolve();
		return running;
	};
	let readiness = 0;
	const timeouts: number[] = [];
	f.deps.cli = async (args, ...rest) => {
		if (args[5] === "readiness") {
			timeouts.push(rest[3]!);
			if (++readiness === 1) throw new Error("Tedix CLI read deadline elapsed");
		}
		return cli(args, ...rest);
	};
	const dispatcher = f.restart();
	try {
		await dispatcher.tick();
		await launched.promise;
		expect(f.releases).toHaveLength(1);
		expect(readiness).toBe(2);
		expect(timeouts).toEqual([20_000, 40_000]);
		expect(
			f.events.filter((row) => row.verb === "start" && row.input),
		).toHaveLength(1);
		const logs = readFileSync(join(f.dir, "dispatcher.log"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((row) => row.event === "read-budget")
			.map((row) => JSON.parse(row.reason))
			.filter((row) => row.operation === "work.readiness");
		expect(new Set(logs.map((row) => row.budgetId)).size).toBe(1);
		// One run in flight: the budget grows only with this runner's live runs.
		expect(logs[0].budgetMs).toBe(60_000);
		expect(logs.map((row) => row.event)).toEqual([
			"read-budget",
			"read-retry",
			"read-succeeded",
		]);
	} finally {
		for (const release of f.releases) release();
		await dispatcher.drain();
	}
});

describe("stale hold recovery", () => {
	const receiptPath = (dir: string, version = 2) =>
		join(dir, `${item().id}-${version}.json`);
	const receipt = (dir: string, version = 2) =>
		JSON.parse(readFileSync(receiptPath(dir, version), "utf8")) as Record<
			string,
			unknown
		>;
	const logText = (dir: string) =>
		readFileSync(join(dir, "dispatcher.log"), "utf8");
	const starts = (
		events: Array<{ verb: string; input?: Record<string, unknown> }>,
	) => events.filter((event) => event.verb === "start" && event.input);
	const attempt = (extra: Record<string, unknown> = {}) => ({
		id: "99999999-9999-4999-8999-999999999999",
		externalSessionKey: "codex:other-session",
		executorType: "external_agent",
		runtimeState: "running",
		outcome: null,
		startedAt: new Date(Date.now() - 600_000).toISOString(),
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		metadata: { dispatchVersion: 2 },
		...extra,
	});
	const heldReceipt = (extra: Record<string, unknown> = {}) => ({
		itemId: item().id,
		version: 2,
		phase: "deferred",
		outcome: "failed",
		admissionState: "admitted",
		held: true,
		identicalFailures: 3,
		admissionFailure:
			"Canonical history has a live Attempt; admission remains held",
		admissionFailureSignature: "legacy-signature",
		retries: 3,
		recheckAt: Date.now() - 1,
		retryDeadlineAt: Date.now() - 1,
		...extra,
	});

	it("releases a retained admission hold once the blocking Attempt's lease elapsed", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		control.history = {
			data: [
				attempt({
					expiresAt: new Date(Date.now() - 60_000).toISOString(),
				}),
			],
			nextCursor: null,
		};
		writeFileSync(receiptPath(dir), JSON.stringify(heldReceipt()));
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(starts(events)).toHaveLength(1);
		expect(receipt(dir).held).not.toBe(true);
	});
	it("keeps the admission hold while the blocking Attempt's lease is live", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		control.history = { data: [attempt()], nextCursor: null };
		writeFileSync(receiptPath(dir), JSON.stringify(heldReceipt()));
		await dispatcher.tick();
		await dispatcher.drain();
		expect(starts(events)).toHaveLength(0);
		expect(releases).toHaveLength(0);
		expect(logText(dir)).toContain("Canonical history has a live Attempt");
	});
	it("dispatches a new Work revision without waiting on the old revision's hold", async () => {
		const { dispatcher, dir, items, releases, events } = fixture();
		items.splice(1);
		items[0]!.version = 3;
		writeFileSync(receiptPath(dir), JSON.stringify(heldReceipt()));
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(starts(events)).toHaveLength(1);
	});

	it("releases an orphan whose Attempt is absent from the complete ledger and admits again", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		const path = receiptPath(dir);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "running",
				attemptId: "ghost-attempt",
				session: "codex:ghost",
				executorKey: "key",
				admissionState: "admitted",
			}),
		);
		control.history = { data: [], nextCursor: null };
		await dispatcher.tick();
		await dispatcher.drain();
		expect(receipt(dir)).toMatchObject({
			phase: "deferred",
			outcome: "expired",
		});
		expect(logText(dir)).toContain('"orphan-released"');
		// The same revision is dispatchable once the run-failure backoff elapses.
		const saved = receipt(dir);
		saved.recheckAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(starts(events)).toHaveLength(1);
	});
	it("releases an orphan whose Attempt ended under another session", async () => {
		const { dispatcher, dir, items, control } = fixture();
		items.splice(1);
		writeFileSync(
			receiptPath(dir),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "running",
				attemptId: "99999999-9999-4999-8999-999999999999",
				session: "codex:mine",
				executorKey: "key",
				admissionState: "admitted",
			}),
		);
		control.history = {
			data: [attempt({ outcome: "failed" })],
			nextCursor: null,
		};
		await dispatcher.tick();
		await dispatcher.drain();
		expect(receipt(dir)).toMatchObject({
			phase: "deferred",
			outcome: "failed",
		});
		expect(logText(dir)).toContain('"orphan-released"');
	});
	it("keeps an orphan hold while a foreign Attempt lease is live", async () => {
		const { dispatcher, dir, items, control } = fixture();
		items.splice(1);
		writeFileSync(
			receiptPath(dir),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "running",
				attemptId: "99999999-9999-4999-8999-999999999999",
				session: "codex:mine",
				executorKey: "key",
				admissionState: "admitted",
			}),
		);
		control.history = { data: [attempt()], nextCursor: null };
		await dispatcher.tick();
		await dispatcher.drain();
		expect(receipt(dir).phase).toBe("running");
		expect(logText(dir)).toContain('"orphan-held"');
	});

	it.each(["completed", "cancelled"] as const)(
		"stops settlement retries once the Work is %s",
		async (disposition) => {
			const { dispatcher, dir, items, control, events } = fixture();
			items.splice(1);
			items[0]!.disposition = disposition;
			writeFileSync(
				receiptPath(dir),
				JSON.stringify({
					itemId: item().id,
					version: 2,
					phase: "failed",
					outcome: "succeeded",
					attemptId: "99999999-9999-4999-8999-999999999999",
					session: "codex:mine",
					executorKey: "key",
					admissionState: "admitted",
					settlementRetries: 2,
					recheckAt: 0,
				}),
			);
			control.history = {
				data: [attempt({ outcome: "failed" })],
				nextCursor: null,
			};
			await dispatcher.tick();
			await dispatcher.drain();
			expect(receipt(dir).phase).toBe("settled");
			expect(logText(dir)).toContain('"settlement-stopped"');
			expect(events.filter((event) => event.verb === "settle")).toHaveLength(0);
		},
	);
	it("adopts the canonical Attempt outcome instead of retrying a contradicting settlement", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		const path = receiptPath(dir);
		writeFileSync(
			path,
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "failed",
				outcome: "succeeded",
				attemptId: "99999999-9999-4999-8999-999999999999",
				session: "codex:other-session",
				executorKey: "key",
				admissionState: "admitted",
				recheckAt: 0,
			}),
		);
		control.history = {
			data: [
				attempt({
					outcome: "failed",
					expiresAt: new Date(Date.now() - 60_000).toISOString(),
				}),
			],
			nextCursor: null,
		};
		await dispatcher.tick();
		await dispatcher.drain();
		expect(receipt(dir)).toMatchObject({
			phase: "deferred",
			outcome: "failed",
		});
		expect(logText(dir)).toContain('"settlement-reconciled"');
		const saved = receipt(dir);
		saved.recheckAt = 0;
		writeFileSync(path, JSON.stringify(saved));
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(starts(events)).toHaveLength(1);
	});
	it("logs one line and provisions fresh when the retained run folder is gone", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		writeFileSync(
			receiptPath(dir),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "deferred",
				outcome: "expired",
				attemptId: "gone-attempt",
				session: "codex:gone",
				executorKey: "key",
				admissionState: "admitted",
				repo: join(dir, "runs", `${item().id}-2`, "repo"),
				recheckAt: 0,
			}),
		);
		control.history = {
			data: [
				attempt({
					id: "gone-attempt",
					outcome: "expired",
					externalSessionKey: "codex:gone",
					expiresAt: new Date(Date.now() - 60_000).toISOString(),
				}),
			],
			nextCursor: null,
		};
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(logText(dir)).toContain('"run-folder-missing"');
		expect(starts(events)).toHaveLength(1);
	});
	it("starts a fresh session when the retained session is archived", async () => {
		const { dispatcher, dir, items, control, releases, events } = fixture();
		items.splice(1);
		const repo = join(dir, "runs", `${item().id}-2`, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			receiptPath(dir),
			JSON.stringify({
				itemId: item().id,
				version: 2,
				phase: "deferred",
				outcome: "expired",
				attemptId: "arch-attempt",
				session: "codex:archived-session",
				executorKey: "key",
				admissionState: "admitted",
				repo,
				recheckAt: 0,
			}),
		);
		control.history = {
			data: [
				attempt({
					id: "arch-attempt",
					outcome: "expired",
					externalSessionKey: "codex:archived-session",
					expiresAt: new Date(Date.now() - 60_000).toISOString(),
				}),
			],
			nextCursor: null,
		};
		control.resumeError = new Error(
			"session archived-session is archived. Run `codex unarchive archived-session` to restore it.",
		);
		await dispatcher.tick();
		await until(() => releases.length === 1);
		releases[0]!();
		await dispatcher.drain();
		expect(control.threadSessions[0]).toBe("archived-session");
		expect(logText(dir)).toContain('"session-replaced"');
		expect(starts(events)).toHaveLength(1);
	});
});

it("provisions beside a locked worktree registration whose folder is gone", async () => {
	const { root, repo, git } = gitFixture(true);
	const destination = join(root, "repo");
	await provisionLaneWorktree(repo, destination);
	rmSync(destination, { recursive: true });
	// The locked registration survives `worktree prune`; provisioning takes
	// the next free suffix instead of running `git -C` into the missing folder.
	const retry = await provisionLaneWorktree(repo, destination);
	expect(retry).toBe(`${destination}-2`);
	expect(git(["rev-parse", "HEAD"], retry)).toBe(git(["rev-parse", "HEAD"]));
	expect(await provisionLaneWorktree(repo, destination)).toBe(
		`${destination}-3`,
	);
}, 30_000);

describe("watching and steering a run", () => {
	const fromOwner = (
		id: string,
		body: string,
		kind: "follow_up" | "stop" = "follow_up",
	) => ({
		id,
		kind,
		body,
		senderType: "user",
		senderId: "fictional-owner",
		createdAt: "2026-11-19T10:00:00.000Z",
	});
	const sentSteps = (f: ReturnType<typeof fixture>) =>
		// A retried step keeps its number, so the server stores it once.
		[
			...new Map(
				f.control.stepCalls
					.flatMap((call) => call.steps)
					.map((step) => [step.seq, step]),
			).values(),
		];

	it("applies a follow-up after the turn in progress and settles the last turn's result", async () => {
		const f = fixture();
		f.items.splice(1);
		const sessions: string[] = [];
		f.control.duringTurn = (turn) => {
			sessions.push(turn.args[turn.args.indexOf("resume") + 1]!);
			turn.step("message", `Turn ${turn.number} is reading the guide.`);
			f.control.finalMessage = `Result of turn ${turn.number}.`;
		};
		f.control.stepReplies = [[fromOwner("message-1", "Also cover pricing.")]];
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await until(() => f.releases.length === 2);
		f.releases[1]!();
		await f.dispatcher.drain();
		expect(f.briefs).toHaveLength(2);
		expect(sessions[1]).toBe(sessions[0]!);
		expect(f.briefs[1]).toContain(
			"From user fictional-owner:\nAlso cover pricing.",
		);
		expect(f.briefs[1]).toContain(
			"only the JSON object required by --output-schema",
		);
		expect(f.briefs[1]).not.toContain("Standing rules");
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
		const note = settle.args[settle.args.indexOf("--note") + 1]!;
		expect(note).toContain("Result of turn 2.");
		expect(note).not.toContain("Result of turn 1.");
		const steps = sentSteps(f);
		const launchContext = f.briefs[0]?.match(
			/Runner launch context for this Attempt: (\{[^\n]+\})\./,
		)?.[1];
		const launch = JSON.parse(launchContext ?? "{}");
		expect(launch).toEqual({
			machineName: expect.any(String),
			harness: "codex",
			harnessVersion: "1.2.3",
		});
		expect(steps.map((step) => step.seq)).toEqual(steps.map((_, n) => n));
		expect(steps.map((step) => [step.kind, step.text])).toEqual([
			[
				"started",
				`Started codex 1.2.3 on ${launch.machineName} with model test-model`,
			],
			["message", "Turn 1 is reading the guide."],
			["follow_up", "Also cover pricing."],
			["message", "Turn 2 is reading the guide."],
			["finished", "Agent run ended: succeeded"],
		]);
		expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([
			"message-1",
		]);
		expect(
			f.control.stepCalls.every(
				(call) => call.attemptId === "fictional-attempt",
			),
		).toBe(true);
		expect(
			JSON.parse(readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"))
				.stepSeq,
		).toBe(5);
		// The second launch of the Attempt writes beside the first, not over it.
		expect(f.control.turnFiles).toEqual(twoTurnFiles);
	});

	// A second turn of one Attempt: the next output and result file names.
	const twoTurnFiles = [
		{ output: "stdout-0.log", result: "fictional-attempt-last.txt" },
		{ output: "stdout-1.log", result: "fictional-attempt-last-1.txt" },
	];

	it("gives a resumed Attempt new file names and keeps the files an earlier runner left", async () => {
		const f = fixture();
		f.items.splice(1);
		const run = join(f.dir, "runs", `${item().id}-2`);
		const stale = join(run, "fictional-attempt-last.txt");
		f.deps.provision = (_source, destination) => {
			mkdirSync(join(run, "fictional-attempt"), { recursive: true });
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(run, "fictional-attempt", "stdout-0.log"), "old 0");
			writeFileSync(join(run, "fictional-attempt", "stderr-0.log"), "old e0");
			writeFileSync(join(run, "fictional-attempt", "stdout-3.log"), "old 3");
			writeFileSync(stale, "an earlier turn's result");
			return destination;
		};
		let kept: string[] = [];
		f.control.duringTurn = () => {
			kept = [
				readFileSync(join(run, "fictional-attempt", "stdout-0.log"), "utf8"),
				readFileSync(join(run, "fictional-attempt", "stderr-0.log"), "utf8"),
				readFileSync(join(run, "fictional-attempt", "stdout-3.log"), "utf8"),
				readFileSync(stale, "utf8"),
			];
		};
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await dispatcher.drain();
		expect(f.control.turnFiles).toEqual([
			{ output: "stdout-4.log", result: "fictional-attempt-last-1.txt" },
		]);
		expect(kept).toEqual([
			"old 0",
			"old e0",
			"old 3",
			"an earlier turn's result",
		]);
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
	});

	it("settles the first turn's result when a follow-up turn cannot start", async () => {
		const f = fixture();
		f.items.splice(1);
		let output: string | undefined;
		f.control.duringTurn = (turn) => {
			f.control.finalMessage = `Result of turn ${turn.number}.`;
			// Nothing more can be created in the Attempt's output folder.
			output = join(
				dirname(turn.args[turn.args.indexOf("--brief") + 1]!),
				"fictional-attempt",
			);
			chmodSync(output, 0o500);
		};
		f.control.stepReplies = [[fromOwner("message-1", "Also cover pricing.")]];
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await f.dispatcher.drain();
		} finally {
			// The finished run was moved to the archive with its folders.
			for (const run of [
				dirname(output!),
				...readdirSync(join(f.dir, "archive")).map((name) =>
					join(f.dir, "archive", name),
				),
			])
				if (existsSync(join(run, "fictional-attempt")))
					chmodSync(join(run, "fictional-attempt"), 0o700);
		}
		expect(f.briefs).toHaveLength(2);
		expect(f.control.turnFiles).toEqual(twoTurnFiles.slice(0, 1));
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
		expect(settle.args[settle.args.indexOf("--note") + 1]).toContain(
			"Result of turn 1.",
		);
		const steps = sentSteps(f).map((step) => [step.kind, step.text]);
		expect(steps.map(([kind]) => kind)).toEqual([
			"started",
			"follow_up",
			"error",
			"finished",
		]);
		expect(steps[2]![1]).toMatch(
			/^Follow-up not applied: its turn could not start \(Error: EACCES.*\); the run ends with the earlier turn's result$/,
		);
		expect(steps[3]![1]).toBe("Agent run ended: succeeded");
		// The message stays unapplied, so a later run still receives it.
		expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([]);
		expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toMatch(
			/"event":"follow-up-not-started".*message-1: Error: EACCES/,
		);
	});

	it("keeps a run going when a send fails and sends the same steps again", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.stepReplies = [new Error("Gateway unavailable")];
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.control.stepCalls.map((call) => call.steps.length)).toEqual([
			1, 1, 1,
		]);
		expect(
			f.control.stepCalls.slice(0, 2).map((call) => call.steps[0]!.seq),
		).toEqual([0, 0]);
		expect(sentSteps(f).map((step) => step.seq)).toEqual([0, 1]);
		expect(f.events.find((event) => event.verb === "settle")!.args).toContain(
			"succeeded",
		);
	});

	it("retries a failed turn-end read before applying the follow-up and settling", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.stepReplies = [
			new Error("Native call deadline elapsed"),
			[fromOwner("message-1", "Also cover pricing.")],
		];
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await until(() => f.releases.length === 2);
		expect(f.events.some((event) => event.verb === "settle")).toBe(false);
		f.releases[1]!();
		await f.dispatcher.drain();
		expect(f.briefs[1]).toContain("Also cover pricing.");
		expect(f.control.stepCalls.flatMap((call) => call.applied)).toContain(
			"message-1",
		);
		expect(f.events.find((event) => event.verb === "settle")!.args).toContain(
			"succeeded",
		);
	});

	it("cannot settle succeeded when all turn-end reads fail", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.stepReplies = Array.from(
			{ length: 3 },
			() => new Error("Native call deadline elapsed"),
		);
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args).toContain("failed");
		expect(settle.args[settle.args.indexOf("--note") + 1]).toContain(
			"Could not read follow-ups at turn end after three tries",
		);
	});

	it("takes at most five follow-up turns in one Attempt", async () => {
		const f = fixture();
		f.items.splice(1);
		// Every send at the end of a turn brings one more follow-up.
		f.control.duringTurn = (turn) => {
			f.control.stepReplies = [
				[fromOwner(`message-${turn.number}`, `Refine part ${turn.number}.`)],
			];
		};
		await f.dispatcher.tick();
		for (let turn = 1; turn <= 6; turn++) {
			await until(() => f.releases.length === turn);
			f.releases[turn - 1]!();
		}
		await f.dispatcher.drain();
		expect(f.briefs).toHaveLength(6);
		expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([
			"message-1",
			"message-2",
			"message-3",
			"message-4",
			"message-5",
		]);
		expect(sentSteps(f).map((step) => step.text)).toContain(
			"Follow-up not applied: this run already took 5 follow-ups",
		);
	});

	it("applies a follow-up once when the server returns it again", async () => {
		const f = fixture();
		f.items.splice(1);
		const message = fromOwner("message-1", "Also cover pricing.");
		// Until the runner reports it applied, every answer carries it.
		f.control.duringTurn = () => {
			f.control.stepReplies = [[message], [message], [message]];
		};
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await until(() => f.releases.length === 2);
		f.releases[1]!();
		await f.dispatcher.drain();
		expect(f.briefs).toHaveLength(2);
		expect(
			sentSteps(f).filter((step) => step.kind === "follow_up"),
		).toHaveLength(1);
		expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([
			"message-1",
		]);
	});

	it("applies a follow-up whose first answer was lost", async () => {
		let sendNow!: () => void;
		const timer = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 5000) sendNow = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		const f = fixture();
		f.items.splice(1);
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			// The server handed the message over, but its answer never arrived;
			// the next send gets the message again because it is still unapplied.
			f.control.stepReplies = [
				new Error("fetch failed: connection reset"),
				[fromOwner("message-1", "Also cover pricing.")],
			];
			sendNow();
			await until(() => f.control.stepCalls.length === 1);
			f.releases[0]!();
			await until(() => f.releases.length === 2);
			f.releases[1]!();
			await f.dispatcher.drain();
			expect(f.briefs).toHaveLength(2);
			expect(f.briefs[1]).toContain("Also cover pricing.");
			expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([
				"message-1",
			]);
		} finally {
			timer.mockRestore();
		}
	});

	it("reports a follow-up as applied only once its turn has started", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.stepReplies = [[fromOwner("message-1", "Also cover pricing.")]];
		const launch = f.deps.launch!;
		const appliedBeforeSpawn: string[][] = [];
		f.deps.launch = (args, deps) =>
			launch(args, {
				...deps,
				onSpawn: (pid) => {
					appliedBeforeSpawn.push(
						f.control.stepCalls.flatMap((call) => call.applied),
					);
					deps?.onSpawn?.(pid);
				},
			} as typeof deps);
		const dispatcher = f.restart();
		await dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await until(() => f.releases.length === 2);
		await until(() =>
			f.control.stepCalls.some((call) => call.applied.includes("message-1")),
		);
		f.releases[1]!();
		await dispatcher.drain();
		expect(appliedBeforeSpawn).toEqual([[], []]);
	});

	it("applies an unapplied follow-up after a restart resumes the run", async () => {
		const f = fixture();
		f.deps.provision = (_source, destination) => {
			mkdirSync(destination, { recursive: true });
			return destination;
		};
		const clock = spyOn(Date, "now");
		let now = Date.now();
		clock.mockImplementation(() => now);
		f.items.splice(1);
		f.control.uniqueAttempts = true;
		f.control.cleanupRemoves = true;
		const message = fromOwner("message-1", "Also cover pricing.");
		const path = join(f.dir, `${item().id}-2.json`);
		try {
			// The first run receives the follow-up, then loses its connection
			// before it can start the follow-up turn.
			f.control.telemetryOutcome = "failed";
			f.control.exitCode = 1;
			f.control.declareCompleted = false;
			f.control.finalMessage = "stream disconnected before completion";
			f.control.stepReplies = [[message]];
			const first = f.restart();
			await first.tick();
			await until(() => f.releases.length === 1);
			f.releases[0]!();
			await first.drain();
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({ phase: "deferred", outcome: "failed" });
			expect(saved.runMessages).toBeUndefined();
			expect(f.briefs).toHaveLength(1);
			expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([]);
			now++;
			f.control.history.data.unshift({
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: "failed",
				expiresAt: new Date(now - 1).toISOString(),
				metadata: { dispatchVersion: 2 },
			});
			// A new runner process resumes the thread under a fresh Attempt. It
			// remembers nothing; the server returns the unapplied follow-up.
			f.control.telemetryOutcome = "succeeded";
			f.control.exitCode = 0;
			f.control.declareCompleted = true;
			f.control.finalMessage = "Result recorded in OS.";
			f.control.stepCalls.length = 0;
			f.control.stepReplies = [[message]];
			const second = f.restart();
			await second.tick();
			await until(() => f.releases.length === 2);
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				session: saved.session,
				attemptId: "fictional-attempt-2",
				nativeResumeCount: 1,
			});
			f.releases[1]!();
			await until(() => f.releases.length === 3);
			f.releases[2]!();
			await second.drain();
			expect(f.briefs).toHaveLength(3);
			expect(f.briefs[2]).toContain(
				"From user fictional-owner:\nAlso cover pricing.",
			);
			expect(
				f.control.stepCalls
					.filter((call) => call.applied.length)
					.map((call) => [call.attemptId, call.applied]),
			).toEqual([["fictional-attempt-2", ["message-1"]]]);
		} finally {
			clock.mockRestore();
		}
	});

	it("does not pass a reserved action to the agent unless the accountable owner sent it", async () => {
		const body = "Send the invoice to the customer by e-mail.";
		expect(followUpRefusal(item(), fromOwner("m", body))).toBeUndefined();
		expect(
			followUpRefusal(item(), { ...fromOwner("m", body), senderType: "tedi" }),
		).toBe("Follow-up not applied: it needs the owner's own message");
		expect(
			followUpRefusal(
				{ accountableOwnerType: "tedi", accountableOwnerId: "fictional-owner" },
				fromOwner("m", body),
			),
		).toBe("Follow-up not applied: it needs the owner's own message");
		// Consent, MFA and sign-in stay with the person whoever asks.
		expect(
			followUpRefusal(item(), fromOwner("m", "Complete the MFA prompt.")),
		).toBe(
			"Follow-up not applied: consent, MFA and sign-in steps stay with the person",
		);
		expect(
			followUpRefusal(item(), {
				...fromOwner("m", "Also cover pricing."),
				senderId: "fictional-steward",
			}),
		).toBeUndefined();

		const f = fixture();
		f.items.splice(1);
		f.control.stepReplies = [
			[{ ...fromOwner("message-1", body), senderId: "fictional-steward" }],
		];
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.briefs).toHaveLength(1);
		expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([]);
		expect(sentSteps(f).map((step) => [step.kind, step.text])).toContainEqual([
			"error",
			"Follow-up not applied: it needs the owner's own message",
		]);
		expect(f.events.find((event) => event.verb === "settle")!.args).toContain(
			"succeeded",
		);
	});

	const flushNow = () => {
		let sendNow!: () => void;
		const timer = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 5000) sendNow = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		return { send: () => sendNow(), restore: () => timer.mockRestore() };
	};

	it("logs a live-steered follow-up and applies it without another turn", async () => {
		const flush = flushNow();
		const f = fixture();
		f.items.splice(1);
		const child = spawn(process.execPath, ["-e", ""]);
		const thread = f.deps.thread!;
		const steered: string[] = [];
		f.deps.thread = async (...args) => ({
			...(await thread(...args)),
			codexServer: {
				child,
				close: () => {
					child.kill();
				},
				steer: async (text) => {
					steered.push(text);
					return true;
				},
				interrupt: () => undefined,
				turn: async () => undefined,
			},
		});
		const dispatcher = f.restart();
		try {
			await dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.control.stepReplies = [
				[fromOwner("message-live", "Also check pricing.")],
			];
			flush.send();
			await until(() =>
				f.control.stepCalls.some((call) =>
					call.applied.includes("message-live"),
				),
			);
			expect(steered).toHaveLength(1);
			expect(steered[0]).toContain("Also check pricing.");
			expect(readFileSync(join(f.dir, "dispatcher.log"), "utf8")).toMatch(
				/"event":"follow-up-steered".*message-live/,
			);
			f.releases[0]!();
			await dispatcher.drain();
			expect(f.briefs).toHaveLength(1);
		} finally {
			flush.restore();
			child.kill();
		}
	});

	it("stops the turn in progress for an urgent follow-up and applies it on the same session", async () => {
		const flush = flushNow();
		const kill = spyOn(process, "kill").mockReturnValue(true);
		const f = fixture();
		f.items.splice(1);
		f.control.spawnPid = 999999;
		const sessions: string[] = [];
		f.control.duringTurn = (turn) => {
			sessions.push(turn.args[turn.args.indexOf("resume") + 1]!);
			// Only the first turn is cut short; the next one ends by itself.
			f.control.exitCode = turn.number === 1 ? 1 : 0;
			f.control.finalMessage = `Result of turn ${turn.number}.`;
		};
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.control.stepReplies = [
				[
					{
						...fromOwner("message-1", "Use the other branch."),
						interrupt: true,
					},
				],
			];
			flush.send();
			await until(() =>
				kill.mock.calls.some(
					([pid, signal]) => pid === -999999 && signal === "SIGINT",
				),
			);
			// The agent ends its turn early, with no result.
			f.releases[0]!();
			await until(() => f.releases.length === 2);
			f.releases[1]!();
			await f.dispatcher.drain();
			expect(kill.mock.calls.map(([, signal]) => signal)).not.toContain(
				"SIGTERM",
			);
			expect(sessions[1]).toBe(sessions[0]!);
			expect(f.briefs[1]).toContain("Your previous turn was stopped");
			expect(f.briefs[1]).toContain(
				"From user fictional-owner:\nUse the other branch.",
			);
			const settle = f.events.find((event) => event.verb === "settle")!;
			expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe(
				"succeeded",
			);
			const note = settle.args[settle.args.indexOf("--note") + 1]!;
			expect(note).toContain("Result of turn 2.");
			expect(note).not.toContain("Result of turn 1.");
			expect(sentSteps(f).map((step) => [step.kind, step.text])).toEqual([
				["started", expect.any(String)],
				["follow_up", "Use the other branch."],
				[
					"stopped",
					"The turn was stopped to apply a follow-up; the run goes on",
				],
				["finished", "Agent run ended: succeeded"],
			]);
			expect(f.control.stepCalls.flatMap((call) => call.applied)).toEqual([
				"message-1",
			]);
			expect(f.control.turnFiles).toEqual(twoTurnFiles);
		} finally {
			flush.restore();
			kill.mockRestore();
		}
	});

	const asks = (question: string, choices?: string[]) => {
		const { outcome: _outcome, ...fence } = completedResult(item(1));
		return `Asking.\nTEDIX_LANE_RESULT ${JSON.stringify({ ...fence, outcome: "question", question, ...(choices ? { choices } : {}) })}`;
	};

	it("releases the Attempt and resumes the same native session with a late answer", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.uniqueAttempts = true;
		const sessions: string[] = [];
		f.control.duringTurn = (turn) => {
			sessions.push(turn.args[turn.args.indexOf("resume") + 1]!);
			f.control.finalMessage =
				turn.number === 1
					? asks("Which table holds the plan?", ["accounts", "subscriptions"])
					: "Used subscriptions.";
		};
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();

		const settled = f.events.find((event) => event.verb === "settle")!;
		expect(settled.args[settled.args.indexOf("--outcome") + 1]).toBe(
			"cancelled",
		);
		expect(settled.input?.metadata).toMatchObject({
			runQuestion: { kind: "question", text: "Which table holds the plan?" },
			laneResult: { outcome: "deferred" },
		});
		expect(sentSteps(f).map((step) => step.kind)).toEqual([
			"started",
			"question",
		]);
		expect(sentSteps(f).at(-1)?.choices).toEqual(["accounts", "subscriptions"]);

		f.control.history.data[0]!.outcome = "cancelled";
		f.control.history.data[0]!.metadata = settled.input?.metadata;
		// Even after the usual deferral timer, only an answer can wake this run.
		const path = join(f.dir, `${item().id}-2.json`);
		const waiting = JSON.parse(readFileSync(path, "utf8"));
		waiting.recheckAt = 0;
		writeFileSync(path, JSON.stringify(waiting));
		const restarted = f.restart();
		await restarted.tick();
		expect(
			f.events.filter(
				(event) => event.verb === "start" && event.args[4] === "work",
			),
		).toHaveLength(1);

		const answerId = "77777777-7777-4777-8777-777777777777";
		f.items[0]!.metadata = {
			...f.items[0]!.metadata,
			questionContinuation: {
				attemptId: "fictional-attempt-1",
				messageId: answerId,
			},
		};
		f.control.stepReplies = [[fromOwner(answerId, "subscriptions")]];
		await restarted.tick();
		await until(() => f.releases.length === 2);
		f.releases[1]!();
		await restarted.drain();

		expect(sessions).toEqual([sessions[0]!, sessions[0]!]);
		expect(f.briefs).toHaveLength(2);
		expect(f.briefs[1]).toContain('You asked: "Which table holds the plan?".');
		expect(f.briefs[1]).toContain("From user fictional-owner:\nsubscriptions");
		expect(
			f.control.stepCalls
				.filter((call) => call.applied.length)
				.map((call) => [call.attemptId, call.applied]),
		).toEqual([["fictional-attempt-2", [answerId]]]);
		expect(
			f.events.filter((event) => event.verb === "settle").at(-1)?.args,
		).toContain("succeeded");
	});

	const liveFence = (f: ReturnType<typeof fixture>) => {
		const saved = JSON.parse(
			readFileSync(join(f.dir, `${item().id}-2.json`), "utf8"),
		);
		f.control.history.data = [
			{
				id: saved.attemptId,
				externalSessionKey: saved.session,
				outcome: null,
				expiresAt: new Date(Date.now() + 300000).toISOString(),
				metadata: { dispatchVersion: 2 },
			},
		];
	};

	it("does not pass on a question that asks for a secret, a sign-in, consent or MFA", async () => {
		for (const question of [
			"What is the API key for the billing service?",
			"Can you paste your password here?",
			"Could you sign in to the dashboard for me?",
			"Please approve the OAuth consent screen.",
			"Tell me the verification code you received.",
		])
			expect(questionRefusal(question), question).toContain("not passed on");
		for (const question of [
			"Should the token cache live in memory or on disk?",
			"Which table holds the plan: accounts or subscriptions?",
			"Do you want the sign-in page tests moved too?",
		])
			expect(questionRefusal(question), question).toBeUndefined();

		const f = fixture();
		f.items.splice(1);
		f.control.finalMessage = asks(
			"What is the API key for the billing service?",
		);
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		liveFence(f);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(sentSteps(f).map((step) => step.kind)).not.toContain("question");
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--note") + 1]).toContain(
			"Deferred: Question not passed on",
		);
	});

	it("leaves the turn running when its agent has no clean stop, and applies the follow-up after it", async () => {
		const flush = flushNow();
		const kill = spyOn(process, "kill").mockReturnValue(true);
		const f = fixture({ executor: "opencode" });
		f.items.splice(1);
		f.control.spawnPid = 999999;
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.control.stepReplies = [
				[
					{
						...fromOwner("message-1", "Use the other branch."),
						interrupt: true,
					},
				],
			];
			flush.send();
			await until(() =>
				f.control.stepCalls.some((call) =>
					call.steps.some((step) => step.kind === "error"),
				),
			);
			// Signal 0 is only a liveness probe.
			expect(kill.mock.calls.filter(([, signal]) => signal)).toEqual([]);
			f.releases[0]!();
			await until(() => f.releases.length === 2);
			f.releases[1]!();
			await f.dispatcher.drain();
			expect(f.briefs[1]).not.toContain("Your previous turn was stopped");
			expect(f.briefs[1]).toContain("Use the other branch.");
			expect(
				sentSteps(f)
					.filter((step) => step.kind === "error")
					.map((step) => step.text),
			).toEqual([
				"This agent's turn cannot be stopped midway; the follow-up is applied when the turn ends",
			]);
		} finally {
			flush.restore();
			kill.mockRestore();
		}
	});

	it("stops the agent on request, settles cancelled and does not start that version again", async () => {
		let sendNow!: () => void;
		const timer = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 5000) sendNow = callback;
			return setTimeout(() => {}, 60_000);
		}) as typeof setInterval);
		const kill = spyOn(process, "kill").mockReturnValue(true);
		const f = fixture();
		f.items.splice(1);
		f.control.spawnPid = 999999;
		try {
			await f.dispatcher.tick();
			await until(() => f.releases.length === 1);
			f.control.stepReplies = [[fromOwner("message-1", "", "stop")]];
			sendNow();
			await until(() =>
				kill.mock.calls.some(
					([pid, signal]) => pid === -999999 && signal === "SIGTERM",
				),
			);
			f.control.exitCode = 143;
			f.control.telemetryOutcome = "stopped";
			f.releases[0]!();
			await f.dispatcher.drain();
			const settle = f.events.find((event) => event.verb === "settle")!;
			expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe(
				"cancelled",
			);
			expect(settle.args[settle.args.indexOf("--note") + 1]).toContain(
				"Stopped by user fictional-owner",
			);
			const path = join(f.dir, `${item().id}-2.json`);
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			expect(receipt).toMatchObject({
				phase: "settled",
				outcome: "cancelled",
				held: true,
				note: "Stopped by user fictional-owner",
			});
			expect(receipt.interrupted).toBeUndefined();
			expect(sentSteps(f).map((step) => [step.kind, step.text])).toEqual([
				["started", expect.any(String)],
				["stopped", "Stopped by user fictional-owner"],
				["finished", "Agent run ended: cancelled"],
			]);
			// The stop is acknowledged after the agent ended, not when it arrived.
			expect(
				f.control.stepCalls.map((call) => call.applied).filter((a) => a.length),
			).toEqual([["message-1"]]);
			expect(f.control.stepCalls.at(-1)!.applied).toEqual(["message-1"]);
			await f.dispatcher.tick();
			await f.dispatcher.drain();
			expect(f.briefs).toHaveLength(1);
			expect(f.events.filter((event) => event.verb === "settle")).toHaveLength(
				1,
			);
		} finally {
			timer.mockRestore();
			kill.mockRestore();
		}
	});

	it("runs to its result against a server that has no step tool", async () => {
		const f = fixture();
		f.items.splice(1);
		f.control.stepReplies = [
			new RunStepsUnavailableError(
				"Native Work callable work.append_work_attempt_steps is absent or ambiguous",
			),
		];
		await f.dispatcher.tick();
		await until(() => f.releases.length === 1);
		f.releases[0]!();
		await f.dispatcher.drain();
		expect(f.control.stepCalls).toHaveLength(1);
		const log = readFileSync(join(f.dir, "dispatcher.log"), "utf8");
		expect(log.match(/"event":"run-steps-unavailable"/g)).toHaveLength(1);
		const settle = f.events.find((event) => event.verb === "settle")!;
		expect(settle.args[settle.args.indexOf("--outcome") + 1]).toBe("succeeded");
	});
});

import { DEFAULT_TEDIX_MCP_URL } from "./home-client";
import { INTERACTIVE_OAUTH_SCOPE_PROFILES } from "./oauth-provider";
import {
	type CliOptions,
	defaultConversationId,
	looksLikeUuid,
} from "./shared";
import {
	readNumberOption,
	readPositiveNumberOption,
	requireValue,
} from "./option-values";
import { parseWorkOption } from "./work-options";
import { parseFlowOption } from "./flow-options";
import { parseAgentOption } from "./agent-options";

// The local apps/mcp Worker (see docs/engineering/development.md). TedixHomeClient adds
// the app-resolution header for loopback targets; a tunnel is an explicit opt-in.
export const LOCAL_TEDIX_MCP_URL = "http://localhost:3000/mcp";

export function parseOptions(argv: string[]): {
	command: string;
	options: CliOptions;
} {
	const args = [...argv];

	const options: CliOptions = {
		conversationId: defaultConversationId(),
		follow: true,
		includeArchived: false,
		inspectView: {},
		json: false,
		noColor: false,
		poll: true,
		pollIntervalMs: 5_000,
		pollTimeoutMs: 120_000,
		repoContext: true,
		requireCodeProof: false,
		requireWorkstation: false,
		url: process.env.TEDIX_MCP_URL?.trim() || DEFAULT_TEDIX_MCP_URL,
		// A TEDIX_MCP_URL env target counts as explicit, so a stored workspace's
		// gateway never silently overrides it.
		urlExplicit: Boolean(process.env.TEDIX_MCP_URL?.trim()),
	};
	// Honor TEDIX_WORKSPACE as the default workspace selector (overridden by -w).
	const wsEnv = process.env.TEDIX_WORKSPACE?.trim();
	if (wsEnv) options.workspace = wsEnv;
	const positional: string[] = [];
	let command: string | undefined;

	for (let index = 0; index < args.length; index++) {
		let arg = args[index] ?? "";
		const optionIndex = index;
		// Split only the current option. Its owner must consume the inline value;
		// otherwise a boolean value would silently become command/message text.
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (equals >= 0) {
			const value = arg.slice(equals + 1);
			arg = arg.slice(0, equals);
			args.splice(index, 1, arg, value);
		}
		const consumed =
			parseWorkOption(args, index, options) ??
			parseFlowOption(args, index, options) ??
			parseAgentOption(args, index, options);
		if (consumed !== undefined) {
			if (equals >= 0 && consumed === optionIndex) {
				throw new Error(
					`Unexpected value for ${arg}; check tedix ${command ?? "help"} --help`,
				);
			}
			index = consumed;
			continue;
		}
		switch (arg) {
			case "-h":
			case "--help":
				options.help = true;
				break;
			case "--map":
				options.helpMap = true;
				break;
			case "-v":
			case "--version":
				options.version = true;
				break;
			// Fix #3: '--' terminates option parsing; remainder goes to positionals.
			case "--": {
				const remainder = args.slice(index + 1);
				if (!command && remainder.length > 0) command = remainder.shift();
				positional.push(...remainder);
				index = args.length;
				break;
			}
			case "-p":
			case "--prompt":
				// Fix #1: reject next-is-a-flag and missing values.
				options.prompt = requireValue(arg, args[++index]);
				break;
			case "-c":
			case "--conversation":
				options.conversationId = requireValue(arg, args[++index]);
				break;
			case "--delegate-to-tedi":
				options.delegateToTediId = requireValue(arg, args[++index]);
				break;
			case "--work-item":
				options.delegationWorkItemId = requireValue(arg, args[++index]);
				break;
			case "--verify":
				options.verifyCommand = requireValue(arg, args[++index]);
				break;
			case "--require-code-proof":
				options.requireCodeProof = true;
				break;
			case "--require-workstation":
				options.requireWorkstation = true;
				break;
			case "--idempotency-key":
				options.idempotencyKey = requireValue(arg, args[++index]);
				break;
			case "--url":
				options.url = requireValue(arg, args[++index]);
				options.urlExplicit = true;
				break;
			case "--local":
				options.url =
					process.env.TEDIX_LOCAL_MCP_URL?.trim() || LOCAL_TEDIX_MCP_URL;
				options.urlExplicit = true;
				break;
			case "--scope-profile": {
				const profile = requireValue(arg, args[++index]);
				if (
					!INTERACTIVE_OAUTH_SCOPE_PROFILES.includes(
						profile as (typeof INTERACTIVE_OAUTH_SCOPE_PROFILES)[number],
					)
				) {
					throw new Error(
						"--scope-profile must be read, member, admin, or platform-admin",
					);
				}
				options.oauthScopeProfile =
					profile as (typeof INTERACTIVE_OAUTH_SCOPE_PROFILES)[number];
				break;
			}
			case "--offset":
				options.offset = requireValue(arg, args[++index]);
				break;
			case "--thread":
				options.thread = requireValue(arg, args[++index]);
				break;
			case "--no-poll":
				options.poll = false;
				break;
			case "--follow":
				options.follow = true;
				break;
			case "--no-follow":
			case "--once":
				options.follow = false;
				break;
			case "--no-color":
				options.noColor = true;
				break;
			case "--meta":
				options.codeMetadata = true;
				break;
			case "--approve-destructive":
				options.codeDestructiveApprovalReason = requireValue(
					arg,
					args[++index],
				);
				break;
			case "--poll-timeout-ms":
				options.pollTimeoutMs = readNumberOption(arg, args[++index]);
				break;
			case "--poll-interval-ms":
				options.pollIntervalMs = readNumberOption(arg, args[++index]);
				break;
			case "--limit":
				options.limit = readNumberOption(arg, args[++index]);
				break;
			case "--artifact-limit":
				options.artifactLimit = readNumberOption(arg, args[++index]);
				break;
			case "--cursor":
				options.cursor = requireValue(arg, args[++index]);
				break;
			case "--search":
				options.search = requireValue(arg, args[++index]);
				break;
			case "--channel":
				options.channel = requireValue(arg, args[++index]);
				break;
			case "--include-archived":
				options.includeArchived = true;
				break;
			case "--check":
				options.updateCheck = true;
				break;
			case "--force":
				options.updateForce = true;
				break;
			case "--trace":
				options.inspectView = { ...options.inspectView, trace: true };
				break;
			case "--events":
				options.inspectView = { ...options.inspectView, events: true };
				break;
			case "--artifacts":
				options.inspectView = { ...options.inspectView, artifacts: true };
				break;
			case "--workstations":
				options.inspectView = { ...options.inspectView, workstations: true };
				break;
			case "--branch":
				options.inspectView = {
					...options.inspectView,
					branch: requireValue(arg, args[++index]),
				};
				break;
			case "--harness-version":
				options.harnessVersionId = requireValue(arg, args[++index]);
				break;
			case "--condition":
				options.goalCondition = requireValue(arg, args[++index]);
				break;
			case "--max-turns":
				options.goalMaxTurns = readNumberOption(arg, args[++index]);
				break;
			case "--budget-usd":
				options.goalBudgetUsd = readPositiveNumberOption(arg, args[++index]);
				break;
			case "--evaluator": {
				const evaluator = requireValue(arg, args[++index]);
				if (
					evaluator !== "adversarial" &&
					evaluator !== "deterministic" &&
					evaluator !== "work_items"
				) {
					throw new Error(
						"--evaluator must be adversarial, deterministic, or work_items",
					);
				}
				options.goalEvaluator = evaluator;
				break;
			}
			case "--objective-id":
				options.goalObjectiveId = requireValue(arg, args[++index]);
				break;
			case "--no-repo-context":
				options.repoContext = false;
				break;
			case "--json":
				options.json = true;
				break;
			case "-w":
			case "--workspace":
				options.workspace = requireValue(arg, args[++index]);
				break;
			case "--all":
				// `tedix logout --all` clears every stored workspace.
				options.all = true;
				break;
			case "--organization":
				options.organization = requireValue(arg, args[++index]);
				break;
			case "--org":
				// Tenant/org selector for `tedix login`; read directly from argv via
				// readOrgFlag. Fix #1: consume its value guarded by requireValue.
				requireValue(arg, args[++index]);
				break;
			default:
				if (arg?.startsWith("-")) throw new Error(`Unknown option ${arg}`);
				if (arg && !command) command = arg;
				else if (arg) positional.push(arg);
		}
		if (equals >= 0 && index === optionIndex) {
			throw new Error(
				`Unexpected value for ${arg}; check tedix ${command ?? "help"} --help`,
			);
		}
	}

	if (!options.prompt && positional.length > 0) {
		options.prompt = positional.join(" ");
	}
	const parsedCommand = command ?? "chat";
	options.commandExplicit = Boolean(command);
	if (
		parsedCommand !== "code" &&
		(options.codeMetadata || options.codeDestructiveApprovalReason)
	) {
		throw new Error(
			"--meta and --approve-destructive are only valid with code",
		);
	}
	if (
		parsedCommand !== "update" &&
		(options.updateCheck || options.updateForce)
	) {
		throw new Error("--check and --force are only valid with update");
	}
	if (parsedCommand !== "help" && options.helpMap) {
		throw new Error("--map is only valid with help");
	}
	if (options.delegationWorkItemId) {
		if (!options.delegateToTediId) {
			throw new Error("--work-item requires --delegate-to-tedi");
		}
		if (!looksLikeUuid(options.delegationWorkItemId)) {
			throw new Error("--work-item requires a Work Item UUID");
		}
	}
	if (options.verifyCommand !== undefined) {
		const trimmed = options.verifyCommand.trim();
		if (!trimmed) throw new Error("--verify requires a non-empty command");
		if (trimmed.length > 500) {
			throw new Error("--verify accepts at most 500 characters");
		}
		if (!options.delegateToTediId) {
			throw new Error("--verify requires --delegate-to-tedi");
		}
		options.verifyCommand = trimmed;
	}
	return { command: parsedCommand, options };
}

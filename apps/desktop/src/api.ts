import type { CliState } from "./cli";
import type { SetupAction, SetupState } from "./setup";
import type { Status } from "./status";

/** What the main process sends the This Mac and Set up this Mac windows. */
export interface PanelState {
	status: Status;
	setup: SetupState;
	summary: string;
	lastOutput: string;
	busy: boolean;
	/** Undefined when the app runs unpackaged, where the switch is hidden. */
	openAtLogin?: boolean;
}

/**
 * `cli-update` looks for a newer command-line tool now. `setup-window` opens the Set up this Mac window; `close-setup` closes it
 * and shows Tedix; `done-setup` only closes it.
 */
export type PanelAction =
	| "restart"
	| "cli-update"
	| "setup-window"
	| "close-setup"
	| "done-setup";
export type RunnerField = "enabled" | "machineName" | "machineWriteMode";
/** The pages the chat-app rows may open in the browser. */
export type PanelLink = "claude-connectors";

/** The only functions the app's own two windows can call; the Tedix OS page gets none. */
export interface PanelApi {
	state(): Promise<PanelState>;
	set(
		index: number,
		key: RunnerField,
		value: string | boolean | undefined,
	): Promise<void>;
	action(name: PanelAction): Promise<void>;
	/** One button of the setup checklist; `id` names the coding tool or step. */
	setup(action: SetupAction, id?: string): Promise<void>;
	copy(text: string): Promise<void>;
	open(link: PanelLink): Promise<void>;
	openAtLogin(on: boolean): Promise<void>;
	onState(listener: (state: PanelState) => void): void;
}

/**
 * The line both windows show about a newer command-line tool: what the app
 * is doing now, or how its last look ended and how long ago.
 */
export function cliUpdateLine(cli: CliState, now = Date.now()): string {
	if (cli.updating) return cli.updating;
	if (!cli.update) return "";
	const minutes = Math.floor((now - cli.update.at) / 60_000);
	const ago =
		minutes < 2
			? "a moment ago"
			: minutes < 90
				? `${minutes} minutes ago`
				: `${Math.round(minutes / 60)} hours ago`;
	return `${cli.update.text} (${ago})`;
}

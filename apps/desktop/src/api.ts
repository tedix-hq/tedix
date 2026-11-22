import type { CliState } from "./cli";
import type { SetupAction, SetupState } from "./setup";
import type { Status } from "./status";

export type Appearance = "system" | "light" | "dark";

/** What the main process sends the Settings and Set up this Mac windows. */
export interface PanelState {
	status: Status;
	setup: SetupState;
	summary: string;
	lastOutput: string;
	busy: boolean;
	/** Undefined when the app runs unpackaged, where the switch is hidden. */
	openAtLogin?: boolean;
	app: {
		version: string;
		/** The person paused the runners. */
		paused: boolean;
		/** This app's supervisor process runs. */
		running: boolean;
		/** Why the runners are not running, when they are not. */
		problem?: string;
		/** A newer app is downloaded and ready to apply. */
		updateReady?: string;
		/** A newer command-line tool can be applied. */
		cliOffer?: string;
		appearance: Appearance;
		localWorkspace: boolean;
	};
}

/** The sections of Settings. */
export type SettingsSection =
	| "general"
	| "tools"
	| "sessions"
	| "mac"
	| "about";

/**
 * `cli-back` puts the kept command-line tool back and restarts the
 * runners. `setup-window` opens the Set up this Mac window; `close-setup` closes it
 * and shows Tedix; `done-setup` only closes it.
 */
export type PanelAction =
	| "restart"
	| "cli-back"
	| "setup-window"
	| "close-setup"
	| "done-setup"
	| "pause"
	| "check-updates"
	| "apply-update"
	| "local-workspace"
	| "start-local-workspace"
	| "local-model"
	| "open-logs"
	| "open-routing"
	| "close-settings";
export type RunnerField = "enabled" | "machineName" | "machineWriteMode";
/** The pages the chat-app rows may open in the browser. */
export type PanelLink =
	| "claude-connectors"
	| "chatgpt"
	| "install-claude-code"
	| "install-codex";

/** The only functions the app's own windows can call; the Tedix OS page gets none. */
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
	/** Shows a Work Item in the Tedix window. */
	openWork(itemId: string): Promise<void>;
	openAtLogin(on: boolean): Promise<void>;
	onState(listener: (state: PanelState) => void): void;
	/** Restarts one runner; the others and their tasks keep running. */
	restartRunner(index: number): Promise<void>;
	appearance(mode: Appearance): Promise<void>;
	/** Settings is asked to show a section. */
	onSection(listener: (section: SettingsSection) => void): void;
	/** The next three are for the update entry in the main window only. */
	applyUpdate(): Promise<void>;
	/** Tells the app how much room the entry needs right now. */
	updateSize(width: number, height: number): Promise<void>;
	onUpdate(listener: (view: UpdateView) => void): void;
	/** The next three are for the question window only. */
	onQuestion(listener: (view: QuestionView) => void): void;
	answerQuestion(response: number, checked: boolean): Promise<void>;
	/** Tells the app how tall the question is, so the window fits it. */
	questionSize(height: number): Promise<void>;
	/** For the New Chat launcher only. */
	newChat(text: string): Promise<void>;
	openLocalChat(): Promise<void>;
	closeInputBar(): Promise<void>;
}

/**
 * What the update entry at the bottom left of the main window shows.
 * `ready`: something can be applied. `waiting`: it applies by itself once
 * the tasks on this Mac have finished. `working`: `text` says what it is
 * doing. `failed`: a click shows the reason.
 */
export interface UpdateView {
	kind: "hidden" | "ready" | "waiting" | "working" | "failed";
	text: string;
	/** What a screen reader says for the button; longer than `text`. */
	label: string;
	/**
	 * `sidebar`: across the Tedix OS sidebar, above the account row. `rail`:
	 * an icon in the collapsed sidebar. `corner`: the bottom-left corner of a
	 * page without a sidebar.
	 */
	place: "sidebar" | "rail" | "corner";
	/** The Tedix OS page behind the entry is dark. */
	dark: boolean;
}

/** What the question window asks: a native dialog's message box options. */
export interface QuestionView {
	message: string;
	/** Paragraphs separated by a blank line. */
	detail: string;
	buttons: string[];
	defaultId: number;
	/** The answer when the window is closed or Escape is pressed. */
	cancelId: number;
	checkboxLabel?: string;
	checkboxChecked?: boolean;
}

/**
 * The line both windows show about the command-line tool: what the app is
 * doing now, or how the last look, update or go back ended and how long ago.
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

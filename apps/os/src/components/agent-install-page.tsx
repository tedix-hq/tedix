import {
	ArrowSquareOut,
	Check,
	CheckCircle,
	Desktop,
	DownloadSimple,
	TerminalWindow,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import {
	DESKTOP_SETUP_LINK,
	latestMacDownload,
	MAC_FIRST_OPEN_NOTE,
	MAC_SETUP_LINES,
	type MacDownload,
	thisComputer,
} from "@/lib/this-computer";
import { Badge } from "@/components/kumo/badge";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";

const CLI_INSTALL = "curl -fsSL https://downloads.tedix.dev/install.sh | sh";
const CODEX_MARKETPLACE = "codex plugin marketplace add tedix-hq/tedix-plugins";
const CODEX_PLUGIN = "codex plugin add tedix@tedix-plugins";
const CODEX_LOGIN =
	"codex mcp login tedix --scopes mcp:work.read,mcp:skills.read,mcp:content.read,connections.execute";
const CLAUDE_MARKETPLACE =
	"claude plugin marketplace add tedix-hq/tedix-plugins";
const CLAUDE_PLUGIN = "claude plugin install tedix@tedix-plugins --scope user";

function Step({
	number,
	title,
	children,
	command,
}: {
	number: number;
	title: string;
	children: ReactNode;
	command?: string;
}) {
	return (
		<div className="grid gap-2 border-t border-kumo-line py-4 first:border-t-0 first:pt-0 last:pb-0">
			<div className="flex items-center gap-2">
				<Badge variant="outline">{number}</Badge>
				<Text role="label" className="font-medium">
					{title}
				</Text>
			</div>
			<Text role="label" tone="secondary">
				{children}
			</Text>
			{command ? (
				<ClipboardText
					className="max-w-full"
					size="sm"
					text={command}
					textToCopy={command}
					tooltip={{ text: "Copy command" }}
				/>
			) : null}
		</div>
	);
}

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			className="inline-flex min-h-11 items-center gap-1 rounded-sm text-kumo-brand underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-kumo-ring"
			href={href}
			rel="noreferrer"
			target="_blank"
		>
			{children} <ArrowSquareOut size={13} aria-hidden="true" />
		</a>
	);
}

function TerminalSteps() {
	return (
		<>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Terminal CLI</SectionTitle>
						<SectionDescription>
							Install once on macOS or Linux, then choose your organization in
							the browser sign-in.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<Card>
					<CardHeader>
						<TerminalWindow size={20} aria-hidden="true" />
						<CardTitle>Tedix CLI</CardTitle>
						<CardDescription>
							Local command, separate from an agent host's MCP login.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Step number={1} title="Install" command={CLI_INSTALL}>
							The installer verifies the release checksum and adds Tedix to your
							PATH. Open a new terminal after it finishes.
						</Step>
						<Step number={2} title="Sign in" command="tedix login">
							Select the organization this terminal should use and approve its
							requested access in the browser.
						</Step>
						<Step number={3} title="Verify" command="tedix auth status">
							Confirm the workspace, credential source, and gateway, then use
							<code> -w &lt;workspace&gt;</code> for a task-specific target.
						</Step>
						<Step
							number={4}
							title="Set up coding agents"
							command="tedix setup agents"
						>
							The CLI detects Codex and Claude Code, asks before installing the
							Tedix plugin, and verifies the result. Skills and opt-in hooks
							come with the plugin; complete each host's login and hook review
							below.
						</Step>
						<Step
							number={5}
							title="Check or update"
							command="tedix setup agents --status"
						>
							See plugin, marketplace, and connection steps separately. Run
							<code> tedix setup agents --update --dry-run</code> to preview a
							plugin refresh, then <code>tedix setup agents --update</code> to
							apply it. Local marketplaces keep their current source.
						</Step>
						<p className="pt-4 text-kumo-subtle type-tedix-label">
							<GuideLink href="https://docs.tedix.dev/cli">
								CLI installation guide
							</GuideLink>
						</p>
					</CardContent>
				</Card>
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Coding agents</SectionTitle>
						<SectionDescription>
							Use <code>tedix setup agents</code> above for guided local setup,
							or follow the host-specific commands below. Installing a plugin
							does not authorize MCP access.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<div className="grid gap-4 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>Codex and ChatGPT Work</CardTitle>
							<CardDescription>
								Add the Tedix repository marketplace, then enable its plugin.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Step
								number={1}
								title="Install in Codex"
								command={CODEX_MARKETPLACE}
							>
								Adds the public Tedix plugin repository as a plugin marketplace.
							</Step>
							<Step number={2} title="Enable the plugin" command={CODEX_PLUGIN}>
								In ChatGPT Work, choose the Tedix marketplace in the Plugins
								Directory, enable the plugin, and start a new Work chat.
							</Step>
							<Step number={3} title="Authorize MCP" command={CODEX_LOGIN}>
								If <code>codex features list</code> shows{" "}
								<code>mcp_2026_07_28</code> disabled, first run{" "}
								<code>codex features enable mcp_2026_07_28</code> and restart
								Codex. Review the organization, Tedix read access, and
								connection execution access for ordinary provider reads and
								writes. Admin access is excluded. ChatGPT Work uses its own
								connection prompt.
							</Step>
							<Step number={4} title="Verify" command="codex mcp list">
								Start a new chat and ask tedix-connect to read an existing Work
								Item. A green plugin switch proves enablement; the host still
								needs OAuth, hook review, and a successful read.
							</Step>
							<p className="pt-4 text-kumo-subtle type-tedix-label">
								<GuideLink href="https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/chatgpt-codex.md">
									Codex and ChatGPT Work guide
								</GuideLink>
							</p>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Claude Code</CardTitle>
							<CardDescription>
								Marketplace install, then a separate MCP login.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Step
								number={1}
								title="Add the marketplace"
								command={CLAUDE_MARKETPLACE}
							>
								Adds the public Tedix plugin repository as a plugin marketplace.
							</Step>
							<Step
								number={2}
								title="Install the plugin"
								command={CLAUDE_PLUGIN}
							>
								Run <code>claude plugin list</code> to confirm it loaded.
							</Step>
							<Step number={3} title="Authorize MCP">
								Open <code>/mcp</code>, select Tedix, and complete the browser
								consent for the intended organization and read scopes.
							</Step>
							<Step number={4} title="Verify">
								Start a new session and ask <code>/tedix:tedix-connect</code>{" "}
								for one read-only Work Item call.
							</Step>
							<p className="pt-4 text-kumo-subtle type-tedix-label">
								<GuideLink href="https://github.com/tedix-hq/tedix/blob/main/plugins/tedix/docs/claude-code.md">
									Claude Code guide
								</GuideLink>
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Devin CLI</CardTitle>
							<CardDescription>
								Connect Devin to your Tedix workspace.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Step
								number={1}
								title="Sign in to Devin"
								command="devin auth login"
							>
								Complete the browser login yourself.
							</Step>
							<Step
								number={2}
								title="Set up Tedix"
								command="tedix setup agents --devin --yes"
							>
								Merges hooks and the MCP connection. Disables Claude config
								imports in Devin to avoid duplicate hooks.
							</Step>
							<Step
								number={3}
								title="Authorize MCP"
								command="devin mcp login tedix"
							>
								Review your organization and scopes in the browser.
							</Step>
							<Step number={4} title="Verify">
								Start Devin and ask for one read-only Tedix profile and
								organization check.
							</Step>
							<GuideLink href="https://docs.tedix.dev/cli/#devin-cli">
								Devin setup and runner smoke test
							</GuideLink>
						</CardContent>
					</Card>
				</div>
			</PageSection>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Optional session hook</SectionTitle>
						<SectionDescription>
							The same bundled hook can show CLI identity and one Work Item at
							session start. It stays silent until you opt in locally.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<Card>
					<CardContent>
						<Step number={1} title="Review and trust">
							Open <code>/hooks</code> in Codex or Claude Code and inspect the
							bundled SessionStart command before enabling it. A web plugin
							install cannot place or approve a local hook.
						</Step>
						<Step
							number={2}
							title="Opt in"
							command="export TEDIX_PLUGIN_PREFLIGHT=1"
						>
							Set this in the terminal before starting the agent. Optionally set
							<code> TEDIX_WORKSPACE</code> and <code>TEDIX_WORK_ITEM_ID</code>{" "}
							for one read-only context summary.
						</Step>
					</CardContent>
				</Card>
			</PageSection>
		</>
	);
}

/** The one action for this person's computer, with what it does below it. */
function SetupHero({
	title,
	lead,
	children,
}: {
	title: string;
	lead: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className="grid gap-5 rounded-xl border border-kumo-line bg-kumo-elevated p-6 sm:p-10"
		>
			<span className="grid size-11 place-items-center rounded-lg bg-kumo-tint text-kumo-default">
				<Desktop size={22} aria-hidden="true" />
			</span>
			<div className="grid gap-2">
				<h2 className="m-0 text-kumo-default type-tedix-title">{title}</h2>
				<Text tone="secondary">{lead}</Text>
			</div>
			{children}
			<ul className="m-0 grid list-none gap-2 border-t border-kumo-line p-0 pt-5">
				{MAC_SETUP_LINES.map((line) => (
					<li className="flex items-start gap-2" key={line}>
						<Check
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-kumo-success"
							size={16}
						/>
						<Text as="span" role="label" tone="secondary">
							{line}
						</Text>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Working, done or failed in one fixed-height line, so nothing jumps. */
function ActionState({ children }: { children: ReactNode }) {
	return (
		<div
			className="flex min-h-10 items-start gap-2 text-kumo-subtle type-tedix-label"
			role="status"
		>
			{children}
		</div>
	);
}

function MacDownloadHero() {
	const [download, setDownload] = useState<MacDownload | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [failed, setFailed] = useState(false);
	const [started, setStarted] = useState(false);
	useEffect(() => {
		let current = true;
		setFailed(false);
		latestMacDownload().then(
			(found) => current && setDownload(found),
			() => current && setFailed(true),
		);
		return () => {
			current = false;
		};
	}, [attempt]);
	const start = () => setStarted(true);
	return (
		<SetupHero
			title="Get the Tedix app for Mac"
			lead="The app sets up this Mac for you. You do not need a terminal."
		>
			<div className="flex flex-wrap items-center gap-2">
				{failed ? (
					<Button onClick={() => setAttempt((count) => count + 1)} size="lg">
						Retry
					</Button>
				) : download === null ? (
					<Button disabled loading size="lg">
						Download the Tedix app for Mac
					</Button>
				) : download.forThisMac ? (
					<Button
						onClick={start}
						render={<a href={download.forThisMac} />}
						size="lg"
					>
						<DownloadSimple size={18} aria-hidden="true" />
						Download the Tedix app for Mac
					</Button>
				) : (
					<>
						<Button
							onClick={start}
							render={<a href={download.appleSilicon} />}
							size="lg"
						>
							<DownloadSimple size={18} aria-hidden="true" />
							Download for Apple silicon
						</Button>
						<Button
							onClick={start}
							render={<a href={download.intel} />}
							size="lg"
							variant="outline"
						>
							Download for Intel
						</Button>
					</>
				)}
			</div>
			<ActionState>
				{failed ? (
					"The download is not available right now. Check your connection and retry, or use a terminal instead."
				) : started ? (
					<>
						<CheckCircle
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-kumo-success"
							size={16}
							weight="fill"
						/>
						<span>
							Download started. Open the file, move Tedix to Applications and
							open it. {MAC_FIRST_OPEN_NOTE} Then sign in and choose Set up this
							Mac.
						</span>
					</>
				) : download === null ? (
					"Finding the latest version…"
				) : download.forThisMac ? (
					`Version ${download.version}. ${MAC_FIRST_OPEN_NOTE}`
				) : (
					`Version ${download.version}. Not sure which Mac you have? Open the Apple menu and choose About This Mac. “Chip: Apple” means Apple silicon.`
				)}
			</ActionState>
		</SetupHero>
	);
}

function DesktopAppHero() {
	const [opened, setOpened] = useState(false);
	return (
		<SetupHero
			title="Set up this Mac"
			lead="One window sets up Tedix on this Mac and asks before each step."
		>
			<div>
				<Button
					onClick={() => setOpened(true)}
					render={<a href={DESKTOP_SETUP_LINK} />}
					size="lg"
				>
					Set up this Mac
				</Button>
			</div>
			<ActionState>
				{opened ? (
					<>
						<CheckCircle
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-kumo-success"
							size={16}
							weight="fill"
						/>
						<span>
							The setup window is open. If you do not see it, update the Tedix
							app and choose Set up this Mac again.
						</span>
					</>
				) : null}
			</ActionState>
		</SetupHero>
	);
}

export function AgentInstallPage() {
	const computer = thisComputer();
	const [terminalOpen, setTerminalOpen] = useState(false);
	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>Set up this computer</PageTitle>
					<PageDescription>
						Let Tedix work with the coding agents on this computer, such as
						Claude Code and Codex. They then see the same projects, tasks and
						results you see here.
					</PageDescription>
				</PageHeading>
			</PageHeader>

			{computer === "other" ? (
				<TerminalSteps />
			) : (
				<>
					<PageSection>
						{computer === "desktop-app" ? (
							<DesktopAppHero />
						) : (
							<MacDownloadHero />
						)}
					</PageSection>
					<PageSection>
						<Collapsible open={terminalOpen} onOpenChange={setTerminalOpen}>
							<CollapsibleDefaultTrigger className="-ms-2 w-fit">
								Use a terminal instead
							</CollapsibleDefaultTrigger>
							<CollapsibleDefaultContent>
								<div className="grid gap-8 pt-4">
									<TerminalSteps />
								</div>
							</CollapsibleDefaultContent>
						</Collapsible>
					</PageSection>
				</>
			)}
		</Page>
	);
}

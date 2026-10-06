import { ArrowSquareOut, TerminalWindow } from "@phosphor-icons/react";
import type { ReactNode } from "react";
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
const CODEX_MARKETPLACE = "codex plugin marketplace add tedix-hq/tedix";
const CODEX_PLUGIN = "codex plugin add tedix@tedix-repo";
const CODEX_LOGIN =
	"codex mcp login tedix --scopes mcp:work.read,mcp:skills.read,mcp:content.read,connections.execute";
const CLAUDE_MARKETPLACE = "claude plugin marketplace add tedix-hq/tedix";
const CLAUDE_PLUGIN = "claude plugin install tedix@tedix --scope user";

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
				/>
			) : null}
		</div>
	);
}

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			className="inline-flex items-center gap-1 text-kumo-brand underline underline-offset-2"
			href={href}
			rel="noreferrer"
			target="_blank"
		>
			{children} <ArrowSquareOut size={13} aria-hidden="true" />
		</a>
	);
}

export function AgentInstallPage() {
	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>Install Tedix</PageTitle>
					<PageDescription>
						Connect your terminal or coding agent to the same governed Tedix
						workspace you use here. Choose one host, sign in, then make a
						read-only check before doing work.
					</PageDescription>
				</PageHeading>
			</PageHeader>

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Terminal CLI</SectionTitle>
						<SectionDescription>
							Install once on macOS or Linux, then choose your organization in
							the browser login.
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
							Tedix Agent Toolkit, and verifies the result. Skills and the
							optional hook come with the plugin; complete each host's login and
							hook review below.
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
								Requires Git access to the Tedix repository while it is private.
							</Step>
							<Step number={2} title="Enable the plugin" command={CODEX_PLUGIN}>
								In ChatGPT Work, choose the Tedix Agent Toolkit in the Plugins
								Directory, enable the plugin, and start a new Work chat.
							</Step>
							<Step number={3} title="Authorize MCP" command={CODEX_LOGIN}>
								Review the organization, Tedix read access, and connection
								execution access for ordinary provider reads and writes. Admin
								access is excluded. ChatGPT Work uses its own connection prompt.
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
								Requires Git access to the Tedix repository.
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
		</Page>
	);
}

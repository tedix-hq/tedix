import { isNonEmptySpec } from "@json-render/core";
import { useEffect, useState } from "react";
import { SidebarAppSchema } from "@tedix/api-contract/schemas/app";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { TedixRenderer } from "../json-render/TedixRenderer";
import { callHostTool, useWidgetToolInfo } from "../lib/widget-host-hooks";
import { callSidebarTool, resolveSidebarTool } from "../lib/sidebar-tools";
import { WidgetWrapper } from "./WidgetWrapper";

function SidebarContent() {
	const info = useWidgetToolInfo();
	const raw = isRecord(info.output) ? info.output.sidebarApp : null;
	const parsed = SidebarAppSchema.safeParse(
		isRecord(raw) ? { title: raw.title, tabs: raw.tabs } : raw,
	);
	const config = parsed.success ? parsed.data : null;
	const organizations =
		isRecord(raw) && Array.isArray(raw.organizations)
			? raw.organizations.filter(
					(org): org is { id: string; label: string } =>
						isRecord(org) &&
						typeof org.id === "string" &&
						typeof org.label === "string",
				)
			: [];
	const [selected, setSelected] = useState("");
	const organization = organizations.some((org) => org.id === selected)
		? selected
		: organizations.length === 1
			? organizations[0]!.id
			: "";
	const [tabId, setTabId] = useState("");
	const tab = config?.tabs.find((tab) => tab.id === tabId) ?? config?.tabs[0];
	const [revision, setRevision] = useState(0);
	const [view, setView] = useState<{
		key: string;
		data: Record<string, unknown>;
		spec: Record<string, unknown>;
	} | null>(null);
	const [failure, setFailure] = useState<{
		key: string;
		message: string;
	} | null>(null);
	const key = JSON.stringify([
		isRecord(raw) ? raw.accountId : null,
		organization,
		tab?.id,
		tab?.tool,
		revision,
	]);

	useEffect(() => {
		if (!organization || !tab) return;
		let active = true;
		async function load() {
			try {
				const callable = await resolveSidebarTool(
					callHostTool,
					organization,
					tab!.tool,
					{ readOnly: true },
				);
				const data = await callSidebarTool(callHostTool, callable, {
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				});
				if (!isRecord(data.layoutSpec) || !isNonEmptySpec(data.layoutSpec))
					throw new Error(
						"This view has no usable layout. Open its source in Tedix OS.",
					);
				if (active)
					setView({
						key,
						spec: data.layoutSpec,
						data: { ...data, ui: { toolPrefix: "" } },
					});
			} catch (error) {
				if (active)
					setFailure({
						key,
						message:
							error instanceof Error
								? error.message
								: "This view could not be loaded.",
					});
			}
		}
		void load();
		return () => {
			active = false;
		};
	}, [key, organization, tab?.tool]);

	const runAction: typeof callHostTool = async (name, args) => {
		const callable = await resolveSidebarTool(callHostTool, organization, name);
		const result = await callSidebarTool(callHostTool, callable, args);
		return { content: [], structuredContent: result };
	};

	if (!config)
		return (
			<p role="status" className="p-6">
				{info.isError || info.isSuccess
					? "Tedix could not be loaded. Reopen it to try again."
					: "Loading Tedix…"}
			</p>
		);
	return (
		<main className="mx-auto min-h-screen max-w-5xl p-4 text-foreground sm:p-6">
			<header className="mb-6 flex flex-wrap items-center justify-between gap-4">
				<h1 className="text-xl font-semibold">{config.title}</h1>
				<div className="flex items-center gap-3">
					<label className="flex items-center gap-2 text-sm">
						Organization
						<select
							value={organization}
							onChange={(event) => {
								setSelected(event.target.value);
								setRevision((value) => value + 1);
							}}
							className="rounded-md border border-border bg-background p-2"
						>
							<option value="" disabled>
								Choose organization
							</option>
							{organizations.map((org) => (
								<option key={org.id} value={org.id}>
									{org.label}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={!organization}
						onClick={() => setRevision((value) => value + 1)}
						className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
					>
						Refresh
					</button>
				</div>
			</header>
			<div
				role="tablist"
				aria-label="Work views"
				className="mb-4 flex gap-2 border-b border-border"
				onKeyDown={(event) => {
					const buttons = [
						...event.currentTarget.querySelectorAll<HTMLButtonElement>(
							'[role="tab"]',
						),
					];
					const current = buttons.findIndex(
						(button) => button.id === `tab-${tab?.id}`,
					);
					const next =
						event.key === "ArrowRight"
							? (current + 1) % buttons.length
							: event.key === "ArrowLeft"
								? (current + buttons.length - 1) % buttons.length
								: event.key === "Home"
									? 0
									: event.key === "End"
										? buttons.length - 1
										: -1;
					if (next < 0) return;
					event.preventDefault();
					buttons[next]?.focus();
					buttons[next]?.click();
				}}
			>
				{config.tabs.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						id={`tab-${item.id}`}
						aria-selected={item.id === tab?.id}
						aria-controls="sidebar-panel"
						tabIndex={item.id === tab?.id ? 0 : -1}
						onClick={() => {
							setTabId(item.id);
							setRevision((value) => value + 1);
						}}
						className={`border-b-2 px-4 py-3 text-sm ${item.id === tab?.id ? "border-foreground font-semibold" : "border-transparent text-muted-foreground"}`}
					>
						{item.label}
					</button>
				))}
			</div>
			<section
				id="sidebar-panel"
				role="tabpanel"
				aria-labelledby={`tab-${tab?.id}`}
			>
				{!organization ? (
					<p role="status" className="p-4 text-muted-foreground">
						{organizations.length
							? "Choose your organization to see its work."
							: "Connect an organization to see its work."}
					</p>
				) : failure?.key === key ? (
					<p role="alert" className="p-4">
						{failure.message}
					</p>
				) : view?.key === key && tab ? (
					<TedixRenderer
						key={key}
						spec={view.spec}
						data={view.data}
						callTool={runAction}
					/>
				) : (
					<p role="status" className="p-4 text-muted-foreground">
						Loading {tab?.label}…
					</p>
				)}
			</section>
		</main>
	);
}

export default function SidebarApp() {
	return (
		<WidgetWrapper>
			<SidebarContent />
		</WidgetWrapper>
	);
}

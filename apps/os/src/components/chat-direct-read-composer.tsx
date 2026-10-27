/** Composer card that runs one explicit read-only connected-app tool. */
import { Link } from "@tanstack/react-router";
import type { HomeReadOnlyApp } from "@tedix/api-contract/schemas/kernel-runtime";
import { useState } from "react";
import {
	LoadError,
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";

import { Badge } from "@/components/kumo/badge";
import { Combobox } from "@/components/kumo/combobox";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Textarea } from "@/components/kumo/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	type DirectReadCommand,
	buildReadArguments,
	initialReadValues,
	readConnectionLabel,
	readToolFields,
} from "@/components/chat-direct-read";

function DirectReadComposer({
	apps,
	pending,
	onClose,
	onRun,
}: {
	apps: HomeReadOnlyApp[];
	pending: boolean;
	onClose: () => void;
	onRun: (command: DirectReadCommand) => void;
}) {
	const initiallyConnected =
		apps.find((app) => app.connectionState === "connected") ?? apps[0];
	const [appSlug, setAppSlug] = useState(initiallyConnected?.slug ?? "");
	const selectedApp = apps.find((app) => app.slug === appSlug) ?? apps[0];
	const [toolName, setToolName] = useState(selectedApp?.tools[0]?.name ?? "");
	const selectedTool =
		selectedApp?.tools.find((tool) => tool.name === toolName) ??
		selectedApp?.tools[0] ??
		null;
	const [values, setValues] = useState<Record<string, string>>(() =>
		initialReadValues(selectedTool),
	);
	const [error, setError] = useState<string | null>(null);
	return (
		<Card
			size="sm"
			className="mb-2 max-h-[min(70vh,48rem)] overflow-y-auto bg-kumo-base shadow-tedix-floating"
		>
			<CardHeader>
				<CardTitle>Read from a connected app</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-3">
				<Combobox
					items={apps}
					value={selectedApp ?? null}
					itemToStringLabel={(app) => app.name}
					isItemEqualToValue={(a, b) => a.slug === b.slug}
					filter={(app, query) =>
						`${app.name} ${app.slug} ${app.tools.map((tool) => tool.title).join(" ")}`
							.toLowerCase()
							.includes(query.toLowerCase())
					}
					onValueChange={(app) => {
						if (!app) return;
						setAppSlug(app.slug);
						setToolName(app.tools[0]?.name ?? "");
						setValues(initialReadValues(app.tools[0] ?? null));
					}}
				>
					<Combobox.Trigger
						aria-label="Connected app"
						render={
							<Button variant="outline" className="w-full justify-between" />
						}
					>
						{selectedApp?.name ?? "Choose an app"}
					</Combobox.Trigger>
					<Combobox.Content className="relative z-(--tedix-layer-dropdown) max-w-[calc(100vw-2rem)]">
						<Combobox.Input
							aria-label="Search connected apps"
							placeholder="Search apps and tools"
						/>
						<Combobox.Empty>
							No app or read action matches your search.
						</Combobox.Empty>
						<Combobox.List>
							{(app: HomeReadOnlyApp) => (
								<Combobox.Item key={app.slug} value={app}>
									{app.name}
									<Badge variant="outline" className="ml-1">
										{readConnectionLabel(app.connectionState)}
									</Badge>
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Content>
				</Combobox>
				{selectedApp ? (
					<Combobox
						key={selectedApp.slug}
						label="Read action"
						items={selectedApp.tools}
						value={selectedTool}
						itemToStringLabel={(tool) => tool.title}
						isItemEqualToValue={(a, b) => a.name === b.name}
						onValueChange={(tool) => {
							if (!tool) return;
							setToolName(tool.name);
							setValues(initialReadValues(tool));
						}}
					>
						<Combobox.Trigger
							aria-label="Read action"
							render={
								<Button variant="outline" className="w-full justify-between" />
							}
						>
							{selectedTool?.title ?? "Choose a read action"}
						</Combobox.Trigger>
						<Combobox.Content className="relative z-(--tedix-layer-dropdown) max-w-[calc(100vw-2rem)]">
							<Combobox.Input
								aria-label="Search read actions"
								placeholder="Search read actions"
							/>
							<Combobox.Empty>No matching read actions.</Combobox.Empty>
							<Combobox.List>
								{(tool: HomeReadOnlyApp["tools"][number]) => (
									<Combobox.Item key={tool.name} value={tool}>
										{tool.title}
										{tool.connectionState !== "connected" ? (
											<Badge variant="outline" className="ml-1">
												{readConnectionLabel(tool.connectionState)}
											</Badge>
										) : null}
									</Combobox.Item>
								)}
							</Combobox.List>
						</Combobox.Content>
					</Combobox>
				) : null}
				{selectedTool ? (
					<div className="grid gap-2">
						{selectedTool.description ? (
							<Text role="label" tone="secondary" className="m-0">
								{selectedTool.description}
							</Text>
						) : null}
						{selectedTool.connectionState !== "connected" ? (
							<Alert
								variant={
									selectedTool.connectionState === "connection_required"
										? "info"
										: "destructive"
								}
							>
								<AlertTitle>
									{selectedTool.connectionState === "connection_required"
										? `Connect ${selectedApp?.name ?? "this app"}`
										: "This read is unavailable"}
								</AlertTitle>
								<AlertDescription>
									{selectedTool.connectionReason ??
										"The configured credential cannot currently be verified."}
								</AlertDescription>
								{selectedTool.connectProviderId ? (
									<AlertAction>
										<Button
											size="sm"
											variant="outline"
											render={
												<Link
													to="/admin/connections"
													search={{
														q: "",
														status: "used",
														connect: selectedTool.connectProviderId,
													}}
												/>
											}
										>
											Connect
										</Button>
									</AlertAction>
								) : null}
							</Alert>
						) : null}
						{readToolFields(selectedTool).map((field) => (
							<div className="grid gap-1" key={field.name}>
								<Label htmlFor={`direct-read-${field.name}`}>
									{field.schema.title ?? field.name}
									{field.required ? " *" : ""}
								</Label>
								{field.schema.enum ? (
									<Select
										value={values[field.name] ?? ""}
										onValueChange={(value) =>
											setValues((current) => ({
												...current,
												[field.name]: String(value ?? ""),
											}))
										}
									>
										<SelectTrigger
											id={`direct-read-${field.name}`}
											aria-label={field.schema.title ?? field.name}
										>
											<SelectValue placeholder="Choose a value" />
										</SelectTrigger>
										<SelectContent>
											{field.schema.enum.map((option) => (
												<SelectItem key={String(option)} value={String(option)}>
													{String(option)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : field.schema.type === "boolean" ? (
									<Select
										value={values[field.name] ?? ""}
										onValueChange={(value) =>
											setValues((current) => ({
												...current,
												[field.name]: String(value ?? ""),
											}))
										}
									>
										<SelectTrigger
											id={`direct-read-${field.name}`}
											aria-label={field.schema.title ?? field.name}
										>
											<SelectValue placeholder="Choose true or false" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="true">True</SelectItem>
											<SelectItem value="false">False</SelectItem>
										</SelectContent>
									</Select>
								) : field.schema.type === "object" ||
								  field.schema.type === "array" ? (
									<Textarea
										id={`direct-read-${field.name}`}
										aria-label={field.schema.title ?? field.name}
										placeholder={field.schema.description ?? "Enter valid JSON"}
										value={values[field.name] ?? ""}
										onValueChange={(value) =>
											setValues((current) => ({
												...current,
												[field.name]: value,
											}))
										}
										minRows={3}
										maxRows={8}
									/>
								) : (
									<Input
										id={`direct-read-${field.name}`}
										aria-label={field.schema.title ?? field.name}
										placeholder={
											field.schema.description ?? field.schema.type?.toString()
										}
										value={values[field.name] ?? ""}
										onChange={(event) =>
											setValues((current) => ({
												...current,
												[field.name]: event.target.value,
											}))
										}
									/>
								)}
							</div>
						))}
					</div>
				) : null}
				{error ? (
					<Text role="label" tone="error" className="m-0">
						{error}
					</Text>
				) : null}
			</CardContent>
			<CardFooter className="justify-end">
				<Button type="button" size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					loading={pending}
					disabled={
						!selectedApp ||
						!selectedTool ||
						selectedTool.connectionState !== "connected" ||
						pending
					}
					onClick={() => {
						if (!selectedApp || !selectedTool) return;
						try {
							onRun({
								appSlug: selectedApp.slug,
								toolName: selectedTool.name,
								arguments: buildReadArguments(selectedTool, values),
							});
						} catch (cause) {
							setError(
								cause instanceof Error ? cause.message : "Check the arguments",
							);
						}
					}}
				>
					Run read
				</Button>
			</CardFooter>
		</Card>
	);
}

/** Loading, error and ready states around the direct-read composer. */
export function DirectReadPanel({
	catalog,
	pending,
	onClose,
	onRun,
}: {
	catalog: {
		isLoading: boolean;
		isError: boolean;
		refetch?: () => unknown;
		isFetching?: boolean;
		error: unknown;
		data?: { apps: HomeReadOnlyApp[] };
	};
	pending: boolean;
	onClose: () => void;
	onRun: (command: DirectReadCommand) => void;
}) {
	return catalog.isLoading ? (
		<Surface tier="panel" className="mx-auto mb-2 w-full max-w-3xl p-4">
			<Text role="body" tone="secondary" className="m-0">
				Loading connected app reads…
			</Text>
		</Surface>
	) : catalog.isError ? (
		<LoadError
			title="Connected app reads are unavailable"
			error={catalog.error}
			onRetry={catalog.refetch}
			retrying={catalog.isFetching}
		/>
	) : (
		<div className="mx-auto w-full max-w-3xl">
			<DirectReadComposer
				apps={catalog.data?.apps ?? []}
				pending={pending}
				onClose={onClose}
				onRun={onRun}
			/>
		</div>
	);
}

import { isRecord } from "@tedix/api-contract/utils/is-record";

type CallTool = (
	name: string,
	args: Record<string, unknown>,
) => Promise<unknown>;

function codeResult(value: unknown): unknown {
	if (!isRecord(value) || value.isError)
		throw new Error("The workspace could not be read. Refresh to try again.");
	const output = value.structuredContent;
	if (!isRecord(output) || output.partial === true)
		throw new Error(
			"Some workspace sources could not be read. Refresh to try again.",
		);
	return output.result;
}

/** Resolve exact, authorized callables; never guess a namespace across organizations. */
export async function resolveSidebarTool(
	call: CallTool,
	organization: string,
	tool: string,
	options: { readOnly?: boolean } = {},
): Promise<string> {
	const query = { query: tool, organization, limit: 100 };
	const result = codeResult(
		await call("code", {
			code: `async () => await discover.search(${JSON.stringify(query)})`,
		}),
	);
	const rows = isRecord(result) ? result.results : result;
	const matches = Array.isArray(rows)
		? rows.filter(
				(row) =>
					isRecord(row) &&
					row.tool === tool &&
					row.organization === organization &&
					row.authorized === true &&
					(!options.readOnly ||
						(isRecord(row.annotations) &&
							row.annotations.readOnlyHint === true)),
			)
		: [];
	if (
		matches.length !== 1 ||
		!isRecord(matches[0]) ||
		typeof matches[0].callable !== "string" ||
		!/^[a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*$/.test(matches[0].callable)
	) {
		throw new Error("This view is unavailable in the selected organization.");
	}
	return matches[0].callable;
}

export async function callSidebarTool(
	call: CallTool,
	callable: string,
	args: Record<string, unknown>,
) {
	if (!/^[a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*$/.test(callable))
		throw new Error("Invalid workspace tool.");
	const result = await call("code", {
		code: `async () => await ${callable}(${JSON.stringify(args)})`,
	});
	const output = codeResult(result);
	if (!isRecord(output) || output.ok === false || output.isError === true)
		throw new Error(
			"The workspace action could not complete. Refresh to try again.",
		);
	// Code Mode's full widget data avoids model-facing summary/truncation.
	const meta = isRecord(result) && isRecord(result._meta) ? result._meta : null;
	return isRecord(meta?.["tedix/widgetData"])
		? (meta["tedix/widgetData"] as Record<string, unknown>)
		: output;
}

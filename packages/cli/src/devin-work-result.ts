import { z } from "zod";

const resultSchema = z.strictObject({
	outcome: z.enum(["succeeded", "failed"]),
	note: z.string().trim().min(1).max(10000),
});

export const devinWorkResultInstruction = `Tedix credentials and plugin OAuth are intentionally unavailable inside this sandbox. To deliver your result, end your final response with one line:
TEDIX_WORK_RESULT {"outcome":"succeeded","note":"The requested Work note, including the actual result and evidence links."}
Use outcome "failed" if any requested result remains incomplete or blocked. JSON must have only outcome and note; escape newlines inside note. The dispatcher posts that note only to this admitted Work using this lane's existing identity. Do not try to read credentials, log in, change permissions or post through another identity. A missing or undelivered result fails the run.`;

export async function deliverDevinWorkResult(
	message: string,
	deliver: (note: string) => Promise<void>,
) {
	const lines = message.trim().split("\n");
	const resultLines = lines.filter((line) =>
		line.startsWith("TEDIX_WORK_RESULT "),
	);
	if (resultLines.length !== 1 || resultLines[0] !== lines.at(-1))
		throw new Error("Devin did not return one final structured Work result");
	const result = resultSchema.parse(
		JSON.parse(resultLines[0]!.slice("TEDIX_WORK_RESULT ".length)),
	);
	await deliver(result.note);
	return result;
}

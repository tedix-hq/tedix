/** Only metadata bound to this Worker version may identify its release. */
export function releaseManifest(input: {
	repository?: string;
	commitSha?: string;
	surface: "api" | "os";
	deploymentRunId?: string;
}) {
	if (
		!input.repository ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
		!input.commitSha ||
		!/^[a-f0-9]{40}$/.test(input.commitSha) ||
		!input.deploymentRunId ||
		!/^[1-9][0-9]*$/.test(input.deploymentRunId)
	)
		return null;
	const deploymentRunId = Number(input.deploymentRunId);
	if (!Number.isSafeInteger(deploymentRunId)) return null;
	return {
		repository: input.repository,
		commitSha: input.commitSha,
		surface: input.surface,
		deploymentRunId,
	};
}

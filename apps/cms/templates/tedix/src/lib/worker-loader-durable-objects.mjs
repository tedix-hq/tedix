export function workerLoaderDurableObjects(config, entrypoint) {
	return {
		entrypoint,
		config,
		type: "sqlite",
		supportsRequestScope: true,
		supportsCollectionDeletionGuard: true,
	};
}

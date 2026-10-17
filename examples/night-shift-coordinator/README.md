# Run a night shift without a lead chat

Install the skill under an existing project lead and bind its `tedix` namespace
to the organization's native tools. Set the schedule parameters in Tedix OS:

```json
{
	"workspaceId": "00000000-0000-4000-8000-000000000001",
	"projectIds": ["00000000-0000-4000-8000-000000000002"],
	"coordinatorId": "00000000-0000-4000-8000-000000000003",
	"maxLanes": 2,
	"maxRetries": 3,
	"people": [
		{
			"id": "example-person",
			"timeZone": "Europe/Berlin",
			"nightStart": "21:00",
			"briefAt": "08:15",
			"deckUrl": "https://os.example.com/workspaces/example/deck"
		}
	]
}
```

Use real IDs and an observed Deck URL only in your organization's configuration.
The schedule checks every 15 minutes; each person's time zone guards their
night window and morning slot, including daylight-saving changes.

The Work backlog is the queue. Assign an executor in the existing Work app,
accept the intended outcome and run the existing local dispatcher as a service.
The coordinator never starts a local process itself. Keep the local machine
awake when overnight execution is required.

Run the workflow checks with `bun test examples/night-shift-coordinator/workflow.test.js`.
A passing mock test is not proof of Cloud scheduling or unattended local recovery.
For that proof, kill a disposable admitted lane, observe server expiry, then
record the fresh Attempt, resumed worktree and settled result as Work evidence.

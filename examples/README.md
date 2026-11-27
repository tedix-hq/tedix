# Examples

These examples show different ways to use and configure Tedix. Each directory
has its own setup and, where applicable, tests.

- [Supplier review](supplier-review/) imports sample files into a local workspace
  and can request a model-generated decision note.
- [Agent review](agent-review/) contains intake configuration for an installation.
- [Engineering shift](engineering-shift/) classifies Work for a scheduled queue.
- [Incident hygiene](incident-hygiene/) closes eligible recovered incidents and
  abandoned stubs when configured with the required tools.
- [Night shift coordinator](night-shift-coordinator/) coordinates assigned Work
  and writes a morning brief.
- [Today digest](today-digest/) produces a saved project progress post.
- [Work board hygiene](work-board-hygiene/) proposes consolidation and cleans up
  eligible empty Work items.
- [Poppy personal agent](poppy-personal-agent/) hosts the public client
  metadata and JWKS for the simulated `tedix poppy` demo identities.

The workflow examples require an existing installation and explicit configuration.
Their local tests do not establish that a workflow is installed or running.

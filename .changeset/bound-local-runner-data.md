---
"@tedix/cli": patch
---

Keep local runner data from growing without limit. When run folders exceed the checkout cap, a runner now deletes the dependency folders of checkouts it has to keep (result not yet reported, or work not pushed) before evicting anything; their files and commits stay. Background status commands no longer write their normal output into `agent-status/report.log`, and that log is rotated before they write.

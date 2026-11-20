---
"@tedix/cli": patch
---

Runners now take their basic rules from the Tedix installation, so a new organization's runners work without creating a rules skill first. `tedix lane serve --rules <skill>` is optional: when the skill is active its text is added to the shared rules, and when it is missing or archived the runner says so in its log and health report and keeps working with the shared rules. If the shared rules cannot be read, the runner admits nothing and reports why. `tedix work runner-rules` prints the shared rules.

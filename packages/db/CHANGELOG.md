# @tedix/db

## 0.0.3

### Patch Changes

- 47c8c92: Wait four hours after a task's second consecutive deferral and 24 hours after its third. Keep the streak when an agent rewords its explanation; reset it when the task, a dependency or its approval changes. Let runners release saved waits when readiness confirms such a change, and show the next start time in readiness.

## 0.0.2

### Patch Changes

- Updated dependencies [6653d30]
  - @tedix/api-contract@0.0.2

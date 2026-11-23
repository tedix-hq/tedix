-- Intentionally empty. The original version rebuilt work_attempts and
-- work_admissions to allow executor_type 'human' in their CHECK constraints.
-- On production it exceeded D1's CPU limit, reset main D1 (code 7429) and
-- failed every Ship. Production keeps the old CHECKs, so human Attempts are
-- refused by the database until a cheap path to widen them lands.
SELECT 1;

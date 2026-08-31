-- Backs the permission-boundary field on User (see domain/types.ts's
-- userSchema doc comment and policy-evaluator.ts's evaluateWithBoundary).
-- Deliberately no foreign key: a boundary-referencing policy must remain
-- deletable exactly like any other policy, and the reference is meant to
-- be left dangling on purpose if that happens, so routes/guards.ts's
-- lookup fails closed (denies everything) rather than a FOREIGN KEY ...
-- ON DELETE SET NULL silently removing the ceiling and granting
-- unrestricted access the moment the referenced policy disappears.

ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_boundary_policy_id UUID;

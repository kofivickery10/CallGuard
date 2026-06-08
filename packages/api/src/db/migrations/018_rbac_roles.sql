-- Expand the role model from admin/member to admin/supervisor/viewer/adviser.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- Existing front-line "member" users become "adviser".
UPDATE users SET role = 'adviser' WHERE role = 'member';

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'supervisor', 'viewer', 'adviser'));

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'adviser';

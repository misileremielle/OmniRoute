-- The CLI tool configurators (dashboard CLI pages, /api/cli-tools/* writers and
-- `omniroute setup-*` commands) were removed, and nothing reads their saved
-- state any more. Drop the rows from the key_value store (namespaces written
-- by the removed src/lib/db/cliToolState.ts: last-configured timestamps and
-- pre-OmniRoute config snapshots); the runner records this file as 248.
DELETE FROM key_value WHERE namespace IN ('cliToolLastConfig', 'cliToolInitialConfig');

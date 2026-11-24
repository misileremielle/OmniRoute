-- 241_remove_cloud_agent_providers.sql
-- The cloud-agent providers (Google Jules, Devin, Codex Cloud) were removed from this fork.
-- Their ids double as their aliases. The migration runner's provider-removal step
-- (src/lib/db/providerRemovalMigration.ts) deletes their connections and stored credentials,
-- strips the deleted connection ids from API-key connection allowlists, and disables any API
-- key whose allowlist becomes empty. Historical usage and call-log rows are kept.
--
-- `devin-cli` and `devin-cli-agentic` are separate providers and stay.
INSERT INTO _provider_removal_ids (id) VALUES
  ('codex-cloud'),
  ('devin'),
  ('jules');

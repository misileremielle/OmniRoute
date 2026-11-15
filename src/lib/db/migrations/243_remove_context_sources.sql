-- The Notion, Obsidian and local-corpus context sources were removed with the MCP
-- server, which was their only consumer. Delete the credentials and settings they
-- stored so no orphaned token stays at rest.
--
--   notion        — Notion integration token
--   obsidian      — Local REST API token, base URL, vault path, WebDAV credentials
--   local_corpus  — local corpus root and settings
--   sync / omniroute_sync_token — Obsidian sync bearer token
--   api_key_context_sources     — per-API-key source credentials (migration 092)
DELETE FROM key_value WHERE namespace IN ('notion', 'obsidian', 'local_corpus');
DELETE FROM key_value WHERE namespace = 'sync' AND key = 'omniroute_sync_token';
DROP TABLE IF EXISTS api_key_context_sources;

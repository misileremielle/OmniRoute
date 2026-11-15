-- The PII masking settings UI and its sanitizer engines were removed, and
-- nothing reads these saved operator choices any more.
-- Drop the rows from the key_value store (namespace written by the removed
-- src/lib/db/piiSettings.ts); the runner records this file as 247.
DELETE FROM key_value WHERE namespace = 'pii_settings';

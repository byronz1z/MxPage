-- Only live settings change. Existing task snapshots retain their resolved protocol.
UPDATE "ProviderConfig" SET "textProtocol" = 'auto';

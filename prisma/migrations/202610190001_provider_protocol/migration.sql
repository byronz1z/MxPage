ALTER TABLE "ProviderConfig" ADD COLUMN "textProtocol" TEXT NOT NULL DEFAULT 'chat_completions';
ALTER TABLE "ProviderConfig" ADD COLUMN "structuredOutputMode" TEXT NOT NULL DEFAULT 'json_schema';

CREATE TABLE "AgentSession" (
  "id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL DEFAULT '新会话',
  "modelId" TEXT, "archived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "AgentMessage" (
  "id" TEXT NOT NULL PRIMARY KEY, "sessionId" TEXT NOT NULL, "role" TEXT NOT NULL,
  "content" TEXT NOT NULL, "attachments" JSONB NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE
);
CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL PRIMARY KEY, "sessionId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "mode" TEXT NOT NULL DEFAULT 'chat',
  "input" JSONB NOT NULL, "snapshot" JSONB NOT NULL, "plan" JSONB,
  "approvedHash" TEXT, "modelCalls" INTEGER NOT NULL DEFAULT 0, "toolCalls" INTEGER NOT NULL DEFAULT 0,
  "modelLimit" INTEGER NOT NULL DEFAULT 30, "toolLimit" INTEGER NOT NULL DEFAULT 100,
  "leaseToken" TEXT, "leaseUntil" DATETIME, "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
  FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "AgentRun_sessionId_idempotencyKey_key" ON "AgentRun"("sessionId", "idempotencyKey");
CREATE INDEX "AgentRun_sessionId_createdAt_idx" ON "AgentRun"("sessionId", "createdAt");
CREATE TABLE "AgentEvent" (
  "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "runId" TEXT NOT NULL,
  "type" TEXT NOT NULL, "data" JSONB NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE
);
CREATE INDEX "AgentEvent_runId_seq_idx" ON "AgentEvent"("runId", "seq");
CREATE TABLE "AgentToolCall" (
  "id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "callId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "argsHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "output" JSONB, "error" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "AgentToolCall_runId_callId_key" ON "AgentToolCall"("runId", "callId");
CREATE TABLE "AgentArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY, "sessionId" TEXT NOT NULL, "runId" TEXT,
  "name" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "filePath" TEXT, "url" TEXT,
  "kind" TEXT NOT NULL, "bytes" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE,
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL
);
CREATE TABLE "AgentCheckpoint" (
  "runId" TEXT NOT NULL, "namespace" TEXT NOT NULL, "checkpointId" TEXT NOT NULL,
  "parentId" TEXT, "type" TEXT NOT NULL, "checkpoint" BLOB NOT NULL, "metadata" BLOB NOT NULL,
  PRIMARY KEY ("runId", "namespace", "checkpointId"),
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE
);
CREATE TABLE "AgentCheckpointWrite" (
  "runId" TEXT NOT NULL, "namespace" TEXT NOT NULL, "checkpointId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL, "idx" INTEGER NOT NULL, "channel" TEXT NOT NULL,
  "type" TEXT NOT NULL, "value" BLOB NOT NULL,
  PRIMARY KEY ("runId", "namespace", "checkpointId", "taskId", "idx"),
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE
);
CREATE TABLE "AgentSetting" ("id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default', "value" JSONB NOT NULL);

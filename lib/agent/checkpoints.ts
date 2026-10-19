import { BaseCheckpointSaver, WRITES_IDX_MAP, type Checkpoint, type CheckpointMetadata, type CheckpointTuple, type CheckpointListOptions, type PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { prisma } from "@/lib/db/prisma";

// Uses LangGraph's serializer and the same SQLite database as sessions, so online
// backups capture graph state and tool ledgers atomically (no second native ABI).
export class SqliteAgentSaver extends BaseCheckpointSaver {
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const runId = config.configurable?.thread_id;
    if (!runId) return;
    const namespace = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    const saved = await prisma.agentCheckpoint.findFirst({ where: { runId, namespace, ...(checkpointId ? { checkpointId } : {}) }, orderBy: { checkpointId: "desc" } });
    if (!saved) return;
    const writes = await prisma.agentCheckpointWrite.findMany({ where: { runId, namespace, checkpointId: saved.checkpointId }, orderBy: [{ taskId: "asc" }, { idx: "asc" }] });
    return {
      config: { configurable: { thread_id: runId, checkpoint_ns: namespace, checkpoint_id: saved.checkpointId } },
      checkpoint: await this.serde.loadsTyped(saved.type, saved.checkpoint) as Checkpoint,
      metadata: await this.serde.loadsTyped("json", saved.metadata) as CheckpointMetadata,
      parentConfig: saved.parentId ? { configurable: { thread_id: runId, checkpoint_ns: namespace, checkpoint_id: saved.parentId } } : undefined,
      pendingWrites: await Promise.all(writes.map(async w => [w.taskId, w.channel, await this.serde.loadsTyped(w.type, w.value)] as [string, string, unknown])),
    };
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}) {
    const rows = await prisma.agentCheckpoint.findMany({ where: {
      ...(config.configurable?.thread_id ? { runId: config.configurable.thread_id } : {}),
      ...(config.configurable?.checkpoint_ns !== undefined ? { namespace: config.configurable.checkpoint_ns } : {}),
      ...(options.before?.configurable?.checkpoint_id ? { checkpointId: { lt: options.before.configurable.checkpoint_id } } : {}),
    }, orderBy: { checkpointId: "desc" } });
    let count = 0;
    for (const row of rows) {
      const tuple = await this.getTuple({ configurable: { thread_id: row.runId, checkpoint_ns: row.namespace, checkpoint_id: row.checkpointId } });
      if (!tuple || (options.filter && Object.entries(options.filter).some(([key, value]) => JSON.stringify(tuple.metadata?.[key as keyof CheckpointMetadata]) !== JSON.stringify(value)))) continue;
      if (options.limit !== undefined && count >= options.limit) break;
      count++; yield tuple;
    }
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    const runId = config.configurable?.thread_id;
    if (!runId) throw new Error("Missing thread_id");
    const namespace = config.configurable?.checkpoint_ns ?? "";
    const [type, bytes] = await this.serde.dumpsTyped(checkpoint);
    const [, meta] = await this.serde.dumpsTyped(metadata);
    const data = { runId, namespace, checkpointId: checkpoint.id, parentId: config.configurable?.checkpoint_id ?? null, type, checkpoint: Buffer.from(bytes), metadata: Buffer.from(meta) };
    await prisma.agentCheckpoint.upsert({ where: { runId_namespace_checkpointId: { runId, namespace, checkpointId: checkpoint.id } }, create: data, update: data });
    return { configurable: { thread_id: runId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string) {
    const { thread_id: runId, checkpoint_ns: namespace = "", checkpoint_id: checkpointId } = config.configurable ?? {};
    for (const [i, [channel, value]] of writes.entries()) {
      const idx = WRITES_IDX_MAP[channel] ?? i;
      const [type, bytes] = await this.serde.dumpsTyped(value);
      const data = { runId, namespace, checkpointId, taskId, idx, channel, type, value: Buffer.from(bytes) };
      await prisma.agentCheckpointWrite.upsert({ where: { runId_namespace_checkpointId_taskId_idx: { runId, namespace, checkpointId, taskId, idx } }, create: data, update: idx < 0 ? data : {} });
    }
  }
  async deleteThread(runId: string) {
    await prisma.$transaction([prisma.agentCheckpointWrite.deleteMany({ where: { runId } }), prisma.agentCheckpoint.deleteMany({ where: { runId } })]);
  }
}

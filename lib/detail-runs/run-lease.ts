import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export const RUN_LEASE_MS = 60_000;
export const RUN_HEARTBEAT_MS = 15_000;
export class RunHalted extends Error {
  constructor() { super("任务已停止或执行权已失效"); }
}

/** Cancellation drains already dispatched requests; only the lease owner may save their results. */
export async function claimRunLease(runId: string) {
  const token = randomUUID();
  const until = () => new Date(Date.now() + RUN_LEASE_MS);
  const claimed = await prisma.detailRun.updateMany({ where: { id: runId, status: "PENDING", leaseToken: null }, data: { status: "RUNNING", leaseToken: token, leaseUntil: until() } });
  if (!claimed.count) return null;
  let lost = false;
  let heartbeatBusy = false;
  let heartbeatWrite = Promise.resolve();
  const owner = (allowCanceled = false) => ({ id: runId, leaseToken: token, leaseUntil: { gt: new Date() }, status: { in: allowCanceled ? ["RUNNING", "CANCELED"] : ["RUNNING"] } });
  const timer = setInterval(() => {
    if (heartbeatBusy || lost) return;
    heartbeatBusy = true;
    heartbeatWrite = prisma.detailRun.updateMany({ where: owner(true), data: { leaseUntil: until() } })
      .then(result => { if (!result.count) lost = true; })
      .catch(() => { lost = true; }) // Fail closed: a worker unable to renew must not dispatch more work.
      .finally(() => { heartbeatBusy = false; });
  }, RUN_HEARTBEAT_MS);
  timer.unref?.();
  return {
    async assertActive() {
      if (lost || !await prisma.detailRun.findFirst({ where: owner(), select: { id: true } })) throw new RunHalted();
    },
    async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, allowCanceled = false): Promise<T> {
      if (lost) throw new RunHalted();
      return prisma.$transaction(async tx => {
        const locked = await tx.detailRun.updateMany({ where: owner(allowCanceled), data: { leaseUntil: until() } });
        if (!locked.count) throw new RunHalted();
        return work(tx);
      });
    },
    async release() {
      clearInterval(timer);
      await heartbeatWrite;
      await prisma.detailRun.updateMany({ where: { id: runId, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
    },
  };
}

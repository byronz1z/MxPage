import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskDuration, projectTaskDuration, startTiming, taskElapsed, timingElapsed, touchTiming } from "../lib/tasks/timing";
const start = Date.parse("2026-10-17T00:00:00Z");
const stamp = (offset: number) => new Date(start + offset).toISOString();

test("live timing advances, freezes at completion and resumes without charging waiting time", () => {
  const first = startTiming(undefined, start);
  assert.equal(timingElapsed(first, start + 5000), 5000);
  const paused = touchTiming(first, true, start + 5000);
  assert.equal(timingElapsed(paused, start + 100_000), 5000);
  const resumed = startTiming(paused, start + 100_000);
  assert.equal(timingElapsed(resumed, start + 103_000), 8000);
  const completed = touchTiming(resumed, true, start + 104_000);
  assert.equal(timingElapsed(completed, start + 9_000_000), 9000);
});

test("crash recovery counts to the last checkpoint and does not include days offline", () => {
  const crashed = touchTiming(startTiming(undefined, start), false, start + 8000);
  const restored = startTiming(JSON.parse(JSON.stringify(crashed)), start + 86_400_000);
  assert.equal(timingElapsed(restored, start + 86_401_000), 9000);
});

test("all non-running states freeze on refresh, pending work does not count queue time", () => {
  const base = { createdAt: stamp(0), updatedAt: stamp(20_000), startedAt: stamp(5000) };
  const running = projectTaskDuration({ ...base, status: "RUNNING" }, start + 25_000);
  assert.equal(taskElapsed(running, start + 26_000), 21_000);
  for (const status of ["SUCCESS", "COMPLETED", "PARTIAL", "FAILED", "CANCELED", "WAITING_INPUT", "INTERRUPTED"]) {
    const duration = projectTaskDuration({ ...base, status }, start + 99_000);
    assert.equal(duration.timerStartedAt, undefined);
    assert.equal(taskElapsed(duration, start + 900_000), 15_000);
  }
  assert.equal(projectTaskDuration({ ...base, status: "PENDING" }, start + 90_000).elapsedMs, 0);
  const legacy = projectTaskDuration({ createdAt: stamp(0), updatedAt: stamp(10_000), status: "COMPLETED" });
  assert.equal(legacy.timingEstimated, true);
  assert.equal(legacy.elapsedMs, 10_000);
});

test("saved completion time wins over later metadata edits and durations format safely", () => {
  const timing = touchTiming(startTiming(undefined, start), true, start + 65000);
  const item = projectTaskDuration({ status: "PARTIAL", createdAt: stamp(0), updatedAt: stamp(90000), timing });
  assert.equal(taskElapsed(item), 65000);
  assert.equal(formatTaskDuration(65000), "1分 5秒");
  assert.equal(formatTaskDuration(3661000), "1小时 1分 1秒");
  assert.equal(formatTaskDuration(-10), "0秒");
  assert.equal(formatTaskDuration(NaN), "0秒");
});

import { createHash } from "crypto";
import { realpathSync } from "fs";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export function GET() {
  const root = realpathSync(process.cwd());
  const workspaceId = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
  return NextResponse.json({ workspaceId, dist: process.env.NEXT_DIST_DIR || ".next" });
}

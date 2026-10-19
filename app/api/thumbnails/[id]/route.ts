import { prisma } from "@/lib/db/prisma";
import { readThumbnail } from "@/lib/storage/thumbnails";
import { fail, handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const asset = await prisma.productAsset.findUnique({ where: { id: params.id }, select: { filePath: true } });
    if (!asset) return fail("NOT_FOUND", "图片不存在。", null, 404);
    const { bytes, etag } = await readThumbnail(asset.filePath);
    const headers = { "Content-Type": "image/webp", "Cache-Control": "private, no-cache", ETag: etag, "X-Content-Type-Options": "nosniff" };
    return new Response(request.headers.get("if-none-match") === etag ? null : bytes, { status: request.headers.get("if-none-match") === etag ? 304 : 200, headers });
  } catch (error) { return handleRouteError(error); }
}

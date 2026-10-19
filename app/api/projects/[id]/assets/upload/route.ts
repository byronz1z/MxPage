import { NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { assertNoDetailRun, withAssetUploadLock } from "@/lib/detail-runs/lock";
import { saveUploadAsset } from "@/lib/storage/asset-manager";
import { fail, handleRouteError, ok } from "@/lib/utils/route";
import { isStyleReference } from "@/lib/utils/asset-purpose";
import { relativeStorageUrl } from "@/lib/utils/files";
import { readUploadJson, validateUploadedImage } from "@/lib/storage/upload-validation";
import { MAX_UPLOAD_BATCH_BYTES } from "@/lib/storage/upload-limits";

const uploadAssetSchema = z.object({
  type: z.enum(["MAIN", "ANGLE", "DETAIL", "REFERENCE"]),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  base64Data: z.string().min(1),
  purpose: z.enum(["product_identity", "style_reference"]).optional(),
  uploadKey: z.string().regex(/^[a-zA-Z0-9:-]{1,100}$/).optional(),
});

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    let input: z.infer<typeof uploadAssetSchema>, bytes: Buffer;
    try {
      input = uploadAssetSchema.parse(await readUploadJson(request));
      if (input.base64Data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64Data)) throw new Error("图片编码无效。");
      bytes = Buffer.from(input.base64Data, "base64");
      await validateUploadedImage(bytes, input.mimeType);
    } catch (error) { return fail("INVALID_IMAGE", error instanceof Error ? error.message : "图片校验失败", null, 400); }
    return await withAssetUploadLock(context.params.id, async () => {
    await assertNoDetailRun(context.params.id, input.purpose !== "style_reference");
    if (input.purpose === "style_reference") {
      if (input.type !== "REFERENCE") throw new Error("风格图必须使用参考素材类型。");
      const assets = await prisma.productAsset.findMany({ where: { projectId: context.params.id, type: "REFERENCE" } });
      if (assets.filter(isStyleReference).length >= 2) throw new Error("每套最多两张风格参考。");
      if (!["image/png", "image/jpeg", "image/webp"].includes(input.mimeType) || Buffer.byteLength(input.base64Data, "base64") > 10 * 1024 * 1024) throw new Error("风格参考支持 PNG、JPEG、WebP，每张不超过 10MB。");
    }
    const existingCount = await prisma.productAsset.count({
      where: { projectId: context.params.id },
    });
    const originals = await prisma.productAsset.findMany({ where: { projectId: context.params.id, type: { in: ["MAIN", "ANGLE", "DETAIL", "REFERENCE"] } }, select: { metadata: true } });
    const total = originals.reduce((sum, asset) => sum + Number((asset.metadata as { bytes?: number } | null)?.bytes || 0), 0);
    // Idempotent retries are checked in saveUploadAsset before enforcing the budget.

    const asset = await saveUploadAsset({
      projectId: context.params.id,
      type: input.type,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileBuffer: bytes,
      maxExistingBytes: total,
      maxTotalBytes: MAX_UPLOAD_BATCH_BYTES,
      sortOrder: existingCount,
      isMain: input.type === "MAIN",
      purpose: input.purpose,
      uploadKey: input.uploadKey,
    });

    return ok({ ...asset, url: relativeStorageUrl(asset.filePath) }, { status: 201 });
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

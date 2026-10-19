import { NextRequest } from "next/server";
import { z } from "zod";

import { readProviderCredentialsFromRequest, withProviderCredentials } from "@/lib/services/provider-runtime";
import { createBatchCreateTask } from "@/lib/services/workflow-task-service";
import { handleRouteError, ok } from "@/lib/utils/route";
import { MAX_UPLOAD_BATCH_BYTES } from "@/lib/storage/upload-limits";
import { readUploadJson, validateUploadedImage } from "@/lib/storage/upload-validation";

const batchFileSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  base64Data: z.string().min(1),
});

const requestSchema = z.object({
  files: z.array(batchFileSchema).min(1).max(30),
  autoGenerateImages: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  return withProviderCredentials(request, async () => {
    try {
      const input = requestSchema.parse(await readUploadJson(request, MAX_UPLOAD_BATCH_BYTES));
      let total = 0;
      for (const file of input.files) {
        if (file.base64Data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64Data)) throw new Error("图片编码无效。");
        const bytes = Buffer.from(file.base64Data, "base64"); total += bytes.length;
        if (total > MAX_UPLOAD_BATCH_BYTES) throw new Error("本次图片总量超过 300MB，请分批上传。");
        await validateUploadedImage(bytes, file.mimeType);
      }
      const task = await createBatchCreateTask(input, readProviderCredentialsFromRequest(request));
      return ok(task, { status: 202 });
    } catch (error) {
      return handleRouteError(error);
    }
  });
}

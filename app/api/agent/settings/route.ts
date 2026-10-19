import { NextRequest } from "next/server";
import { getAgentSettings, saveAgentSettings, installedSkills } from "@/lib/agent/settings";
import { sandboxAvailable } from "@/lib/agent/sandbox";
import { desktopBridgeAvailable, desktopRequest } from "@/lib/agent/desktop";
import { getActiveProviderConfig } from "@/lib/services/provider-service";
import { sameOrigin } from "@/lib/agent/http";
import { ok, handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const settings = await getAgentSettings();
    const provider = await getActiveProviderConfig();
    return ok({ settings, skills: (await installedSkills()).map(s => s.id), sandbox: await sandboxAvailable(settings), desktop: desktopBridgeAvailable() ? await desktopRequest("status") : { available: false, reason: "普通网页版不提供本机控制" }, models: provider?.models.filter(m => m.isAvailable && m.capabilities.text).map(m => ({ id: m.modelId, label: m.label, default: m.isDefaultPlanning, vision: Boolean(m.capabilities.vision) })) || [] });
  } catch (error) { return handleRouteError(error); }
}
export async function PUT(request: NextRequest) {
  try { sameOrigin(request); return ok(await saveAgentSettings(await request.json())); } catch (error) { return handleRouteError(error); }
}

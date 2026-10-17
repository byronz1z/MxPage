import { getBillingRules, saveBillingRules } from "@/lib/monitor/billing-settings";
import { handleRouteError, ok } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET() { try { return ok(await getBillingRules()); } catch (error) { return handleRouteError(error); } }
export async function PUT(request: Request) { try { return ok(await saveBillingRules(await request.json())); } catch (error) { return handleRouteError(error); } }

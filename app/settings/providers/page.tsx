import ProviderSettingsPageClient from "@/components/providers/provider-settings-page-client";
import { getBillingRules } from "@/lib/monitor/billing-settings";

export const dynamic = "force-dynamic";

export default async function ProviderSettingsPage() {
  return <ProviderSettingsPageClient billingRules={await getBillingRules()} />;
}

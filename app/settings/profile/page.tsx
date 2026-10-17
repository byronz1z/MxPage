import { UserProfilePage } from "@/components/settings/user-profile";
import { listApiUsageEntries } from "@/lib/monitor/api-usage";
import { buildUsageActivity } from "@/lib/monitor/activity";
import { getBillingRules } from "@/lib/monitor/billing-settings";

export const dynamic = "force-dynamic";
export default async function ProfilePage() {
  const [entries, billingRules] = await Promise.all([listApiUsageEntries(Number.MAX_SAFE_INTEGER), getBillingRules()]);
  const activity = buildUsageActivity(entries);
  return <UserProfilePage key={activity.today} activity={activity} usdToCny={billingRules.usdToCny} />;
}

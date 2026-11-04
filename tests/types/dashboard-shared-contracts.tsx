import { ActivityHeatmap } from "../../src/shared/components/analytics/charts";

import {
  buildStaticProviderEntries,
  type ProviderEntry,
} from "../../src/app/(dashboard)/dashboard/providers/providerPageUtils";

buildStaticProviderEntries("no-auth", (_providerId, authType) => {
  const supportedAuthType: ProviderEntry["toggleAuthType"] = authType;
  return { total: supportedAuthType === "no-auth" ? 0 : 1 };
});

type StatsAuthType = Parameters<Parameters<typeof buildStaticProviderEntries>[1]>[1];
export const noAuthStatsType: StatsAuthType = "no-auth";
// @ts-expect-error Activity totals must be numeric, not preformatted strings.
export const invalidActivity = <ActivityHeatmap activityMap={{ today: "123" }} />;

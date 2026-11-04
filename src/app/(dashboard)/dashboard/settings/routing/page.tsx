"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import RoutingStrategyCard from "../components/RoutingStrategyCard";
import QuotaPreflightCard from "../components/QuotaPreflightCard";
import RoutingTab from "../components/RoutingTab";
import ModelRoutingSection from "@/shared/components/ModelRoutingSection";
import ComboDefaultsTab from "../components/ComboDefaultsTab";
import FallbackChainsEditor from "../components/FallbackChainsEditor";
import ModelAliasesUnified from "../components/ModelAliasesUnified";
import BackgroundDegradationTab from "../components/BackgroundDegradationTab";
import CatalogVisibilityCard from "../components/CatalogVisibilityCard";

export default function SettingsRoutingPage() {
  const t = useTranslations("settings");
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("globalRouting")}
        description={t("routingSettingsIntro")}
      />
      <RoutingStrategyCard />
      <QuotaPreflightCard />
      <ComboDefaultsTab />
      <CatalogVisibilityCard />
      <ModelAliasesUnified />
      <FallbackChainsEditor />
      <ModelRoutingSection />
      <RoutingTab />
      <BackgroundDegradationTab />
    </div>
  );
}

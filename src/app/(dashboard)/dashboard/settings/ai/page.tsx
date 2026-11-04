"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import ConnectionTestSettings from "../components/ConnectionTestSettings";
import ThinkingBudgetTab from "../components/ThinkingBudgetTab";
import ModalityBridgeMovedCard from "../components/ModalityBridgeMovedCard";
import ResponsesStatePolicyTab from "../components/ResponsesStatePolicyTab";
import CodexFastTierTab from "../components/CodexFastTierTab";
import CodexAutoPingTab from "../components/CodexAutoPingTab";
import ClaudeFastModeTab from "../components/ClaudeFastModeTab";
import ModelsDevSyncTab from "../components/ModelsDevSyncTab";
import UsageTokenBufferTab from "../components/UsageTokenBufferTab";
import ModelCapabilityOverridesTab from "../components/ModelCapabilityOverridesTab";

export default function SettingsAiPage() {
  const t = useTranslations("settings");
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="space-y-6">
      <PageHeader compact title={tSidebar("settingsAi")} description={t("aiSettingsIntro")} />
      <ThinkingBudgetTab />
      <ModalityBridgeMovedCard />
      <ResponsesStatePolicyTab />
      <UsageTokenBufferTab />
      <CodexFastTierTab />
      <ConnectionTestSettings />
      <CodexAutoPingTab />
      <ClaudeFastModeTab />
      <ModelCapabilityOverridesTab />
      <ModelsDevSyncTab />
    </div>
  );
}

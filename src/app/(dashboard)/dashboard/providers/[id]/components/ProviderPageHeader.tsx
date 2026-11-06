"use client";

import Icon from "@/shared/components/Icon";

// Phase 1t.1 extraction — Issue #3501
import Link from "next/link";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Button } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getHeaderIconProviderId } from "../providerPageHelpers";
import type { ProviderMessageTranslator } from "../providerPageHelpers";
import type { ProviderNotice } from "@/lib/providers/catalog";

interface ProviderInfo {
  id: string;
  name: string;
  website?: string;
  color?: string;
  apiType?: string;
  /** Optional operator-supplied remote icon URL (#2166) for compatible provider nodes. */
  iconUrl?: string;
  /** Short text-badge fallback (e.g. "OC"/"AC"/"CC") shown if `iconUrl` fails to load. */
  textIcon?: string;
  /** Optional registration/API-key URL hints rendered as links (#9270). */
  notice?: ProviderNotice;
}

interface ProviderPageHeaderProps {
  providerId: string;
  providerInfo: ProviderInfo;
  connectionsCount: number;
  isOpenAICompatible: boolean;
  isAnthropicProtocolCompatible: boolean;
  onOpenTutorial: () => void;
  t: ProviderMessageTranslator;
}

export default function ProviderPageHeader({
  providerId,
  providerInfo,
  connectionsCount,
  isOpenAICompatible,
  isAnthropicProtocolCompatible,
  onOpenTutorial,
  t,
}: ProviderPageHeaderProps) {
  // Resolve the API-key registration link: prefer apiKeyUrl, fall back to
  // signupUrl, hide when neither is set (#9270).
  const noticeUrl = providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl;
  const apiKeyLink = noticeUrl ? (
    <a
      href={noticeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm font-medium text-primary underline underline-offset-2 hover:text-text-main transition-colors inline-flex items-center gap-1"
    >
      <Icon name="open_in_new" size={16} />
      {t("getApiKey")}
    </a>
  ) : null;

  return (
    <PageHeader
      compact
      breadcrumbs={
        <Link
          href="/dashboard/providers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors"
        >
          <Icon name="arrow_back" size={18} />
          {t("backToProviders")}
        </Link>
      }
      title={
        <span className="inline-flex items-center gap-4">
          {/* The brand colour is only a tint behind the icon; text uses neutral/primary tokens. */}
          <span
            className="inline-flex items-center justify-center rounded-lg"
            style={{ backgroundColor: `${providerInfo.color}15` }}
          >
            <ProviderIcon
              providerId={getHeaderIconProviderId(
                isOpenAICompatible,
                isAnthropicProtocolCompatible,
                providerInfo.id,
                providerInfo.apiType
              )}
              size={48}
              type="color"
              src={providerInfo.iconUrl}
              alt={providerInfo.name}
              fallbackText={providerInfo.textIcon}
              fallbackColor={providerInfo.color}
            />
          </span>
          {providerInfo.website ? (
            <a
              href={providerInfo.website}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline hover:text-primary inline-flex items-center gap-2"
            >
              {providerInfo.name}
              <Icon name="open_in_new" size={18} className="opacity-60" />
            </a>
          ) : (
            providerInfo.name
          )}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span>{t("connectionCountLabel", { count: connectionsCount })}</span>
          {apiKeyLink}
          {providerId === "adapta-web" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenTutorial}
              className="h-auto min-h-0 px-0 text-sm font-medium text-primary underline underline-offset-2 hover:bg-transparent hover:text-text-main"
            >
              Tutorial
            </Button>
          )}
        </span>
      }
    />
  );
}

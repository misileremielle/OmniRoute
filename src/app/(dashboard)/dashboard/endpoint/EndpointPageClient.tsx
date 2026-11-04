"use client";

import Icon from "@/shared/components/Icon";
import { Alert } from "@omniroute/ui-kit/alert";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Checkbox } from "@omniroute/ui-kit/checkbox";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import { CardSkeleton } from "@/shared/components/Loading";
import Modal from "@/shared/components/Modal";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { isPublicDisplayBaseUrl, useDisplayBaseUrl } from "@/shared/hooks";
import { useTranslations } from "next-intl";
import A2ADashboardPage from "./components/A2ADashboard";
import McpDashboardPage from "./components/MCPDashboard";
import NotionSourceCard from "./components/NotionSourceCard";
import ObsidianSourceCard from "./components/ObsidianSourceCard";

const BUILD_TIME_CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL || null;
const CLOUD_ACTION_TIMEOUT_MS = 15000;

type TranslationValues = Record<string, string | number | boolean | Date>;
type APIPageClientProps = {
  machineId: string;
};

type EndpointProviderSummary = {
  id: string;
  provider: {
    name: string;
    alias?: string;
  };
};

type EndpointModelSummary = {
  id: string;
  owned_by?: string;
  parent?: string;
  type?: string;
  custom?: boolean;
  root?: string;
};

/**
 * Copy handlers report whether the write succeeded; useCopyToClipboard returns
 * Promise<boolean>. Promise<boolean> is not assignable to Promise<void>, so the
 * type has to admit the boolean even though most call sites ignore it.
 */
type CopyHandler = (text: string, key?: string) => void | Promise<boolean>;

type EndpointTab = "apis" | "mcp" | "a2a" | "context-sources";

const ENDPOINT_TABS: Array<{ value: EndpointTab; labelKey: string; icon: string }> = [
  { value: "apis", labelKey: "tabApis", icon: "api" },
  { value: "mcp", labelKey: "tabMcp", icon: "extension" },
  { value: "a2a", labelKey: "tabA2a", icon: "hub" },
  { value: "context-sources", labelKey: "tabContextSources", icon: "database" },
];

function runEndpointBackgroundTask(taskName: string, task: () => Promise<unknown>) {
  void task().catch((error) => {
    console.log("Error running endpoint background task:", taskName, error);
  });
}

export default function APIPageClient({ machineId }: Readonly<APIPageClientProps>) {
  const [resolvedMachineId, setResolvedMachineId] = useState(machineId || "");
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  const [loading, setLoading] = useState(true);

  // Endpoints / models state
  const [allModels, setAllModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Cloud sync state
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [acknowledgeCloudUpload, setAcknowledgeCloudUpload] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudStatus, setCloudStatus] = useState(null);
  const [syncStep, setSyncStep] = useState(""); // "syncing" | "verifying" | "disabling" | "done" | ""
  const [modalSuccess, setModalSuccess] = useState(false); // show success state in modal before closing
  const [selectedProvider, setSelectedProvider] = useState(null); // for provider models popup
  const [cloudBaseUrl, setCloudBaseUrl] = useState(BUILD_TIME_CLOUD_URL); // dynamic cloud URL from API response
  const [cloudConfigured, setCloudConfigured] = useState(Boolean(BUILD_TIME_CLOUD_URL));
  const [_mcpStatus, setMcpStatus] = useState<any>(null);
  const [_a2aStatus, setA2aStatus] = useState<any>(null);
  const [searchProviders, setSearchProviders] = useState<any[]>([]);
  const [localApiUrl, setLocalApiUrl] = useState(
    typeof window !== "undefined" ? `${window.location.origin}/v1` : "http://localhost:20128/v1"
  );
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [activeEndpointTab, setActiveEndpointTab] = useState<EndpointTab>("apis");

  const { copied, copy } = useCopyToClipboard();

  const translateOrFallback = useCallback(
    (key: string, fallback: string, values?: TranslationValues) => {
      try {
        const message = values ? t(key as never, values as never) : t(key as never);
        if (!message || message === key || message === `endpoint.${key}`) {
          return fallback;
        }
        return message;
      } catch {
        return fallback;
      }
    },
    [t]
  );

  const fetchSearchProviders = async () => {
    try {
      const res = await fetch("/api/search/providers");
      if (res.ok) {
        const data = await res.json();
        setSearchProviders(data.providers || []);
      }
    } catch {
      // Search endpoint may not be available
    }
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    try {
      const res = await fetch("/v1/models");
      if (res.ok) {
        const data = await res.json();
        setAllModels(data.data || []);
      }
    } catch (e) {
      console.log("Error fetching models:", e);
    } finally {
      setModelsLoading(false);
    }
  };

  const fetchProtocolStatus = async () => {
    try {
      const [mcpRes, a2aRes] = await Promise.allSettled([
        fetch("/api/mcp/status"),
        fetch("/api/a2a/status"),
      ]);

      if (mcpRes.status === "fulfilled" && mcpRes.value.ok) {
        setMcpStatus(await mcpRes.value.json());
      }
      if (a2aRes.status === "fulfilled" && a2aRes.value.ok) {
        setA2aStatus(await a2aRes.value.json());
      }
    } catch {
      // Ignore status failures; protocols panel has fallback text.
    }
  };

  // Categorize models by endpoint type
  // Filter out parent models (models with parent field set) to avoid showing duplicates
  const endpointData = useMemo(() => {
    const chat = allModels.filter((m) => !m.type && !m.parent);
    const embeddings = allModels.filter((m) => m.type === "embedding" && !m.parent);
    const images = allModels.filter((m) => m.type === "image" && !m.parent);
    const video = allModels.filter((m) => m.type === "video" && !m.parent);
    const rerank = allModels.filter((m) => m.type === "rerank" && !m.parent);
    const audioTranscription = allModels.filter(
      (m) => m.type === "audio" && m.subtype === "transcription" && !m.parent
    );
    const audioSpeech = allModels.filter(
      (m) => m.type === "audio" && m.subtype === "speech" && !m.parent
    );
    const moderation = allModels.filter((m) => m.type === "moderation" && !m.parent);
    const music = allModels.filter((m) => m.type === "music" && !m.parent);
    return {
      chat,
      embeddings,
      images,
      video,
      rerank,
      audioTranscription,
      audioSpeech,
      moderation,
      music,
    };
  }, [allModels]);

  const totalEndpointModelCount = useMemo(
    () => Object.values(endpointData).reduce((acc, models) => acc + models.length, 0),
    [endpointData]
  );

  const availableEndpointCount = useMemo(() => {
    const chatCount = endpointData.chat.length > 0 ? 4 : 0; // chat + responses + completions + messages
    const imageCount = endpointData.images.length > 0 ? 2 : 0; // image gen + image edits
    const otherMedia = [
      endpointData.embeddings,
      endpointData.audioTranscription,
      endpointData.audioSpeech,
      endpointData.music,
      endpointData.video,
    ].filter((m) => m.length > 0).length;
    const utilityFixed = 3; // batch + files + list models (always available)
    const modelUtility =
      (endpointData.rerank.length > 0 ? 1 : 0) + (endpointData.moderation.length > 0 ? 1 : 0);
    const searchCount = searchProviders.length > 0 ? 1 : 0;
    return chatCount + imageCount + otherMedia + utilityFixed + modelUtility + searchCount;
  }, [endpointData, searchProviders]);

  const postCloudAction = async (action, timeoutMs = CLOUD_ACTION_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("/api/sync/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "enable" ? { acknowledgeCredentialUpload: acknowledgeCloudUpload } : {}),
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { ok: false, status: 408, data: { error: t("cloudRequestTimeout") } };
      }
      return { ok: false, status: 500, data: { error: error.message || t("cloudRequestFailed") } };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const loadCloudSettings = async (shouldApplyState: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();

        if (!shouldApplyState()) {
          return;
        }

        setCloudEnabled(data.cloudEnabled || false);
        if (typeof data.cloudConfigured === "boolean") {
          setCloudConfigured(data.cloudConfigured);
        }
        if (data.cloudUrl) {
          setCloudBaseUrl(data.cloudUrl);
        }
        if (data.machineId) {
          setResolvedMachineId(data.machineId);
        }
      }
    } catch (error) {
      console.log("Error loading cloud settings:", error);
    }
  };

  useEffect(() => {
    let mounted = true;

    const loadPage = async () => {
      await loadCloudSettings(() => mounted);

      if (!mounted) return;
      setLoading(false);

      runEndpointBackgroundTask("models", fetchModels);
      runEndpointBackgroundTask("protocol-status", fetchProtocolStatus);
      runEndpointBackgroundTask("search-providers", fetchSearchProviders);
      runEndpointBackgroundTask("network-info", async () => {
        try {
          const res = await fetch("/api/network/info");
          if (res.ok) {
            const data = await res.json();
            if (mounted) {
              if (data.localUrl) setLocalApiUrl(data.localUrl);
              setLanUrls(data.lanUrls ?? []);
            }
          }
        } catch {
          // non-critical
        }
      });
    };

    void loadPage();

    return () => {
      mounted = false;
    };
  }, []);

  const handleCloudToggle = (checked) => {
    if (checked) {
      if (!cloudConfigured) {
        setCloudStatus({
          type: "warning",
          message: translateOrFallback(
            "cloudSyncNotConfigured",
            "Cloud sync is not configured on this instance."
          ),
        });
        return;
      }
      setAcknowledgeCloudUpload(false);
      setShowCloudModal(true);
    } else {
      setShowDisableModal(true);
    }
  };

  // Auto-dismiss cloudStatus after 5s
  useEffect(() => {
    if (cloudStatus) {
      const timer = setTimeout(() => setCloudStatus(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [cloudStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchProtocolStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const dispatchCloudChange = () => {
    globalThis.dispatchEvent(new Event("cloud-status-changed"));
  };

  const handleEnableCloud = async () => {
    if (!acknowledgeCloudUpload || !cloudConfigured) return;
    setCloudSyncing(true);
    setModalSuccess(false);
    setSyncStep("syncing");
    try {
      const { ok, status, data } = await postCloudAction("enable");
      if (ok) {
        setSyncStep("verifying");

        // Brief delay so user sees the verifying step
        await new Promise((r) => setTimeout(r, 600));

        // Sync succeeded — mark as enabled regardless of verify result
        setCloudEnabled(true);
        setSyncStep("done");
        setModalSuccess(true);
        setCloudSyncing(false);
        dispatchCloudChange();

        // Show success in modal for a moment, then close
        await new Promise((r) => setTimeout(r, 1200));
        setShowCloudModal(false);
        setModalSuccess(false);

        if (data.verified) {
          setCloudStatus({ type: "success", message: t("cloudConnectedVerified") });
        } else {
          setCloudStatus({
            type: "warning",
            message: data.verifyError
              ? t("connectedVerificationPendingWithError", { error: data.verifyError })
              : t("connectedVerificationPending"),
          });
        }

        // Update cloud URL from API response (fixes undefined/v1 when env var not set)
        if (data.cloudUrl) {
          setCloudBaseUrl(data.cloudUrl);
        }
        // Reload settings to ensure fresh state
        await loadCloudSettings();
      } else {
        // Sync failed — provide a helpful error message
        let errorMessage = data.error || t("failedEnable");
        if (status === 502 || status === 408) {
          errorMessage = t("cloudWorkerUnreachable");
        }
        setCloudStatus({ type: "error", message: errorMessage });
        setShowCloudModal(false);
      }
    } catch (error) {
      setCloudStatus({ type: "error", message: error.message || t("connectionFailed") });
      setShowCloudModal(false);
    } finally {
      setCloudSyncing(false);
      setSyncStep("");
    }
  };

  const handleConfirmDisable = async () => {
    setCloudSyncing(true);
    setSyncStep("syncing");

    try {
      // Step 1: Sync latest data from cloud
      await postCloudAction("sync");

      setSyncStep("disabling");

      // Step 2: Disable cloud
      const { ok, data } = await postCloudAction("disable");

      if (ok) {
        setCloudEnabled(false);
        setCloudStatus({ type: "success", message: t("cloudDisabledSuccess") });
        setShowDisableModal(false);
        dispatchCloudChange();
        await loadCloudSettings();
      } else {
        setCloudStatus({ type: "error", message: data.error || t("failedDisable") });
      }
    } catch (error) {
      console.log("Error disabling cloud:", error);
      setCloudStatus({ type: "error", message: t("failedDisable") });
    } finally {
      setCloudSyncing(false);
      setSyncStep("");
    }
  };

  const displayBaseUrl = useDisplayBaseUrl();
  const displayApiUrl = `${displayBaseUrl}/v1`;
  const publicDisplayApiUrl = isPublicDisplayBaseUrl(displayBaseUrl) ? displayApiUrl : null;
  const normalizedCloudBaseUrl = cloudBaseUrl
    ? resolvedMachineId && !cloudBaseUrl.endsWith(`/${resolvedMachineId}`)
      ? `${cloudBaseUrl}/${resolvedMachineId}`
      : cloudBaseUrl
    : null;
  const cloudEndpointNew = normalizedCloudBaseUrl ? `${normalizedCloudBaseUrl}/v1` : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const publicUrls = publicDisplayApiUrl
    ? [{ label: t("tierPublic"), url: publicDisplayApiUrl, key: "active_public" }]
    : [];
  const currentEndpoint =
    publicDisplayApiUrl ??
    (cloudEnabled && cloudEndpointNew ? cloudEndpointNew : null) ??
    displayApiUrl;
  const activeUrls = [
    ...publicUrls,
    ...(cloudEnabled && cloudEndpointNew
      ? [{ label: t("activeCloud"), url: cloudEndpointNew, key: "active_cloud" }]
      : []),
    { label: t("activeLocal"), url: localApiUrl, key: "active_local" },
  ].filter(
    (candidate, index, candidates) =>
      candidates.findIndex((other) => other.url === candidate.url) === index
  );
  return (
    <div className="flex flex-col gap-8">
      {/* Guided connection header (#11228): /v1 URL + test action lead; advanced protocols demoted */}
      <div className="flex flex-col gap-2">
        <PageHeader compact title={t("title")} description={t("subtitle")} />
        <div className="flex items-center gap-3 mt-2">
          <code className="text-sm bg-card-subtle px-3 py-1 rounded-md text-text-main font-mono">
            {displayBaseUrl}/v1
          </code>
          <a href="#test" className="text-sm text-action font-medium hover:underline">
            {t("testEndpoint")}
          </a>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>{t("advancedProtocols")}</span>
        </div>
      </div>
      <SegmentedControl
        options={ENDPOINT_TABS.map((tab) => ({ ...tab, label: t(tab.labelKey) }))}
        value={activeEndpointTab}
        onChange={(value) => setActiveEndpointTab(value as EndpointTab)}
        aria-label={t("endpointSections")}
        className="w-fit"
      />

      {activeEndpointTab === "mcp" ? <McpDashboardPage /> : null}
      {activeEndpointTab === "a2a" ? <A2ADashboardPage /> : null}
      {activeEndpointTab === "context-sources" ? (
        <div className="flex flex-col gap-4">
          <NotionSourceCard />
          <ObsidianSourceCard />
        </div>
      ) : null}

      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4">{t("title")}</h2>

        {/* Cloud Status Toast */}
        {cloudStatus && (
          <Alert
            variant={
              cloudStatus.type === "success"
                ? "success"
                : cloudStatus.type === "warning"
                  ? "warning"
                  : "critical"
            }
            className="mb-4 animate-in fade-in slide-in-from-top-2 duration-300"
            icon={
              <Icon
                name={
                  cloudStatus.type === "success"
                    ? "check_circle"
                    : cloudStatus.type === "warning"
                      ? "warning"
                      : "error"
                }
                size={18}
              />
            }
            description={cloudStatus.message}
            dismissLabel={tc("close")}
            onDismiss={() => setCloudStatus(null)}
          />
        )}

        {/* Active URLs bar */}
        {activeUrls.length > 0 && (
          <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <p className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-2">
              {t("activeEndpoints")}
            </p>
            <div className="flex flex-col gap-1.5">
              {activeUrls.map(({ label, url, key }) => (
                <div key={key} className="flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                  <span className="text-xs text-text-muted w-20 shrink-0">{label}</span>
                  <code className="text-xs font-mono text-text-main flex-1 truncate min-w-0">
                    {url}
                  </code>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => void copy(url, key)}
                    className="shrink-0 text-text-muted"
                    aria-label={`${tc("copy")} ${label}`}
                    title={url}
                    icon={copied === key ? "check" : "content_copy"}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Connection rows */}
        <div className="flex flex-col">
          {/* Local Server */}
          <div className="flex items-center gap-3 py-3">
            <Icon name="computer" size={18} className="text-success" />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1 flex-wrap">
                <span className="text-sm font-medium">{t("localServer")}</span>
                {resolvedMachineId && (
                  <span className="text-xs text-text-muted">· {resolvedMachineId.slice(0, 8)}</span>
                )}
                {lanUrls.map((url) => (
                  <Button
                    key={url}
                    variant="ghost"
                    size="sm"
                    onClick={() => void copy(url, `lan_${url}`)}
                    title={t("copyUrlTitle", { url })}
                    aria-label={t("copyUrlTitle", { url })}
                    className="h-auto min-h-0 gap-0.5 px-1 py-0 text-[10px] font-normal text-text-muted"
                  >
                    <code className="font-mono">{url.replace(/^https?:\/\//, "")}</code>
                    <Icon
                      name={copied === `lan_${url}` ? "check" : "content_copy"}
                      size={10}
                      className="opacity-60"
                    />
                  </Button>
                ))}
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 border border-success/30 text-success shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              {t("statusRunning")}
            </span>
            <Button
              variant="outline"
              size="sm"
              icon={copied === "endpoint_url" ? "check" : "content_copy"}
              onClick={() => void copy(localApiUrl, "endpoint_url")}
              className="shrink-0 text-text-muted"
            >
              {copied === "endpoint_url" ? tc("copied") : tc("copy")}
            </Button>
          </div>

          {/* Cloud OmniRoute — wraps below sm: the text block keeps a minimum width so the
              status pill and the action move to the next line instead of squeezing it; only
              the URL may break anywhere ("Cloud sync d|estination" at 390 px, F4). */}
          <div className="flex flex-wrap items-center gap-3 py-3 border-t border-border/50">
            <Icon name="cloud" size={18} className="text-info" />
            <div className="flex-1 min-w-[12rem]">
              <span className="text-sm font-medium">{t("cloudOmniroute")}</span>
              <p
                className="text-xs text-text-muted break-words"
                data-testid="cloud-sync-destination"
              >
                {translateOrFallback(
                  "cloudUploadDestination",
                  "Cloud sync destination (not local backups):"
                )}{" "}
                {/* break-all only for a URL: the "Not configured" fallback is words (review I-1). */}
                <span className={cloudBaseUrl ? "break-all" : undefined}>
                  {cloudBaseUrl || tc("notConfigured")}
                </span>
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border shrink-0 ${
                cloudEnabled
                  ? "bg-success/10 border-success/30 text-success"
                  : "bg-surface border-border/70 text-text-muted"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${cloudEnabled ? "bg-success animate-pulse" : "bg-text-muted"}`}
              />
              {cloudEnabled ? tc("active") : tc("disabled")}
            </span>
            {cloudEnabled ? (
              <Button
                size="sm"
                variant="secondary"
                icon="cloud_off"
                onClick={() => handleCloudToggle(false)}
                disabled={cloudSyncing}
                className="shrink-0 border-error/30 text-error hover:bg-error/10"
              >
                {t("disableCloud")}
              </Button>
            ) : cloudConfigured ? (
              <Button
                size="sm"
                variant="primary"
                icon="cloud_upload"
                onClick={() => handleCloudToggle(true)}
                disabled={cloudSyncing}
                className="shrink-0"
              >
                {t("enableCloud")}
              </Button>
            ) : (
              <span className="text-xs text-text-muted shrink-0 px-2 py-1 rounded border border-border/70 bg-surface">
                {tc("notConfigured")}
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold">{t("available")}</h2>
            <p className="text-sm text-text-muted">
              {modelsLoading
                ? translateOrFallback("loadingModels", "Loading available models...")
                : t("modelsAcrossEndpoints", {
                    models: totalEndpointModelCount,
                    endpoints: availableEndpointCount,
                  })}
            </p>
          </div>
        </div>

        {/* Core APIs */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <Icon name="hub" className="text-sm text-primary" />
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              {t("categoryCore")}
            </h3>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <EndpointCard
              icon="chat"
              iconColor="text-info"
              iconBg="bg-info/10"
              title={t("chatCompletions")}
              path="/v1/chat/completions"
              models={endpointData.chat}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="code"
              iconColor="text-chart-3"
              iconBg="bg-chart-3/10"
              title={t("responses")}
              path="/v1/responses"
              models={endpointData.chat}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="psychology"
              iconColor="text-chart-3"
              iconBg="bg-chart-3/10"
              title={t("messagesApi")}
              path="/v1/messages"
              models={null}
              badge="Anthropic"
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
          </div>
        </div>

        {/* Media & Multi-Modal */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <Icon name="perm_media" className="text-sm text-chart-3" />
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              {t("categoryMedia")}
            </h3>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <EndpointCard
              icon="data_array"
              iconColor="text-success"
              iconBg="bg-success/10"
              title={t("embeddings")}
              path="/v1/embeddings"
              models={endpointData.embeddings}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="image"
              iconColor="text-chart-3"
              iconBg="bg-chart-3/10"
              title={t("imageGeneration")}
              path="/v1/images/generations"
              models={endpointData.images}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="edit_square"
              iconColor="text-chart-3"
              iconBg="bg-chart-3/10"
              title={t("imageEdits")}
              path="/v1/images/edits"
              models={endpointData.images}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="mic"
              iconColor="text-error"
              iconBg="bg-error/10"
              title={t("audioTranscription")}
              path="/v1/audio/transcriptions"
              models={endpointData.audioTranscription}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="record_voice_over"
              iconColor="text-info"
              iconBg="bg-info/10"
              title={t("textToSpeech")}
              path="/v1/audio/speech"
              models={endpointData.audioSpeech}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="music_note"
              iconColor="text-chart-3"
              iconBg="bg-chart-3/10"
              title={t("musicGeneration")}
              path="/v1/music/generations"
              models={endpointData.music}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="videocam"
              iconColor="text-error"
              iconBg="bg-error/10"
              title={t("videoGeneration")}
              path="/v1/videos/generations"
              models={endpointData.video}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
          </div>
        </div>

        {/* Search & Discovery */}
        {searchProviders.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-3">
              <Icon name="travel_explore" className="text-sm text-info" />
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                {t("categorySearch")}
              </h3>
              <div className="flex-1 h-px bg-border/50" />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              <EndpointCard
                icon="search"
                iconColor="text-info"
                iconBg="bg-info/10"
                title={t("webSearch")}
                path="/v1/search"
                models={searchProviders.map((p) => ({ id: p.id, owned_by: p.id, type: "search" }))}
                copy={copy}
                copied={copied}
                baseUrl={currentEndpoint}
              />
            </div>
          </div>
        )}

        {/* Utility & Management */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Icon name="build" className="text-sm text-warning" />
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              {t("categoryUtility")}
            </h3>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <EndpointCard
              icon="sort"
              iconColor="text-warning"
              iconBg="bg-warning/10"
              title={t("rerank")}
              path="/v1/rerank"
              models={endpointData.rerank}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="shield"
              iconColor="text-warning"
              iconBg="bg-warning/10"
              title={t("moderations")}
              path="/v1/moderations"
              models={endpointData.moderation}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="view_list"
              iconColor="text-chart-4"
              iconBg="bg-chart-4/10"
              title={t("batchApi")}
              path="/v1/batches"
              models={null}
              badge="OpenAI"
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
            <EndpointCard
              icon="folder"
              iconColor="text-warning"
              iconBg="bg-warning/10"
              title={t("filesApi")}
              path="/v1/files"
              models={null}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
            <EndpointCard
              icon="list"
              iconColor="text-chart-4"
              iconBg="bg-chart-4/10"
              title={t("listModels")}
              path="/v1/models"
              models={allModels}
              modelsLoading={modelsLoading}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
          </div>
        </div>
      </Card>

      {/* Cloud Enable Modal */}
      <Modal
        isOpen={showCloudModal}
        title={t("enableCloudTitle")}
        onClose={() => setShowCloudModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-info-bg border border-info/30 rounded-lg p-4">
            <p className="text-sm text-info font-medium mb-2">{t("whatYouGet")}</p>
            <ul className="text-sm text-info space-y-1">
              <li>• {t("cloudBenefitAccess")}</li>
              <li>• {t("cloudBenefitShare")}</li>
              <li>• {t("cloudBenefitPorts")}</li>
              <li>• {t("cloudBenefitEdge")}</li>
            </ul>
          </div>

          <div className="bg-warning-bg border border-warning/30 rounded-lg p-4">
            <p className="text-sm text-warning font-medium mb-1">{tc("note")}</p>
            <ul className="text-sm text-warning space-y-1">
              <li>• {t("cloudSessionNote")}</li>
              <li>• {t("cloudUnstableNote")}</li>
            </ul>
          </div>

          <div className="rounded-lg border border-error/40 bg-error/10 p-4">
            <p className={cloudBaseUrl ? "text-sm break-all" : "text-sm"}>
              {cloudBaseUrl || tc("notConfigured")}
            </p>
            <p className="text-sm mt-2">
              {translateOrFallback(
                "cloudUploadWarning",
                "Cloud sync is disabled by default on new installations. Enabling it uploads provider API keys, OAuth access/refresh tokens, OmniRoute API keys, and configuration to the destination above, now and during future syncs. This is separate from local Storage backups. Only enable it if you trust that server."
              )}
            </p>
            <Checkbox
              className="mt-3 text-sm"
              checked={acknowledgeCloudUpload}
              onChange={(event) => setAcknowledgeCloudUpload(event.target.checked)}
              label={translateOrFallback(
                "cloudUploadConsent",
                "I understand and authorize uploading my credentials to this destination."
              )}
            />
          </div>

          {/* Sync Progress / Success */}
          {(cloudSyncing || modalSuccess) && (
            <div
              className={`flex items-center gap-3 p-3 rounded-lg border transition-all duration-300 ${
                modalSuccess ? "bg-success/10 border-success/30" : "bg-primary/10 border-primary/30"
              }`}
            >
              {modalSuccess ? (
                <Icon name="check_circle" className="text-success text-xl" />
              ) : (
                <Icon name="progress_activity" className="animate-spin text-primary" />
              )}
              <div className="flex-1">
                <p
                  className={`text-sm font-medium ${
                    modalSuccess ? "text-success" : "text-primary"
                  }`}
                >
                  {modalSuccess && t("cloudConnected")}
                  {!modalSuccess && syncStep === "syncing" && t("connectingToCloud")}
                  {!modalSuccess && syncStep === "verifying" && t("verifyingConnection")}
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleEnableCloud}
              fullWidth
              disabled={cloudSyncing || modalSuccess || !acknowledgeCloudUpload || !cloudConfigured}
            >
              {cloudSyncing ? (
                <span className="flex items-center gap-2">
                  <Icon name="progress_activity" className="animate-spin text-sm" />
                  {syncStep === "syncing" ? t("connecting") : t("verifying")}
                </span>
              ) : modalSuccess ? (
                <span className="flex items-center gap-2">
                  <Icon name="check" className="text-sm" />
                  {t("connected")}
                </span>
              ) : (
                t("enableCloud")
              )}
            </Button>
            <Button
              onClick={() => setShowCloudModal(false)}
              variant="ghost"
              fullWidth
              disabled={cloudSyncing || modalSuccess}
            >
              {tc("cancel")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloud Modal */}
      <Modal
        isOpen={showDisableModal}
        title={t("disableCloudTitle")}
        onClose={() => !cloudSyncing && setShowDisableModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-error-bg border border-error/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Icon name="warning" className="text-error" />
              <div>
                <p className="text-sm text-error font-medium mb-1">{tc("warning")}</p>
                <p className="text-sm text-error">{t("disableWarning")}</p>
              </div>
            </div>
          </div>

          {/* Sync Progress */}
          {cloudSyncing && (
            <div className="flex items-center gap-3 p-3 bg-primary/10 border border-primary/30 rounded-lg">
              <Icon name="progress_activity" className="animate-spin text-primary" />
              <div className="flex-1">
                <p className="text-sm font-medium text-primary">
                  {syncStep === "syncing" && t("syncingData")}
                  {syncStep === "disabling" && t("disablingCloud")}
                </p>
              </div>
            </div>
          )}

          <p className="text-sm text-text-muted">{t("disableConfirm")}</p>

          <div className="flex gap-2">
            <Button
              onClick={handleConfirmDisable}
              fullWidth
              disabled={cloudSyncing}
              variant="danger"
            >
              {cloudSyncing ? (
                <span className="flex items-center gap-2">
                  <Icon name="progress_activity" className="animate-spin text-sm" />
                  {syncStep === "syncing" ? t("syncing") : t("disabling")}
                </span>
              ) : (
                t("disableCloud")
              )}
            </Button>
            <Button
              onClick={() => setShowDisableModal(false)}
              variant="ghost"
              fullWidth
              disabled={cloudSyncing}
            >
              {tc("cancel")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Provider Models Popup */}
      {selectedProvider && (
        <ProviderModelsModal
          provider={selectedProvider}
          models={allModels}
          copy={copy}
          copied={copied}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </div>
  );
}

// -- Sub-component: Provider Models Modal ------------------------------------------

function ProviderModelsModal({
  provider,
  models,
  copy,
  copied,
  onClose,
}: Readonly<{
  provider: EndpointProviderSummary;
  models: EndpointModelSummary[];
  copy: CopyHandler;
  copied?: string | null;
  onClose: () => void;
}>) {
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  // Get provider alias for matching models
  // Filter out parent models (models with parent field set) to avoid showing duplicates
  const providerAlias = provider.provider.alias || provider.id;
  const providerModels = useMemo(() => {
    return models.filter(
      (m) => !m.parent && (m.owned_by === providerAlias || m.owned_by === provider.id)
    );
  }, [models, providerAlias, provider.id]);

  const chatModels = providerModels.filter((m) => !m.type);
  const embeddingModels = providerModels.filter((m) => m.type === "embedding");
  const imageModels = providerModels.filter((m) => m.type === "image");

  const renderModelGroup = (title, icon, groupModels) => {
    if (groupModels.length === 0) return null;
    return (
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Icon name={icon} className="text-sm" />
          {title} ({groupModels.length})
        </h4>
        <div className="flex flex-col gap-1">
          {groupModels.map((m) => {
            const copyKey = `modal-${m.id}`;
            return (
              <div
                key={m.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface/60 group"
              >
                <code className="text-sm font-mono flex-1 truncate">{m.id}</code>
                {m.custom && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {t("custom")}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => copy(m.id, copyKey)}
                  className="text-text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  title={tc("copy")}
                  aria-label={`${tc("copy")} ${m.id}`}
                  icon={copied === copyKey ? "check" : "content_copy"}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("providerModelsTitle", { provider: provider.provider.name })}
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {providerModels.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">{t("noModelsForProvider")}</p>
        ) : (
          <>
            {renderModelGroup(t("chat"), "chat", chatModels)}
            {renderModelGroup(t("embedding"), "data_array", embeddingModels)}
            {renderModelGroup(t("image"), "image", imageModels)}
          </>
        )}
      </div>
    </Modal>
  );
}

// -- Sub-component: Endpoint Section ------------------------------------------

function EndpointCard({
  icon,
  iconColor,
  iconBg,
  title,
  path,
  models,
  copy,
  copied,
  baseUrl,
  badge,
  modelsLoading = false,
}: Readonly<{
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  path: string;
  models: EndpointModelSummary[] | null;
  copy: CopyHandler;
  copied?: string | null;
  baseUrl: string;
  badge?: string;
  modelsLoading?: boolean;
}>) {
  const t = useTranslations("endpoint");
  const copyId = `endpoint_${path}`;
  const fullUrl = `${baseUrl.replace(/\/v1$/, "")}${path}`;

  return (
    <div className="border border-border rounded-lg p-3 hover:bg-surface/30 transition-colors flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <div className={`flex items-center justify-center size-8 rounded-lg ${iconBg} shrink-0`}>
          <Icon name={icon} size={16} className={iconColor} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-xs leading-tight">{title}</span>
            {badge && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-border/60 text-text-muted font-medium uppercase tracking-wider leading-none">
                {badge}
              </span>
            )}
          </div>
          <span className="text-xs text-text-muted mt-0.5 block">
            {models === null
              ? "—"
              : modelsLoading
                ? "..."
                : t("modelsCount", { count: models.length })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 text-[10px] font-mono text-text-muted bg-surface/80 px-2 py-1 rounded truncate">
          {path}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void copy(fullUrl, copyId)}
          className="shrink-0 text-text-muted"
          title={t("copyUrl")}
          aria-label={`${t("copyUrl")}: ${path}`}
          icon={copied === copyId ? "check" : "content_copy"}
        />
      </div>
    </div>
  );
}

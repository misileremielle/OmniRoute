import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CacheSettingsTab from "@/app/(dashboard)/dashboard/settings/components/CacheSettingsTab";
import en from "@/i18n/messages/en.json";
// The shared Select renders the kit (Radix) Select for `options` since KEA-7886: no DOM
// <select>/<option>; the helpers read the menu items (data-value) and the controlled value.
import { kitSelectOptions } from "../../helpers/kitSelect";

const model = {
  id: "openai/text-embedding-3-small",
  rawId: "text-embedding-3-small",
  name: "text-embedding-3-small",
  dimensions: 1536,
  maxTokens: 8191,
  supportedInputTypes: ["text", "image"],
};
const config = {
  modelCatalogCacheTtlMs: 1500,
  semanticCacheEnabled: true,
  semanticCacheVectorEnabled: false,
  semanticCacheEmbeddingProvider: "openai",
  semanticCacheEmbeddingModel: model.rawId,
  semanticCacheEmbeddingDimension: 1536,
  embeddingOptions: [{ id: "openai", name: "OpenAI", hasConnection: true, models: [model] }],
};
// Exercise the real catalog and formatter, not the global key-only test mock.
vi.unmock("next-intl");

const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const fetchMock = vi.fn<typeof fetch>();

function mount() {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ settings: en.settings, common: en.common }}
      onError={(error) => {
        throw error;
      }}
    >
      <CacheSettingsTab />
    </NextIntlClientProvider>
  );
}

async function loaded() {
  const view = mount();
  await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveProperty("disabled", false));
  return view;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(config));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cache settings with the real English catalog", () => {
  it("localizes headings, metadata, accessible controls, Redis and advanced overrides", async () => {
    await loaded();
    expect(screen.getByText("Semantic Caching")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable vector similarity layer" })).toHaveProperty(
      "ariaChecked",
      "false"
    );
    const providerOptions = kitSelectOptions(document.getElementById("sem-provider")!);
    expect(providerOptions.find((option) => option.label === "OpenAI (Configured)")?.value).toBe(
      "openai"
    );
    const modelOptions = kitSelectOptions(document.getElementById("sem-model")!);
    expect(
      modelOptions.find((option) => option.label === "text-embedding-3-small (1,536 dimensions)")
        ?.value
    ).toBe(model.rawId);
    expect(screen.getByText("Using configured connection (Default URL)")).toBeTruthy();
    expect(screen.getByText("Dimensions: 1,536")).toBeTruthy();
    expect(screen.getByText("Max tokens: 8,191")).toBeTruthy();
    expect(screen.getByText("Input: Text and Image")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Redis Vector Store" }));
    expect(screen.getByLabelText("Redis Key Prefix")).toHaveProperty(
      "value",
      "omniroute:semcache:"
    );
    expect(screen.getByLabelText("Redis URL")).toHaveProperty(
      "placeholder",
      "redis://127.0.0.1:6379"
    );
    fireEvent.click(screen.getByRole("button", { name: "Show Advanced Endpoint Overrides" }));
    expect(screen.getByLabelText("Custom Embedding API Key")).toHaveProperty(
      "placeholder",
      "Bearer token or API key"
    );
    expect(
      screen
        .getByRole("button", { name: "Hide Advanced Endpoint Overrides" })
        .getAttribute("aria-expanded")
    ).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Enable semantic caching" }));
    expect(screen.getByText("Disabled")).toBeTruthy();
  });

  it("renders translated TTL validation and saves the unchanged numeric API payload", async () => {
    await loaded();
    const ttl = screen.getByLabelText(en.settings.modelCatalogCacheTtlLabel);
    fireEvent.change(ttl, { target: { value: "" } });
    expect(screen.getByText("Required")).toBeTruthy();
    const save = screen.getByRole("button", { name: en.settings.modelCatalogCacheTtlSave });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(ttl, { target: { value: "50" } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(ttl, { target: { value: "5000" } });
    fetchMock.mockResolvedValueOnce(reply({ modelCatalogCacheTtlMs: 5000 }));
    fireEvent.click(save);
    await screen.findByText(en.settings.cacheConfigSaveSuccess);
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ modelCatalogCacheTtlMs: 5000 });
  });

  it("localizes saving feedback without translating provider/model/backend wire values", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: "Redis Vector Store" }));
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Semantic Cache" }));
    expect(screen.getByRole("button", { name: "Saving..." })).toHaveProperty("disabled", true);
    resolve(reply({ ok: true }));
    await screen.findByText("Semantic cache settings saved successfully.");
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body).toMatchObject({
      semanticCacheBackend: "redis",
      semanticCacheEmbeddingProvider: "openai",
      semanticCacheEmbeddingModel: model.rawId,
      semanticCacheEmbeddingDimension: 1536,
      semanticCacheVectorEnabled: false,
      semanticCacheRedisPrefix: "omniroute:semcache:",
      semanticCacheTTL: 1800000,
    });
    fetchMock.mockResolvedValueOnce(reply({}, 500));
    fireEvent.click(screen.getByRole("button", { name: "Save Semantic Cache" }));
    await screen.findByText("Failed to save semantic cache settings.");
  });

  it.each([undefined, "https://example.com/v1"])(
    "formats complete embedding success messages (endpoint %s)",
    async (url) => {
      await loaded();
      fetchMock.mockResolvedValueOnce(
        reply({ ok: true, dimensions: 1536, latencyMs: 25, resolvedBaseUrl: url })
      );
      fireEvent.click(screen.getByRole("button", { name: "Test Embedding Model" }));
      await screen.findByText("Connection Verified:");
      expect(
        screen.getByText(
          url
            ? "Successfully generated a 1,536-dimensional embedding in 25 ms via https://example.com/v1."
            : "Successfully generated a 1,536-dimensional embedding in 25 ms."
        )
      ).toBeTruthy();
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
        provider: "openai",
        model: model.rawId,
        dimensions: 1536,
      });
    }
  );

  it("localizes connection errors and missing diagnostics", async () => {
    await loaded();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Test Embedding Model" }));
    await screen.findByText("Could not test the embedding connection.");
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    fetchMock.mockResolvedValueOnce(reply({ ok: false }, 400));
    fireEvent.click(screen.getByRole("button", { name: "Test Embedding Model" }));
    await screen.findByText("Unknown error");
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: "upstream-diagnostic-code" }));
    fireEvent.click(screen.getByRole("button", { name: "Test Embedding Model" }));
    await screen.findByText("upstream-diagnostic-code");
  });

  it("localizes purge success and failure while retaining DELETE semantics", async () => {
    await loaded();
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    await screen.findByText("Semantic cache purged successfully.");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cache", { method: "DELETE" });
    fetchMock.mockResolvedValueOnce(reply({}, 500));
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    await screen.findByText("Failed to purge cache. HTTP 500");
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    await screen.findByText("Failed to purge cache.");
  });

  it("localizes initial load failure", async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 503));
    mount();
    await screen.findByText(en.settings.cacheConfigLoadFailed);
  });
});

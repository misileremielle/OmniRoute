// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/playground/types", () => ({ getModelPricing: () => null }));
vi.mock("@/lib/playground/streamMetrics", () => ({
  computeMetrics: () => ({
    ttftMs: 100,
    totalMs: 500,
    tokensIn: 10,
    tokensOut: 20,
    tps: 40,
    costUsd: 0.001,
  }),
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown-content">{children}</div>
  ),
}));
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: () => {},
    writable: true,
    configurable: true,
  });
}
function setInputValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const nativeSetter =
    el instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  nativeSetter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
const { DEFAULT_PARAMS } =
  await import("../../../src/app/(dashboard)/dashboard/playground/components/ParamSliders");
const { default: ChatTab } =
  await import("../../../src/app/(dashboard)/dashboard/playground/components/tabs/ChatTab");
function makeSearchProviderConfig() {
  return {
    endpoint: "search" as const,
    baseUrl: "http://localhost:20128",
    model: "exa-search/web",
    provider: "exa-search",
    systemPrompt: "",
    params: { ...DEFAULT_PARAMS },
  };
}
function makeImageProviderConfig() {
  return {
    endpoint: "images" as const,
    baseUrl: "http://localhost:20128",
    model: "image-provider/model-image",
    provider: "image-provider",
    systemPrompt: "",
    params: { ...DEFAULT_PARAMS },
  };
}
function makeWebFetchProviderConfig() {
  return {
    endpoint: "web.fetch" as const,
    baseUrl: "http://localhost:20128",
    model: "fetch-provider/model-fetch",
    provider: "fetch-provider",
    systemPrompt: "",
    params: { ...DEFAULT_PARAMS },
  };
}
const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];
function renderChatTab(
  config: React.ComponentProps<typeof ChatTab>["configState"]
): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<ChatTab configState={config} />);
  });
  containers.push({ root, el });
  return el;
}
async function sendText(el: HTMLDivElement, value: string): Promise<void> {
  const textarea = el.querySelector("textarea") as HTMLTextAreaElement;
  act(() => {
    setInputValue(textarea, value);
  });
  const sendBtn = Array.from(el.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Send")
  ) as HTMLButtonElement | undefined;
  await act(async () => {
    sendBtn?.click();
  });
}
async function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
describe("ChatTab — search-provider endpoint routing (#10592)", () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    for (const { root, el } of containers.splice(0)) {
      act(() => root.unmount());
      el.remove();
    }
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  it("routes to /api/v1/search (not /api/v1/chat/completions) when configState.endpoint is 'search'", async () => {
    let capturedUrl: string | null = null;
    let capturedBody: Record<string, unknown> | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ results: [{ title: "Synthetic result" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const el = renderChatTab(makeSearchProviderConfig());
    await sendText(el, "synthetic search query");
    await waitFor(() => capturedUrl !== null);
    expect(capturedUrl).toBe("/api/v1/search");
    expect(capturedBody).toEqual({ query: "synthetic search query", model: "exa-search/web" });
    expect(el.querySelector("img")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("keeps web.fetch request and response behavior", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("Synthetic article text", { status: 200 });
    });
    const el = renderChatTab(makeWebFetchProviderConfig());

    await sendText(el, "https://example.test/article");
    await waitFor(() => capturedBody !== null);

    expect(capturedBody).toEqual({ url: "https://example.test/article" });
    expect(el.textContent).toContain("Synthetic article text");
    expect(el.querySelector("img")).toBeNull();
    fetchSpy.mockRestore();
  });

  it.each([
    ["empty", { created: 1, data: [], note: "empty image response" }],
    ["invalid", { created: 1, data: [{ url: "javascript:alert(1)" }], note: "invalid image" }],
  ])("falls back to the JSON response for %s image data", async (_label, payload) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const el = renderChatTab(makeImageProviderConfig());

    await sendText(el, "Render a synthetic image");
    await waitFor(() => el.querySelector("[data-testid='markdown-content']") !== null);

    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("[data-testid='markdown-content']")?.textContent).toContain(
      JSON.stringify(payload.note)
    );
    fetchSpy.mockRestore();
  });
});

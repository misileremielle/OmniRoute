// @vitest-environment jsdom
//
// "Add System One Compatible" mode of the compatible-provider Add modal: the base URL
// starts at OpenRouter's System One API, chat-only options are hidden, and the node is
// created with type "systemone-compatible".
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { default: AddCompatibleProviderModal } =
  await import("../../../src/app/(dashboard)/dashboard/providers/components/AddCompatibleProviderModal");

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

type ModalProps = React.ComponentProps<typeof AddCompatibleProviderModal>;

function render(props: Partial<ModalProps>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const renderProps = (nextProps: Partial<ModalProps>) => {
    act(() => {
      root.render(
        <AddCompatibleProviderModal
          isOpen
          mode="openai"
          onClose={() => {}}
          onCreated={() => {}}
          {...nextProps}
        />
      );
    });
  };
  renderProps(props);
  containers.push({ root, el });
  // Queries go through document.body: the dialog is portaled there (KEA-7886).
  return { el: document.body, rerender: renderProps };
}

function inputByLabel(el: Element, label: string): HTMLInputElement {
  const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input"));
  const found = inputs.find((i) => {
    const labelEl = i.previousElementSibling || i.parentElement?.previousElementSibling;
    return labelEl?.textContent === label;
  });
  if (!found) throw new Error(`No input for label: ${label}`);
  return found;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ node: {} }) } as Response)
    )
  );
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

describe("AddCompatibleProviderModal — System One compatible", () => {
  it("starts on OpenRouter, hides chat-only options and creates a systemone node", async () => {
    const { el } = render({ mode: "systemone" });
    const modal = el.querySelector('[role="dialog"]')!;
    expect(modal.textContent).toContain("addSystemOneCompatible");
    expect(inputByLabel(modal, "baseUrlLabel").value).toBe("https://openrouter.ai/api");
    expect(modal.textContent).not.toContain("newApiAggregatorToggleLabel");
    expect(modal.textContent).not.toContain("advancedSettings");

    setInputValue(inputByLabel(modal, "nameLabel"), "OpenRouter System One");
    setInputValue(inputByLabel(modal, "prefixLabel"), "sys1");
    const addBtn = Array.from(modal.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "add"
    );
    act(() => addBtn!.click());
    await waitFor(() => (fetch as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toBe("/api/provider-nodes");
    const sent = JSON.parse(String(call[1].body));
    expect(sent.type).toBe("systemone-compatible");
    expect(sent.baseUrl).toBe("https://openrouter.ai/api");
    expect(sent.prefix).toBe("sys1");
    expect("apiType" in sent).toBe(false);
  });
});

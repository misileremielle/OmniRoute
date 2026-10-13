// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsAiPage from "@/app/(dashboard)/dashboard/settings/ai/page";
import ModalityBridgeMovedCard from "@/app/(dashboard)/dashboard/settings/components/ModalityBridgeMovedCard";

vi.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, {
      rich: (key: string) => key,
    }),
}));

vi.mock("@/shared/components", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/app/(dashboard)/dashboard/settings/components/ThinkingBudgetTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/SystemPromptTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/ResponsesStatePolicyTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/CodexFastTierTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/CodexAutoPingTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/ClaudeFastModeTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/MemorySkillsTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/ModelsDevSyncTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/UsageTokenBufferTab", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/settings/components/ModelCapabilityOverridesTab", () => ({
  default: () => null,
}));

const roots: Array<{ root: Root; el: HTMLDivElement }> = [];

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  roots.push({ root, el });
  return el;
}

describe("Modality Bridge relocation", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ connections: [] }), { status: 200 }))
    );
  });

  afterEach(() => {
    for (const { root, el } of roots.splice(0)) {
      act(() => root.unmount());
      el.remove();
    }
    vi.unstubAllGlobals();
  });

  it("renders the moved card as a link and removes the legacy settings card", async () => {
    const card = await render(<ModalityBridgeMovedCard />);
    expect(card.querySelector('a[href="/dashboard/settings/modality-bridge"]')).toBeTruthy();

    const page = await render(<SettingsAiPage />);
    expect(page.textContent).not.toContain("visionBridgeEnabledLabel");
    expect(page.textContent).toContain("modalityBridgeMovedTitle");
  });
});

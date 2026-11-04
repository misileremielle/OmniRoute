// @vitest-environment jsdom
/**
 * ProviderPageHeader — discreet "Partner link" indicator on the top-of-page
 * website link, shown only when the website is a Radar default referral
 * (`isReferralLink`). Plain catalog websites are never flagged.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import ProviderPageHeader from "@/app/(dashboard)/dashboard/providers/[id]/components/ProviderPageHeader";

// No `.has` method — providerText() falls back to the hardcoded English
// default.
const t = (key: string) => key;

describe("ProviderPageHeader — partner-link note", () => {
  let container: HTMLDivElement | null = null;
  const mounted: { root: Root; container: HTMLDivElement }[] = [];

  afterEach(async () => {
    for (const instance of mounted.splice(0)) {
      await act(async () => instance.root.unmount());
      instance.container.remove();
    }
    if (container) {
      container = null;
    }
  });

  function renderHeader(id: string, name: string, website: string, isReferralLink = false) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <ProviderPageHeader
          providerId={id}
          providerInfo={{ id, name, website, color: "#1783FF" }}
          connectionsCount={0}
          isOpenAICompatible={false}
          isAnthropicProtocolCompatible={false}
          onOpenTutorial={() => {}}
          t={t}
          isReferralLink={isReferralLink}
        />
      );
    });
    return container;
  }

  it("flags a Radar referral header link as a partner link", () => {
    const [id, name, website] = ["example", "Example", "https://example.com/?ref=omniroute"];
    const el = renderHeader(id, name, website, true);
    // The component also renders a "Back to Providers" <Link> above the
    // website title link — target the website anchor specifically, not the
    // first <a> in the tree.
    const link = el.querySelector(`a[href="${website}"]`);
    expect(link).not.toBeNull();
    expect(link?.getAttribute("title")).toBe(
      "Partner link — supports OmniRoute at no extra cost to you"
    );
    expect(link?.getAttribute("aria-label")).toBe(
      `${name} — Partner link — supports OmniRoute at no extra cost to you`
    );
    expect(el.textContent).toContain("Partner link — supports OmniRoute at no extra cost to you");
  });

  it.each([
    ["openai", "OpenAI", "https://openai.com"],
    ["moonshot", "Kimi", "https://platform.kimi.ai"],
    ["kimi-coding", "Kimi Code CLI", "https://www.kimi.ai/code"],
  ])("does NOT flag the plain %s website link as a partner link", (id, name, website) => {
    const el = renderHeader(id, name, website);
    const link = el.querySelector(`a[href="${website}"]`);
    expect(link).not.toBeNull();
    expect(link?.getAttribute("title")).toBeNull();
    expect(link?.getAttribute("aria-label")).toBeNull();
    expect(el.textContent).not.toContain("Partner link");
  });
});

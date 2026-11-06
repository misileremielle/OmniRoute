// @vitest-environment jsdom
/**
 * #19066 block 4: hand-made tiles and `<details>`/disclosure buttons moved to the kit `Tile` and
 * `Disclosure`. These tests pin the semantics each conversion had to keep.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

import SearchHistory from "@/app/(dashboard)/dashboard/search-tools/components/SearchHistory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchHistory entries on the kit Tile", () => {
  it("names each entry by its query, describes it with provider and age, and replays on click", async () => {
    const entry = {
      query: "kit tiles",
      provider: "brave",
      timestamp: new Date().toISOString(),
      filters: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ recent_searches: [entry] }) }))
    );
    const onReplay = vi.fn();
    await act(async () => {
      render(<SearchHistory onReplay={onReplay} />);
    });
    const tile = await screen.findByRole("button", { name: "kit tiles" });
    expect(tile).toHaveClass("ci-tile");
    expect(tile).not.toHaveAttribute("aria-pressed");
    expect(tile.getAttribute("aria-describedby")).toBeTruthy();
    expect(tile.querySelector(".ci-tile__description")?.textContent).toContain("brave");
    fireEvent.click(tile);
    expect(onReplay).toHaveBeenCalledWith(entry);
  });
});

describe("converted files use the kit components (source guard)", () => {
  const root = path.resolve(__dirname, "../../..");
  const dash = "src/app/(dashboard)/dashboard";
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  it.each([
    `${dash}/cli-code/components/CopilotToolCard.tsx`,
    `${dash}/search-tools/components/SearchToolsConfigPane.tsx`,
    `${dash}/search-tools/components/SearchForm.tsx`,
    `${dash}/search-tools/components/SearchConceptCard.tsx`,
    `${dash}/combos/AutoComboCatalog.tsx`,
  ])("%s has no <details>/hand-rolled disclosure left", (file) => {
    const src = read(file);
    expect(src).toContain('from "@omniroute/ui-kit/disclosure"');
    expect(src).not.toMatch(/<details\b|<summary\b/);
    expect(src).not.toMatch(/aria-expanded=/);
  });

  it.each([
    `${dash}/settings/components/CompressionSettingsTab.tsx`,
    `${dash}/runtime/RuntimePageClient.tsx`,
    `${dash}/combos/page.tsx`,
    `${dash}/search-tools/components/SearchHistory.tsx`,
  ])("%s renders its tiles with the kit Tile", (file) => {
    expect(read(file)).toContain('import { Tile } from "@omniroute/ui-kit/tile"');
  });
});

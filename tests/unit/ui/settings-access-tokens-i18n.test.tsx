import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AccessTokensTab from "@/app/(dashboard)/dashboard/settings/components/AccessTokensTab";
import en from "@/i18n/messages/en.json";
// The shared Select renders the kit (Radix) Select for `options` since KEA-7886: no DOM
// <select>/<option>; the helpers read the menu items (data-value) and the controlled value.
import { chooseKitSelectValue } from "../../helpers/kitSelect";

const token = {
  id: "demo/read",
  name: "Laptop",
  scope: "read",
  tokenPrefix: "omni_demo",
  createdAt: "2026-01-02T03:04:00Z",
  lastUsedAt: "2026-01-03T04:05:00Z",
  expiresAt: "2027-01-02T03:04:00Z",
  revokedAt: null,
};
// Exercise the real catalog and formatter, not the global key-only test mock.
vi.unmock("next-intl");
// The fork ships English only, so the runtime catalog is en.json itself.
const messages = en;

// The kit Table measures itself with ResizeObserver (persistent scrollbar); jsdom lacks it.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const fetchMock = vi.fn<typeof fetch>();
function mount() {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ settings: messages.settings, common: messages.common }}
      onError={(error) => {
        throw error;
      }}
    >
      <AccessTokensTab />
    </NextIntlClientProvider>
  );
}
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply({ tokens: [token] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("access-token settings with the real English catalog", () => {
  it("translates the table, scope badges and status, and formats dates in the UI locale", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        tokens: [
          token,
          { ...token, id: "write", name: "Writer", scope: "write" },
          {
            ...token,
            id: "admin",
            name: "Admin machine",
            scope: "admin",
            revokedAt: "2026-01-04T00:00:00Z",
            lastUsedAt: null,
            expiresAt: null,
          },
        ],
      })
    );
    mount();
    const table = await screen.findByRole("table");
    expect(screen.getByRole("heading", { name: "Access Tokens" })).toBeTruthy();
    for (const label of ["Scope", "Last used", "Expires", "Read", "Write", "Admin", "revoked"])
      expect(within(table).getByText(label)).toBeTruthy();
    const expected = new Intl.DateTimeFormat("en", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(token.lastUsedAt));
    expect(within(table).getAllByText(expected)).toHaveLength(2);
    expect(within(table).getAllByText("—")).toHaveLength(2);
    expect(within(table).queryByText("read")).toBeNull();
  });

  it("keeps malformed dates from breaking the translated token table", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ tokens: [{ ...token, lastUsedAt: "not-a-date", expiresAt: "invalid" }] })
    );
    mount();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Laptop")).toBeTruthy();
    expect(within(table).getAllByText("—")).toHaveLength(2);
  });

  it("creates, copies and dismisses a token without translating its secret or scope payload", async () => {
    mount();
    await screen.findByRole("table");
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    fireEvent.change(screen.getByPlaceholderText("Name (e.g. laptop)"), {
      target: { value: "  Remote laptop  " },
    });
    chooseKitSelectValue(screen.getByRole("combobox"), "admin");
    fireEvent.change(screen.getByPlaceholderText("Expires (days, optional)"), {
      target: { value: "7" },
    });
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("button", { name: "Creating…" })).toHaveProperty("disabled", true);
    const call = fetchMock.mock.calls.at(-1);
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: "Remote laptop",
      scope: "admin",
      expiresInDays: 7,
    });
    resolve(reply({ token: "omni_disposable_test_secret" }));
    await screen.findByText("Copy this token now — it will not be shown again:");
    expect(screen.getByText("omni_disposable_test_secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(copy).toHaveBeenCalledWith("omni_disposable_test_secret");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("omni_disposable_test_secret")).toBeNull();
    // The opener ("Create") is disabled again after the name is cleared, so focus goes back
    // to the name field rather than falling to <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByPlaceholderText("Name (e.g. laptop)"))
    );
  });

  it("shows the new token's scope as code-preview metadata, not as its language (#18073)", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.change(screen.getByPlaceholderText("Name (e.g. laptop)"), {
      target: { value: "Remote laptop" },
    });
    chooseKitSelectValue(screen.getByRole("combobox"), "admin");
    fetchMock.mockResolvedValueOnce(reply({ token: "omni_disposable_test_secret" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const secret = await screen.findByText("omni_disposable_test_secret");
    const preview = secret.closest<HTMLElement>("[data-slot='code-preview']");
    expect(preview).toBeTruthy();
    const meta = preview!.querySelector(".ci-code-preview__meta");
    expect(meta?.querySelector("strong")?.textContent).toBe("Remote laptop");
    // The scope badge text sits in the metadata slot; the language slot stays empty.
    expect(meta?.querySelector(".ci-code-preview__endpoint")?.textContent).toBe("Admin");
    expect(meta?.querySelector("strong + span")?.textContent).toBe("");
    // The code region is named by the token, not "<scope> code".
    expect(within(preview!).getByLabelText("Remote laptop").tagName).toBe("PRE");
  });

  it("uses a localized create failure instead of surfacing English transport errors", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.change(screen.getByPlaceholderText("Name (e.g. laptop)"), {
      target: { value: "demo" },
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Could not create token.");
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });

  it.each([
    [
      { error: { message: "expiresInDays must not exceed 3650" } },
      "expiresInDays must not exceed 3650",
    ],
    [{ error: "Permission denied by policy" }, "Permission denied by policy"],
    [{ error: {} }, "HTTP 400"],
  ])(
    "retains server diagnostics with a localized create error prefix (%j)",
    async (body, detail) => {
      mount();
      await screen.findByRole("table");
      fireEvent.change(screen.getByPlaceholderText("Name (e.g. laptop)"), {
        target: { value: "demo" },
      });
      fetchMock.mockResolvedValueOnce(reply(body, 400));
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await screen.findByText(`Could not create token. ${detail}`);
    }
  );

  it("localizes revoke confirmation, cancel and errors, retaining the encoded token id", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    let dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Revoke access token")).toBeTruthy();
    expect(within(dialog).getByText(en.settings.accessTokensRevokeConfirm)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: en.common.cancel }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    dialog = screen.getByRole("alertdialog");
    fetchMock.mockResolvedValueOnce(reply({}, 500));
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await screen.findByText("Could not revoke token.");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cli/tokens/demo%2Fread", { method: "DELETE" });
  });

  it("reloads the localized status after successful revocation", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fetchMock.mockResolvedValueOnce(
      reply({ tokens: [{ ...token, revokedAt: "2026-01-04T00:00:00Z" }] })
    );
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revoke" })
    );
    await screen.findByText("revoked");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull());
  });

  it("translates empty and failed-load states", async () => {
    fetchMock.mockResolvedValueOnce(reply({ tokens: [] }));
    const view = mount();
    await screen.findByText("No access tokens yet.");
    view.unmount();
    fetchMock.mockResolvedValueOnce(reply({}, 503));
    mount();
    await screen.findByText("Could not load access tokens.");
  });
});

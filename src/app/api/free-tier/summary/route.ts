import { computeFreeModelTotals } from "@omniroute/open-sse/config/freeModelCatalog.ts";
import { FREE_CATALOG_CURATED_AT } from "@omniroute/open-sse/config/freeModelCatalog.data.ts";
import { sumUsageTokensThisMonth } from "@/lib/db/usageSummary";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { listNoCredentialProviders } from "@/shared/utils/providerCredentialRequirement";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const excludeTosAvoid = url.searchParams.get("excludeTosAvoid") === "1";

  // #13679: gates the operator-specific usage fields — this endpoint ships an unconditional wildcard CORS header
  // (the community free-tier catalog is intentionally public), so anything
  // that is NOT meant to be world-readable must be withheld here rather than
  // relying on Origin checks the browser CORS model doesn't actually enforce
  // for a same-origin-looking (DNS-rebinding) caller.
  const authed = await isAuthenticated(req);
  const totals = computeFreeModelTotals({ excludeTosAvoid });

  // #13679: usedThisMonth/remaining reveal the operator's own local usage —
  // unlike the catalog totals, that is not meant to be public. Withhold both
  // from unauthenticated callers instead of gating the whole route, so the
  // intentionally-public catalog fields stay served to everyone.
  const usedThisMonth = authed ? sumUsageTokensThisMonth() : null;
  const body = {
    ...totals,
    usedThisMonth,
    remaining: authed ? Math.max(0, totals.steadyRecurringTokens - usedThisMonth!) : null,
    catalogUpdatedAt: FREE_CATALOG_CURATED_AT,
    // Computed here, not in the component: deriving it client-side would pull
    // the whole provider REGISTRY into the browser bundle.
    noCredentialProviders: listNoCredentialProviders(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

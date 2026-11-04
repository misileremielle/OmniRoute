import {
  finalizePendingRequest,
  finalizePendingRequestById,
  updatePendingRequest,
  updatePendingRequestById,
  type PendingRequestIdentity,
  type PendingRequestMetadata,
  type PendingRequestOwner,
} from "./usageHistory";

export type PendingRequestScope = {
  id: string | null | undefined;
  owner?: PendingRequestOwner;
  model: string;
  provider: string;
  connectionId: string | null;
};

export function initialPendingBody(body: unknown, effectiveModel: string): unknown {
  return body && typeof body === "object" && !Array.isArray(body)
    ? {
        ...(body as Record<string, unknown>),
        model:
          typeof (body as Record<string, unknown>).model === "string"
            ? (body as Record<string, unknown>).model
            : effectiveModel,
      }
    : body;
}

/**
 * The exact attempt this scope owns: the captured owner first, then its ID. A scope with an
 * identity never falls back to the most-recent lookup, so a late completion cannot finalize
 * another request (#17891).
 */
function pendingScopeIdentity(scope: PendingRequestScope): PendingRequestIdentity | null {
  return scope.owner ?? (scope.id || null);
}

export function updatePendingScope(scope: PendingRequestScope, metadata: PendingRequestMetadata) {
  const identity = pendingScopeIdentity(scope);
  if (identity) {
    updatePendingRequestById(identity, metadata);
  } else {
    updatePendingRequest(scope.model, scope.provider, scope.connectionId, metadata);
  }
}

export function finalizePendingScope(scope: PendingRequestScope, metadata: PendingRequestMetadata) {
  const identity = pendingScopeIdentity(scope);
  if (identity) {
    finalizePendingRequestById(identity, metadata);
  } else {
    finalizePendingRequest(scope.model, scope.provider, scope.connectionId, metadata);
  }
}

/**
 * Boundary projection for server-owned tool results: failure-shaped output and nested
 * error/warning subtrees are sanitized before they reach a client or the model.
 */
import {
  sanitizeErrorMessage,
  sanitizeUpstreamDetails,
} from "@omniroute/open-sse/utils/errorSanitization.ts";

const TOOL_FAILURE_DISCRIMINATORS = new Set(["error", "failed", "failure"]);

function isToolErrorKey(key: string): boolean {
  const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
  return (
    normalizedKey === "error" ||
    normalizedKey === "errors" ||
    normalizedKey === "warning" ||
    normalizedKey === "warnings"
  );
}

function isFailureDiscriminator(value: unknown): boolean {
  return typeof value === "string" && TOOL_FAILURE_DISCRIMINATORS.has(value.trim().toLowerCase());
}

function isToolFailureOutput(output: Record<string, unknown>): boolean {
  try {
    const status = output.status;
    return (
      output.success === false ||
      (typeof status === "number" && Number.isFinite(status) && status >= 400) ||
      isFailureDiscriminator(status) ||
      isFailureDiscriminator(output.type) ||
      isFailureDiscriminator(output.event) ||
      isFailureDiscriminator(output.kind)
    );
  } catch {
    return true;
  }
}

type SensitiveToolReferences = {
  objects: WeakSet<object>;
  strings: Set<string>;
};

function markSensitiveToolReference(value: unknown, sensitive: SensitiveToolReferences): void {
  if (typeof value === "string") {
    sensitive.strings.add(value);
    return;
  }
  if (!value || typeof value !== "object" || sensitive.objects.has(value)) return;

  sensitive.objects.add(value);
  try {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      markSensitiveToolReference(entry, sensitive);
    }
  } catch {
    // A revoked proxy or throwing getter is unsafe to expose at the boundary.
  }
}

function collectSensitiveToolReferences(
  value: unknown,
  sensitive: SensitiveToolReferences,
  visited: WeakSet<object>
): void {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);

  try {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isToolErrorKey(key)) {
        markSensitiveToolReference(entry, sensitive);
      } else {
        collectSensitiveToolReferences(entry, sensitive, visited);
      }
    }
  } catch {
    markSensitiveToolReference(value, sensitive);
  }
}

type ToolProjectionContext = {
  active: WeakSet<object>;
  projected: WeakMap<object, unknown>;
  sensitive: SensitiveToolReferences;
};

function projectNestedToolErrorSubtrees(value: unknown, context: ToolProjectionContext): unknown {
  if (typeof value === "string") {
    return context.sensitive.strings.has(value) ? sanitizeErrorMessage(value) : value;
  }
  if (!value || typeof value !== "object") return value;
  if (context.active.has(value)) return "[circular]";
  if (context.projected.has(value)) return context.projected.get(value);

  if (context.sensitive.objects.has(value)) {
    const safeValue = sanitizeUpstreamDetails(value);
    context.projected.set(value, safeValue);
    return safeValue;
  }

  context.active.add(value);
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    context.projected.set(value, projected);
    for (const entry of value) projected.push(projectNestedToolErrorSubtrees(entry, context));
    context.active.delete(value);
    return projected;
  }

  const projected: Record<string, unknown> = {};
  context.projected.set(value, projected);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[key] = isToolErrorKey(key)
      ? sanitizeUpstreamDetails(entry)
      : projectNestedToolErrorSubtrees(entry, context);
  }
  context.active.delete(value);
  return projected;
}

export function projectToolOutputForBoundary(
  output: Record<string, unknown>
): Record<string, unknown> {
  try {
    if (isToolFailureOutput(output)) {
      const projected = sanitizeUpstreamDetails(output);
      return projected && typeof projected === "object" && !Array.isArray(projected)
        ? (projected as Record<string, unknown>)
        : { success: false, error: "Tool execution failed" };
    }

    const sensitive: SensitiveToolReferences = {
      objects: new WeakSet<object>(),
      strings: new Set<string>(),
    };
    collectSensitiveToolReferences(output, sensitive, new WeakSet<object>());
    return projectNestedToolErrorSubtrees(output, {
      active: new WeakSet<object>(),
      projected: new WeakMap<object, unknown>(),
      sensitive,
    }) as Record<string, unknown>;
  } catch {
    return { success: false, error: "Tool execution failed" };
  }
}

import type { AutoVariant } from "./autoPrefix";
import {
  selectVirtualAutoCandidatePool,
  type AutoComboSpec,
  type PreparedVirtualAutoComboInputs,
} from "./virtualFactory";
import type { StrictZeroCostExclusionReason } from "./strictZeroCostFilter";

export interface VirtualAutoCandidateProjection {
  providerId: string;
  connectionId: string | null;
  allowedConnectionIds?: string[];
  model: string;
  freeAccessExclusion?: StrictZeroCostExclusionReason | null;
}

/** Selection-only materialization: no scoring, advertised limits, or response metadata. */
export async function projectVirtualAutoCandidatesFromPrepared(
  prepared: PreparedVirtualAutoComboInputs,
  _variant: AutoVariant | undefined,
  spec?: AutoComboSpec
): Promise<VirtualAutoCandidateProjection[]> {
  const { effectivePool } = await selectVirtualAutoCandidatePool(prepared, spec);
  const projected = effectivePool.map((candidate) => ({
    providerId: candidate.provider,
    connectionId: candidate.connectionId,
    ...(candidate.allowedConnectionIds
      ? { allowedConnectionIds: [...candidate.allowedConnectionIds] }
      : {}),
    model: candidate.modelStr,
    ...(candidate.freeAccessExclusion === undefined
      ? {}
      : { freeAccessExclusion: candidate.freeAccessExclusion }),
  }));
  return projected;
}

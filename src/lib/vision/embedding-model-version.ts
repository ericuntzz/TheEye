export const REAL_EMBEDDING_MODEL_VERSION = "mobileclip-s0-v1";
export const PLACEHOLDER_EMBEDDING_MODEL_VERSION = "mobileclip-s0-placeholder-v1";

export function isPlaceholderModelVersion(
  version: string | null | undefined,
): boolean {
  return version === PLACEHOLDER_EMBEDDING_MODEL_VERSION;
}

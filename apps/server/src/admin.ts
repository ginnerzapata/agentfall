const encoder = new TextEncoder();

/**
 * Compares a supplied admin bearer token without exposing its length or prefix
 * through an early string comparison. Missing configuration fails closed.
 */
export async function adminAuthorized(
  authorization: string | undefined,
  configuredToken: string | undefined,
): Promise<boolean> {
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!supplied || !configuredToken) return false;
  const [providedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
  ]);
  const timingSafeEqual = (
    crypto.subtle as SubtleCrypto & {
      timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
    }
  ).timingSafeEqual;
  return timingSafeEqual
    ? timingSafeEqual(providedDigest, configuredDigest)
    : constantTimeEqual(providedDigest, configuredDigest);
}

/** Bun does not currently expose the Workers timingSafeEqual extension in tests. */
function constantTimeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1)
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

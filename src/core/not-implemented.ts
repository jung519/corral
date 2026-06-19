/** Marks a method whose real implementation is lifted from upstream in S2. */
export function notImplemented(what: string): never {
  throw new Error(`${what}: not implemented in the S1 skeleton (lifted in S2)`);
}

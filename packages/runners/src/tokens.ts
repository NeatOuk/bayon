/** §5.1 fallback for runners that cannot count tokens: ~4 characters a token, plus a 15 % margin. */
export function approximateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.15);
}

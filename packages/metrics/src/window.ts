// A rolling window of samples (step times for a HUD) and its quantiles.

/** Rolling window of the last `size` samples. */
export class Window {
  private xs: number[] = [];
  constructor(private readonly size = 120) {}
  push(x: number) {
    this.xs.push(x);
    if (this.xs.length > this.size) this.xs.shift();
  }
  quantile(q: number): number {
    if (!this.xs.length) return NaN;
    const s = [...this.xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  }
}

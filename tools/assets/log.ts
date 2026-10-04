// Console output for the asset build: one line per step while it runs, a byte
// table at the end, and a machine-readable mode for scripts.

export interface Logger {
  readonly quiet: boolean;
  readonly verbose: boolean;
  /** Headline for a step; returns a done() that prints the timing and summary. */
  step(name: string): (summary: string) => void;
  note(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  table(rows: [string, string][]): void;
  blank(): void;
  readonly warnings: string[];
  readonly errors: string[];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function createLogger(opts: { quiet?: boolean; json?: boolean; verbose?: boolean }): Logger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const silent = opts.quiet === true || opts.json === true;
  const write = (line: string): void => {
    if (!silent) console.log(line);
  };
  return {
    quiet: silent,
    verbose: opts.verbose === true,
    warnings,
    errors,
    step(name) {
      const started = Date.now();
      return (summary: string) => {
        write(`  ${name.padEnd(10)} ${summary.padEnd(58)} ${formatMs(Date.now() - started).padStart(8)}`);
      };
    },
    note(message) {
      write(`             ${message}`);
    },
    warn(message) {
      warnings.push(message);
      write(`  warning    ${message}`);
    },
    error(message) {
      errors.push(message);
      write(`  ERROR      ${message}`);
    },
    table(rows) {
      const w = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
      for (const [k, v] of rows) write(`  ${k.padEnd(w)}  ${v}`);
    },
    blank() {
      write("");
    },
  };
}

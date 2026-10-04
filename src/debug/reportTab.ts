/// <reference types="vite/client" />
// Asset viewer, report tab: what the last build produced and whether every
// check passed. This is the page to look at before calling the assets done.

import type { ObjectsFile } from "../assets/objectTypes";
import type { Manifest } from "../assets/manifestTypes";
import { fetchAsset } from "../assets/paths";
import type { TabView } from "./tabs";

/** Mirrors ObjectsReport in tools/assets/objects.ts; read from data/, not from assets/. */
interface ObjectsReportView {
  generated: string;
  totals: { ids: number; census: number; withFrame: number; withGlow: number; withChildren: number; children: number; withAnim: number };
  provenance: { hitbox: Record<string, number>; art: Record<string, number> };
  dropped: { glow: number; child: number; anim: number; editorOnly: number; glowNames: string[]; animNames: string[] };
  missing: { census: { id: number; frame: string; uses: number }[]; other: { id: number; frame: string }[] };
  perLevel: Record<string, { ids: number; resolved: number; missing: number[] }>;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function badge(ok: boolean, label: string): string {
  return `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${escape(label)}</span>`;
}

export class ReportTab implements TabView {
  readonly id = "report";
  private manifest: Manifest | null = null;
  private objects: ObjectsReportView | null = null;
  private census = 0;

  constructor(
    private readonly panel: HTMLElement,
    private readonly setMessage: (text: string) => void,
  ) {}

  async activate(): Promise<void> {
    try {
      this.manifest = await fetchAsset<Manifest>("manifest.json");
      const objects = await fetchAsset<ObjectsFile>("objects.json");
      this.census = objects.census.length;
    } catch (err) {
      this.setMessage(err instanceof Error ? err.message : String(err));
    }
    // The per-object report is a build artefact rather than something the game
    // ships, so it is only there while the dev server is serving the source
    // tree; the page shows the manifest alone without it.
    if (import.meta.env.DEV) {
      try {
        const res = await fetch("/data/objects-report.json");
        if (res.ok) this.objects = (await res.json()) as ObjectsReportView;
      } catch {
        this.objects = null;
      }
    }
    this.panel.innerHTML = this.html();
  }

  private html(): string {
    const m = this.manifest;
    if (!m) return `<p>No manifest yet. Run the asset build.</p>`;
    const checks = m.checks;
    const levels = Object.entries(this.objects?.perLevel ?? {});
    const levelGaps = levels.filter(([, v]) => v.missing.length > 0);
    const rows = Object.entries(m.categories)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([name, c]) => {
        const share = Math.round((c.bytes / Math.max(1, m.totals.bytes)) * 100);
        return `<tr><td>${escape(name)}</td><td class="n">${c.files}</td><td class="n">${bytes(c.bytes)}</td>
          <td class="bar"><span style="width:${share}%"></span></td></tr>`;
      })
      .join("");

    return `
      <h2>Asset build</h2>
      <p class="muted">${escape(new Date(m.generated).toLocaleString())} · source ${escape(m.source.root)}</p>
      <p>
        ${badge(checks.missingFrames === 0, `${checks.missingFrames} missing frames`)}
        ${badge(checks.censusIds > 0 && this.census === checks.censusIds, `${checks.censusIds} object ids used by the levels`)}
        ${badge(levelGaps.length === 0, `${levels.length - levelGaps.length} of ${levels.length} levels fully covered`)}
        ${badge(m.totals.bytes < m.totals.warnBytes, `${bytes(m.totals.bytes)} shipped, ${bytes(m.totals.headroomBytes)} spare`)}
      </p>
      <table>
        <thead><tr><th>category</th><th class="n">files</th><th class="n">size</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h3>What is in it</h3>
      <ul>
        <li>${checks.framesIndexed.toLocaleString()} sprite frames indexed at ${escape(m.res.preferred)}, sheets at ${escape(m.res.atlas.join(" and "))}</li>
        <li>${checks.objects.toLocaleString()} objects, ${this.objects?.totals.withFrame.toLocaleString() ?? "?"} with art and ${this.objects?.totals.children.toLocaleString() ?? "?"} child sprites</li>
        <li>${Object.values(m.have.icons).reduce((n, l) => n + l.length, 0).toLocaleString()} icons, ${m.have.particles.length} particle effects, ${m.have.animEntities.length} skeletons, ${m.have.fonts.length} fonts</li>
        <li>${m.have.levels.length} levels, ${m.have.backgrounds.length} backgrounds, ${m.have.grounds.length} grounds, ${m.have.foregrounds.length} foregrounds</li>
        <li>${m.have.audio.music.length} music tracks, ${m.have.audio.sfx.length} sound effects${m.have.audio.music.length === 0 ? " <span class=\"muted\">(audio is not shipped yet)</span>" : ""}</li>
      </ul>
      <h3>Dropped on purpose</h3>
      <p class="muted">The old reference table invented art the game does not have. Anything no sheet contains is left out and counted here.</p>
      <ul>
        <li>${(this.objects?.dropped.glow ?? 0).toLocaleString()} glow frames that exist nowhere</li>
        <li>${this.objects?.dropped.anim ?? 0} animation frames, ${this.objects?.dropped.child ?? 0} child frames</li>
        <li>${this.objects?.dropped.editorOnly ?? 0} editor-only icons, whose sheet this build leaves out</li>
      </ul>
      ${
        (this.objects?.missing.other.length ?? 0) > 0
          ? `<h3>Gaps outside the official levels</h3><p>${this.objects?.missing.other
              .slice(0, 40)
              .map((x) => `${x.id}: ${escape(x.frame)}`)
              .join("<br>")}</p>`
          : ""
      }
    `;
  }

  draw(): void {
    // The report is DOM, not canvas.
  }

  hud(): string {
    return "";
  }
}

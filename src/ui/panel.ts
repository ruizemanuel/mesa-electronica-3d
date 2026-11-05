import type { Bench } from "../sim/bench";
import { CIRCUITS } from "../sim/circuits";
import { DIAL_LABEL, DIAL_POSITIONS, type Dial, type Jack } from "../sim/dmm";
import { colorBands, eSeriesValues, formatSI, type PowerRating, type ResistorSpec } from "../sim/resistor";
import { VIEWS } from "../scene/world";

export interface PanelActions {
  loadCircuit(id: string): void;
  view(name: string): void;
  toggleJumper(id: string): void;
  setResistor(id: string, spec: ResistorSpec): void;
  replaceResistor(id: string): void;
  dmmButton(b: "RANGE" | "HOLD" | "REL"): void;
  setDial(d: Dial): void;
  setJack(j: Jack): void;
  setPsu(v: number | null, i: number | null): void;
  toggleOutput(): void;
  replaceFuse(which: "mA" | "A"): void;
  stowProbes(): void;
  pickProbe(c: "red" | "black"): void;
  toggleMute(): boolean;
}

interface Note {
  n: number;
  qty: string;
  text: string;
  value: number | null;
  baseUnit: string;
  red: string;
  black: string;
}

const QTY: Record<Dial, string> = {
  OFF: "—",
  VAC: "Tensión AC",
  VDC: "Tensión DC",
  mVDC: "Tensión DC",
  OHM: "Resistencia",
  CONT: "Continuidad",
  mA: "Corriente DC",
  A: "Corriente DC",
};
const JACK_LABEL: Record<Jack, string> = { VOhm: "VΩ", mA: "mA", A: "10A" };
const POWERS: PowerRating[] = [0.25, 0.5, 1, 2];
const POWER_LABEL: Record<number, string> = { 0.25: "¼ W", 0.5: "½ W", 1: "1 W", 2: "2 W" };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html) el.innerHTML = html;
  return el;
};

export class Panel {
  readonly root: HTMLElement;
  private notes: Note[] = [];
  private noteSeq = 1;
  private showTheory = false;
  private showTruth = false;
  private els: Record<string, HTMLElement> = {};
  private selectedResistor: string | null = null;

  constructor(
    private readonly bench: Bench,
    private readonly act: PanelActions,
  ) {
    this.root = document.getElementById("panel")!;
    this.render();
  }

  /** Re-renderiza la estructura (al cambiar de circuito). */
  render(): void {
    const b = this.bench;
    const c = b.circuit;
    this.root.innerHTML = `
      <header class="brand">
        <div>
          <h1>Mesa de electrónica</h1>
          <p>Assets 3D: <a href="https://huggingface.co/datasets/nvidia/simready-assets" target="_blank" rel="noopener">NVIDIA SimReady</a> (CC-BY-4.0) · <a href="https://github.com/ruizemanuel/mesa-electronica-3d" target="_blank" rel="noopener">código en GitHub</a></p>
        </div>
        <button class="icon" id="mute" title="Sonido">🔊</button>
      </header>

      <section>
        <label class="lbl" for="circuit">Circuito</label>
        <select id="circuit">${CIRCUITS.map((x) => `<option value="${x.id}" ${x.id === c.id ? "selected" : ""}>${x.name}</option>`).join("")}</select>
        <p class="desc">${c.description}</p>
        <div class="views">${Object.entries(VIEWS)
          .map(([k, v]) => `<button data-view="${k}">${v.name}</button>`)
          .join("")}</div>
      </section>

      <section class="hint" id="hint"></section>

      <section>
        <h2>Multímetro</h2>
        <div class="readout" id="dmmReadout">—</div>
        <div class="row">
          <label class="lbl">Llave</label>
          <select id="dial">${DIAL_POSITIONS.map((d) => `<option value="${d}">${DIAL_LABEL[d]}${d === "OFF" ? "" : " — " + QTY[d]}</option>`).join("")}</select>
        </div>
        <div class="row">
          <label class="lbl">Punta roja en</label>
          <div class="seg" id="jack">${(["VOhm", "mA", "A"] as Jack[]).map((j) => `<button data-jack="${j}">${JACK_LABEL[j]}</button>`).join("")}</div>
        </div>
        <div class="row buttons">
          <button data-dmm="RANGE">RANGE</button><button data-dmm="HOLD">HOLD</button><button data-dmm="REL">REL Δ</button>
        </div>
        <div class="row probes">
          <button data-probe="red" class="probe red">Tomar punta roja <kbd>R</kbd></button>
          <button data-probe="black" class="probe black">Tomar punta negra <kbd>N</kbd></button>
        </div>
        <div class="row small" id="probeWhere"></div>
        <div class="row small" id="fuses"></div>
        <button id="stow" class="ghost">Guardar las puntas</button>
      </section>

      <section>
        <h2>Fuente</h2>
        <div class="readout psu" id="psuReadout">—</div>
        <div class="row two">
          <label>Tensión <input id="vset" type="number" min="0" max="30" step="0.01"> V</label>
          <label>Límite I <input id="iset" type="number" min="0" max="3" step="0.001"> A</label>
        </div>
        <button id="output" class="output">OUTPUT</button>
      </section>

      <section>
        <h2>Componentes</h2>
        <div id="resistors"></div>
        <h3>Puentes <small>(quitá uno para abrir el circuito y medir corriente en serie)</small></h3>
        <div class="jumpers" id="jumpers">${c.jumpers.map((j) => `<button data-jumper="${j.id}" style="--wire:${j.color}">${j.id}</button>`).join("")}</div>
      </section>

      <section>
        <h2>Cuaderno de mediciones</h2>
        <button id="note" class="primary">Anotar lectura <kbd>Espacio</kbd></button>
        <table class="notes"><thead><tr><th>#</th><th>Magnitud</th><th>Lectura</th><th>Puntas (+ / −)</th><th></th></tr></thead><tbody id="notes"></tbody></table>
        <div class="calc">
          <h3>Potencia P = V · I</h3>
          <div class="row two">
            <label>V <select id="calcV"></select></label>
            <label>I <select id="calcI"></select></label>
          </div>
          <div class="result" id="calcP">Anotá una tensión y una corriente.</div>
        </div>
      </section>

      <section>
        <h2>Guía</h2>
        <ol class="tasks">${c.tasks.map((t) => `<li>${t}</li>`).join("")}</ol>
        <label class="check"><input type="checkbox" id="showTheory"> Ver valores teóricos (nominales, instrumento ideal)</label>
        <label class="check"><input type="checkbox" id="showTruth"> Ver solución real del circuito (sin el multímetro)</label>
        <div id="theory"></div>
      </section>

      <section class="help">
        <h2>Controles</h2>
        <ul>
          <li><b>Rotar</b>: arrastrar · <b>Desplazar</b>: botón derecho · <b>Zoom</b>: rueda</li>
          <li><b>Llave del multímetro</b>: clic izq./der. o rueda</li>
          <li><b>Perillas de la fuente</b>: rueda o arrastrar (Shift ×10, Alt ×0,1)</li>
          <li><b>Puntas</b>: clic en la punta y luego en un agujero, una pata o un borne. <kbd>Esc</kbd> cancela.</li>
          <li><b>Puentes</b>: clic para quitar/poner</li>
        </ul>
      </section>`;

    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    for (const id of ["hint", "dmmReadout", "psuReadout", "probeWhere", "fuses", "resistors", "notes", "calcV", "calcI", "calcP", "theory", "output", "vset", "iset", "dial", "mute"]) this.els[id] = $(id);

    $("circuit").addEventListener("change", (e) => this.act.loadCircuit((e.target as HTMLSelectElement).value));
    this.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => btn.addEventListener("click", () => this.act.view(btn.dataset.view!)));
    (this.els.dial as HTMLSelectElement).addEventListener("change", (e) => this.act.setDial((e.target as HTMLSelectElement).value as Dial));
    this.root.querySelectorAll<HTMLButtonElement>("[data-jack]").forEach((btn) => btn.addEventListener("click", () => this.act.setJack(btn.dataset.jack as Jack)));
    this.root.querySelectorAll<HTMLButtonElement>("[data-dmm]").forEach((btn) => btn.addEventListener("click", () => this.act.dmmButton(btn.dataset.dmm as "RANGE")));
    this.root.querySelectorAll<HTMLButtonElement>("[data-probe]").forEach((btn) => btn.addEventListener("click", () => this.act.pickProbe(btn.dataset.probe as "red")));
    this.root.querySelectorAll<HTMLButtonElement>("[data-jumper]").forEach((btn) => btn.addEventListener("click", () => this.act.toggleJumper(btn.dataset.jumper!)));
    $("stow").addEventListener("click", () => this.act.stowProbes());
    this.els.output.addEventListener("click", () => this.act.toggleOutput());
    this.els.mute.addEventListener("click", () => (this.els.mute.textContent = this.act.toggleMute() ? "🔇" : "🔊"));
    const vset = this.els.vset as HTMLInputElement;
    const iset = this.els.iset as HTMLInputElement;
    vset.value = b.psu.vset.toFixed(2);
    iset.value = b.psu.iset.toFixed(3);
    vset.addEventListener("change", () => this.act.setPsu(Number(vset.value), null));
    iset.addEventListener("change", () => this.act.setPsu(null, Number(iset.value)));
    $("note").addEventListener("click", () => this.noteReading());
    ($("showTheory") as HTMLInputElement).checked = this.showTheory;
    ($("showTruth") as HTMLInputElement).checked = this.showTruth;
    $("showTheory").addEventListener("change", (e) => {
      this.showTheory = (e.target as HTMLInputElement).checked;
      this.updateTheory();
    });
    $("showTruth").addEventListener("change", (e) => {
      this.showTruth = (e.target as HTMLInputElement).checked;
      this.updateTheory();
    });
    this.els.calcV.addEventListener("change", () => this.updateCalc());
    this.els.calcI.addEventListener("change", () => this.updateCalc());

    this.renderResistors();
    this.renderNotes();
    this.update();
  }

  private renderResistors(): void {
    const values = eSeriesValues(10, 1e7);
    const wrap = this.els.resistors;
    wrap.innerHTML = "";
    for (const r of this.bench.circuit.resistors) {
      const part = this.bench.parts.get(r.id)!;
      const s = part.spec;
      const row = h("div", { class: "resistor", "data-id": r.id });
      const bands = colorBands(s.nominal, s.tolerance)
        .map((b) => `<i style="background:${b.hex}" title="${b.name}"></i>`)
        .join("");
      row.innerHTML = `
        <div class="rhead"><b>${r.id}</b><span class="bands ${s.tolerance === 0.01 ? "metal" : ""}">${bands}</span><span class="rstate" data-state></span></div>
        <div class="rctl">
          <select data-k="nominal">${values.map((v) => `<option value="${v}" ${v === s.nominal ? "selected" : ""}>${formatSI(v, "Ω")}</option>`).join("")}</select>
          <select data-k="tolerance"><option value="0.05" ${s.tolerance === 0.05 ? "selected" : ""}>±5 % carbón</option><option value="0.01" ${s.tolerance === 0.01 ? "selected" : ""}>±1 % metal film</option></select>
          <select data-k="power">${POWERS.map((p) => `<option value="${p}" ${p === s.power ? "selected" : ""}>${POWER_LABEL[p]}</option>`).join("")}</select>
        </div>
        <div class="rinfo"><span data-temp></span><button class="ghost small" data-replace>Reemplazar</button></div>`;
      const read = (): ResistorSpec => ({
        nominal: Number((row.querySelector('[data-k="nominal"]') as HTMLSelectElement).value),
        tolerance: Number((row.querySelector('[data-k="tolerance"]') as HTMLSelectElement).value) as 0.05 | 0.01,
        power: Number((row.querySelector('[data-k="power"]') as HTMLSelectElement).value) as PowerRating,
      });
      row.querySelectorAll("select").forEach((sel) =>
        sel.addEventListener("change", () => {
          this.act.setResistor(r.id, read());
          this.renderResistors();
        }),
      );
      row.querySelector("[data-replace]")!.addEventListener("click", () => this.act.replaceResistor(r.id));
      if (r.id === this.selectedResistor) row.classList.add("selected");
      wrap.appendChild(row);
    }
  }

  selectResistor(id: string): void {
    this.selectedResistor = id;
    this.renderResistors();
    this.root.querySelector(`.resistor[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  syncPsuInputs(): void {
    (this.els.vset as HTMLInputElement).value = this.bench.psu.vset.toFixed(2);
    (this.els.iset as HTMLInputElement).value = this.bench.psu.iset.toFixed(3);
  }

  noteReading(): void {
    const b = this.bench;
    const d = b.dmm.display;
    if (!d.on || d.leadAlert) return;
    this.notes.push({
      n: this.noteSeq++,
      qty: QTY[b.dmm.dial],
      text: `${d.text} ${d.unit}${d.acdc === "AC" ? " AC" : ""}`,
      value: d.value,
      baseUnit: d.baseUnit,
      red: b.describeTarget(b.probes.red),
      black: b.describeTarget(b.probes.black),
    });
    this.renderNotes();
  }

  private renderNotes(): void {
    const body = this.els.notes;
    body.innerHTML = this.notes
      .map(
        (n) =>
          `<tr><td>${n.n}</td><td>${n.qty}</td><td class="mono">${n.text}</td><td class="small">${n.red} / ${n.black}</td><td><button class="x" data-del="${n.n}" title="Borrar">×</button></td></tr>`,
      )
      .join("");
    body.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.notes = this.notes.filter((n) => n.n !== Number(btn.dataset.del));
        this.renderNotes();
      }),
    );
    const opt = (unit: string) =>
      this.notes
        .filter((n) => n.baseUnit === unit && n.value !== null)
        .map((n) => `<option value="${n.n}">#${n.n} · ${n.text}</option>`)
        .join("");
    const sv = this.els.calcV as HTMLSelectElement;
    const si = this.els.calcI as HTMLSelectElement;
    const pv = sv.value;
    const pi = si.value;
    sv.innerHTML = opt("V");
    si.innerHTML = opt("A");
    if ([...sv.options].some((o) => o.value === pv)) sv.value = pv;
    else if (sv.options.length) sv.selectedIndex = sv.options.length - 1;
    if ([...si.options].some((o) => o.value === pi)) si.value = pi;
    else if (si.options.length) si.selectedIndex = si.options.length - 1;
    this.updateCalc();
  }

  private updateCalc(): void {
    const v = this.notes.find((n) => n.n === Number((this.els.calcV as HTMLSelectElement).value));
    const i = this.notes.find((n) => n.n === Number((this.els.calcI as HTMLSelectElement).value));
    if (!v || !i || v.value === null || i.value === null) {
      this.els.calcP.textContent = "Anotá una tensión y una corriente.";
      return;
    }
    const p = v.value * i.value;
    const r = i.value !== 0 ? v.value / i.value : Infinity;
    // propagación de la incertidumbre según la especificación de los rangos (aprox.)
    const relV = 0.005 + 2 * 0.001 / Math.max(1e-9, Math.abs(v.value));
    const relI = 0.008 + 3 * 1e-5 / Math.max(1e-9, Math.abs(i.value));
    this.els.calcP.innerHTML = `
      <div><b>P = ${formatSI(Math.abs(p), "W", 4)}</b> <span class="muted">(±${((relV + relI) * 100).toFixed(1)} % aprox. por exactitud del instrumento)</span></div>
      <div class="muted">R = V / I = ${formatSI(Math.abs(r), "Ω", 4)}</div>`;
  }

  updateTheory(): void {
    const el = this.els.theory;
    if (!this.showTheory && !this.showTruth) {
      el.innerHTML = "";
      return;
    }
    const b = this.bench;
    const th = b.theory();
    const tr = b.truth();
    const rows = b.circuit.resistors
      .map((r) => {
        const t = th.parts.find((p) => p.id === r.id)!;
        const s = tr.parts.find((p) => p.id === r.id)!;
        const part = b.parts.get(r.id)!;
        const cell = (a: string, z: string) => `${this.showTheory ? `<span>${a}</span>` : ""}${this.showTruth ? `<span class="truth">${z}</span>` : ""}`;
        return `<tr><td><b>${r.id}</b></td>
          <td>${cell(formatSI(part.spec.nominal, "Ω"), formatSI(part.ohms, "Ω", 5))}</td>
          <td>${cell(formatSI(t.v, "V", 4), formatSI(s.v, "V", 5))}</td>
          <td>${cell(formatSI(t.i, "A", 4), formatSI(s.i, "A", 5))}</td>
          <td>${cell(formatSI(t.p, "W", 3), formatSI(s.p, "W", 4))}</td></tr>`;
      })
      .join("");
    const legend = `${this.showTheory ? "<span>teórico</span>" : ""}${this.showTruth ? '<span class="truth">real</span>' : ""}`;
    el.innerHTML = `<table class="theory"><thead><tr><th></th><th>R</th><th>V</th><th>I</th><th>P</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small">${legend} · I total: ${this.showTheory ? formatSI(th.itotal, "A", 4) : ""} ${this.showTruth ? `<span class="truth">${formatSI(tr.itotal, "A", 5)} (${tr.mode})</span>` : ""}</p>
      ${this.showTheory && b.psu.iset < th.itotal ? `<p class="warn">Con ${formatSI(b.psu.iset, "A")} de límite la fuente va a entrar en CC (limitación de corriente).</p>` : ""}`;
  }

  setHint(html: string): void {
    if (this.els.hint.innerHTML !== html) this.els.hint.innerHTML = html;
  }

  /** Refresco periódico de los valores dinámicos. */
  update(): void {
    const b = this.bench;
    const d = b.dmm.display;
    this.els.dmmReadout.innerHTML = d.on
      ? `<span class="mono">${d.text}</span> <span>${d.unit}</span> <small>${[d.acdc, d.auto ? "AUTO" : "", d.hold ? "HOLD" : "", d.rel ? "Δ" : ""].filter(Boolean).join(" · ")}</small>`
      : `<span class="muted">apagado</span>`;
    (this.els.dial as HTMLSelectElement).value = b.dmm.dial;
    this.root.querySelectorAll<HTMLButtonElement>("[data-jack]").forEach((btn) => btn.classList.toggle("on", btn.dataset.jack === b.dmm.red));
    this.els.probeWhere.innerHTML = `<span class="dot red"></span> ${b.describeTarget(b.probes.red)} &nbsp; <span class="dot black"></span> ${b.describeTarget(b.probes.black)}`;
    const fuse = (label: string, f: { blown: boolean; label: string }, which: "mA" | "A") =>
      `<span class="${f.blown ? "bad" : "ok"}">${label}: ${f.blown ? "QUEMADO" : "ok"}</span>${f.blown ? ` <button class="ghost small" data-fuse="${which}">Cambiar</button>` : ""}`;
    const fz = `Fusibles · ${fuse("mA", b.dmm.fuseMa, "mA")} · ${fuse("10A", b.dmm.fuseA, "A")}`;
    if (this.els.fuses.dataset.k !== fz) {
      this.els.fuses.dataset.k = fz;
      this.els.fuses.innerHTML = fz;
      this.els.fuses.querySelectorAll<HTMLButtonElement>("[data-fuse]").forEach((btn) => btn.addEventListener("click", () => this.act.replaceFuse(btn.dataset.fuse as "mA")));
    }
    for (const [id, val] of [
      ["vset", b.psu.vset.toFixed(2)],
      ["iset", b.psu.iset.toFixed(3)],
    ] as const) {
      const inp = this.els[id] as HTMLInputElement;
      if (document.activeElement !== inp && inp.value !== val) inp.value = val;
    }
    const pd = b.psu.display(b.time);
    this.els.psuReadout.innerHTML = `<span class="mono v">${pd.v}</span> V &nbsp; <span class="mono a">${pd.a}</span> A <small>${b.psu.output ? b.psu.mode : "OFF"}${pd.showingSet && b.psu.output ? " · SET" : ""}</small>`;
    this.els.output.classList.toggle("on", b.psu.output);
    this.els.output.textContent = b.psu.output ? "OUTPUT: ENCENDIDA" : "OUTPUT: APAGADA";
    this.root.querySelectorAll<HTMLButtonElement>("[data-jumper]").forEach((btn) => btn.classList.toggle("off", !b.jumperPresent.get(btn.dataset.jumper!)));

    this.root.querySelectorAll<HTMLElement>(".resistor").forEach((row) => {
      const part = b.parts.get(row.dataset.id!)!;
      const st = row.querySelector<HTMLElement>("[data-state]")!;
      const label = part.state === "quemado" ? "QUEMADO" : part.state === "humo" ? "¡HUMO!" : part.drift > 1.001 ? "dañado" : part.tempC > 80 ? "caliente" : "ok";
      st.textContent = label;
      st.className = `rstate ${part.state === "ok" && part.drift <= 1.001 ? (part.tempC > 80 ? "warm" : "ok") : "bad"}`;
      // la potencia disipada solo se muestra con la solución visible (es lo que hay que medir)
      const p = b.sol ? b.sol.pR(part.id) : 0;
      const extra = this.showTruth ? ` · disipa ${formatSI(p, "W", 3)} de ${POWER_LABEL[part.spec.power]}` : ` · máx. ${POWER_LABEL[part.spec.power]}`;
      row.querySelector<HTMLElement>("[data-temp]")!.textContent = `${part.tempC.toFixed(0)} °C${extra}`;
    });
    if (this.showTheory || this.showTruth) this.updateTheory();
  }
}

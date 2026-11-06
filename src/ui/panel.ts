import type { Bench, ProbeId } from "../sim/bench";
import { CAP_VALUES, formatCap, kindOf } from "../sim/capacitor";
import { CIRCUITS, type CircuitGroup } from "../sim/circuits";
import { DIODE_TYPES, type DiodeType } from "../sim/diode";
import { DIAL_FUNCTIONS, DIAL_LABEL, type Dial, type Jack } from "../sim/dmm";
import { WAVES, WAVE_LABEL, formatFreq, type Wave } from "../sim/fgen";
import { colorBands, eSeriesValues, formatSI, type PowerRating, type ResistorSpec } from "../sim/resistor";
import { TDIVS, VDIVS, type Oscilloscope } from "../sim/scope";
import { graticuleRect } from "./scopescreen";
import { VIEWS } from "../scene/world";
import { IS_TOUCH } from "../input";
import { DIODE_LABEL, IV_MAX_SERIES, ivChartSvg, ivLegend, ivSeries, type IvPoint } from "./ivcurve";

export interface PanelActions {
  loadCircuit(id: string): void;
  view(name: string): void;
  toggleJumper(id: string): void;
  setResistor(id: string, spec: ResistorSpec): void;
  replaceResistor(id: string): void;
  setDiode(id: string, type: DiodeType): void;
  flipDiode(id: string): void;
  replaceDiode(id: string): void;
  dmmButton(b: "SELECT" | "RANGE" | "HOLD" | "REL"): void;
  setDial(d: Dial): void;
  setJack(j: Jack): void;
  setPsu(v: number | null, i: number | null): void;
  toggleOutput(): void;
  replaceFuse(which: "mA" | "A"): void;
  stowProbes(): void;
  pickProbe(c: ProbeId): void;
  toggleMute(): boolean;
  /** Cambios en el generador (forma, frecuencia, amplitud, offset, salida). */
  setGen(p: { wave?: Wave; freq?: number; vpp?: number; offset?: number; output?: boolean }): void;
  /** Cualquier ajuste del osciloscopio (con el clic de la perilla o el botón). */
  scope(fn: (s: Oscilloscope) => void): void;
  setCap(id: string, nominal: number): void;
  flipCap(id: string): void;
  dischargeCap(id: string): void;
  replaceCap(id: string): void;
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
  DIODE: "Prueba de diodos",
  CONT: "Continuidad",
  mA: "Corriente DC",
  A: "Corriente DC",
};
const JACK_LABEL: Record<Jack, string> = { VOhm: "VΩ", mA: "mA", A: "10A" };
const GROUPS: CircuitGroup[] = ["Resistores", "Diodos y LED", "Capacitores y señales"];
const fmtDiv = (v: number, unit: string) => formatSI(v, unit, 3).replace(" ", "\u00a0");
const POWERS: PowerRating[] = [0.25, 0.5, 1, 2];
const POWER_LABEL: Record<number, string> = { 0.25: "¼ W", 0.5: "½ W", 1: "1 W", 2: "2 W" };

const MOUSE_HELP = `
          <li><b>Rotar</b>: arrastrar · <b>Desplazar</b>: botón derecho · <b>Zoom</b>: rueda</li>
          <li><b>Llave del multímetro</b>: clic izq./der. o rueda</li>
          <li><b>Perillas de la fuente</b>: rueda o arrastrar (Shift ×10, Alt ×0,1)</li>
          <li><b>Puntas</b>: clic en la punta y luego en un agujero, una pata o un borne. <kbd>Esc</kbd> cancela.</li>
          <li><b>Puentes</b>: clic para quitar/poner</li>
          <li><b>SELECT</b> (multímetro): en la posición Ω alterna Ω → ▶︎| diodos → ·))) continuidad</li>
          <li><b>Osciloscopio y generador</b>: perillas con rueda o arrastrando; los cursores se arrastran sobre la pantalla (también la del panel)</li>`;
const TOUCH_HELP = `
          <li><b>Rotar</b>: arrastrar con un dedo · <b>Zoom y desplazar</b>: dos dedos</li>
          <li><b>Llave del multímetro</b>: tocá a la izquierda o a la derecha de la llave</li>
          <li><b>Perillas de la fuente</b>: arrastrá hacia arriba o abajo (o escribí el valor en el panel)</li>
          <li><b>Puntas</b>: tomá una punta, apoyá el dedo y arrastrá; la mira va por encima del dedo y la punta se apoya al soltar</li>
          <li><b>Puentes</b>: tocalos para quitarlos o ponerlos</li>
          <li><b>SELECT</b> (multímetro): en la posición Ω alterna Ω → ▶︎| diodos → ·))) continuidad</li>
          <li><b>Osciloscopio</b>: los cursores se arrastran con el dedo sobre la pantalla del panel</li>`;

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
  private selectedPart: string | null = null;
  private iv: IvPoint[] = [];
  private ivSeq = 1;
  private ivMsg = "";
  /** Cantidad de anotaciones la última vez que se armaron los selectores de la curva. */
  private ivSeenNotes = 0;
  /** Canvas de la pantalla del osciloscopio (el mismo que usa el modelo 3D como textura). */
  scopeCanvas: HTMLCanvasElement | null = null;
  private dragCursor: 0 | 1 | null = null;

  constructor(
    private readonly bench: Bench,
    private readonly act: PanelActions,
    scopeCanvas: HTMLCanvasElement | null = null,
  ) {
    this.scopeCanvas = scopeCanvas;
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
        <select id="circuit">${GROUPS.map(
          (g) => `<optgroup label="${g}">${CIRCUITS.filter((x) => x.group === g)
            .map((x) => `<option value="${x.id}" ${x.id === c.id ? "selected" : ""}>${x.name}</option>`)
            .join("")}</optgroup>`,
        ).join("")}</select>
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
          <select id="dial">${DIAL_FUNCTIONS.map((d) => `<option value="${d}">${DIAL_LABEL[d]}${d === "OFF" ? "" : " — " + QTY[d]}</option>`).join("")}</select>
        </div>
        <div class="row">
          <label class="lbl">Punta roja en</label>
          <div class="seg" id="jack">${(["VOhm", "mA", "A"] as Jack[]).map((j) => `<button data-jack="${j}">${JACK_LABEL[j]}</button>`).join("")}</div>
        </div>
        <div class="row buttons">
          <button data-dmm="SELECT" class="select">SELECT</button><button data-dmm="RANGE">RANGE</button><button data-dmm="HOLD">HOLD</button><button data-dmm="REL">REL Δ</button>
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
${c.gen ? this.genHtml() : ""}
${this.scopeHtml()}

      <section>
        <h2>Componentes</h2>
        <div id="resistors"></div>
        <div id="diodes"></div>
        <div id="caps"></div>
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
        ${
          c.diodes?.length
            ? `<div class="calc iv">
          <h3>Curva I-V</h3>
          <div class="iv-pick">
            <label>Tensión del diodo <select id="ivV"></select></label>
            <label>Corriente <select id="ivI"></select></label>
          </div>
          <div class="row two">
            <label>R en serie <input id="ivR" type="number" min="0" step="0.01"> Ω <span class="small">(medila y corregí el valor)</span></label>
          </div>
          <button id="ivAdd" class="primary">Agregar punto a la curva</button>
          <div class="small" id="ivMsg"></div>
          <div class="iv-legend" id="ivLegend"></div>
          <div class="iv-chart" id="ivChart"></div>
          <table class="notes"><thead><tr><th>Componente</th><th>V</th><th>I</th><th>De</th><th></th></tr></thead><tbody id="ivPts"></tbody></table>
          <p class="small">La línea punteada (con «Ver valores teóricos») es el modelo nominal del componente.</p>
        </div>`
            : ""
        }
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
          ${IS_TOUCH ? TOUCH_HELP : MOUSE_HELP}
        </ul>
      </section>`;

    const $ = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!;
    for (const id of ["hint", "dmmReadout", "psuReadout", "probeWhere", "fuses", "resistors", "diodes", "caps", "notes", "calcV", "calcI", "calcP", "theory", "output", "vset", "iset", "dial", "mute", "scopeScreen", "scopeWhere", "scopeStatus"]) this.els[id] = $(id);

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
      this.renderIv();
    });
    $("showTruth").addEventListener("change", (e) => {
      this.showTruth = (e.target as HTMLInputElement).checked;
      this.updateTheory();
    });
    this.els.calcV.addEventListener("change", () => this.updateCalc());
    this.els.calcI.addEventListener("change", () => this.updateCalc());

    const ivAdd = this.root.querySelector("#ivAdd");
    const ivIds = ["ivV", "ivI", "ivR", "ivMsg", "ivLegend", "ivChart", "ivPts"];
    for (const id of ivIds) delete this.els[id]; // los del circuito anterior ya no están en la página
    if (ivAdd) {
      for (const id of ivIds) this.els[id] = $(id);
      const r1 = c.resistors[0]?.spec.nominal;
      if (r1) (this.els.ivR as HTMLInputElement).value = String(r1);
      ivAdd.addEventListener("click", () => this.addIvPoint());
    }

    this.bindGen();
    this.bindScope();
    this.renderResistors();
    this.renderDiodes();
    this.renderCaps();
    this.renderNotes();
    this.renderIv();
    this.update();
  }

  // ---------------------------------------------------------------- generador

  private genHtml(): string {
    return `
      <section>
        <h2>Generador de funciones</h2>
        <div class="readout gen" id="genReadout">—</div>
        <div class="seg wave" id="genWave">${WAVES.map((w) => `<button data-wave="${w}">${WAVE_LABEL[w]}</button>`).join("")}</div>
        <div class="row three">
          <label>Frecuencia <input id="genFreq" type="number" min="0.1" max="20000" step="any"> Hz</label>
          <label>Amplitud <input id="genVpp" type="number" min="0.002" max="20" step="0.1"> Vpp</label>
          <label>Offset <input id="genOff" type="number" min="-10" max="10" step="0.1"> V</label>
        </div>
        <button id="genOutput" class="output">OUTPUT</button>
        <p class="small muted">Salida de 50 Ω; la amplitud es la de circuito abierto. La masa del BNC va a la tierra del enchufe, igual que la del osciloscopio.</p>
      </section>`;
  }

  private bindGen(): void {
    const r = this.root;
    for (const id of ["genReadout", "genFreq", "genVpp", "genOff", "genOutput"]) {
      const el = r.querySelector<HTMLElement>(`#${id}`);
      if (el) this.els[id] = el;
      else delete this.els[id];
    }
    if (!this.els.genOutput) return;
    r.querySelectorAll<HTMLButtonElement>("[data-wave]").forEach((b) => b.addEventListener("click", () => this.act.setGen({ wave: b.dataset.wave as Wave })));
    const num = (id: string, key: "freq" | "vpp" | "offset") =>
      this.els[id].addEventListener("change", () => {
        const v = Number((this.els[id] as HTMLInputElement).value);
        if (isFinite(v)) this.act.setGen({ [key]: v });
      });
    num("genFreq", "freq");
    num("genVpp", "vpp");
    num("genOff", "offset");
    this.els.genOutput.addEventListener("click", () => this.act.setGen({ output: !this.bench.gen.output }));
  }

  // ---------------------------------------------------------------- osciloscopio

  private scopeHtml(): string {
    const vdivOpts = VDIVS.map((v) => `<option value="${v}">${fmtDiv(v, "V")}/div</option>`).join("");
    const chRow = (c: 0 | 1) => `
        <div class="sc-ch ch${c + 1}">
          <button class="chbtn" data-ch="${c}">CH${c + 1}</button>
          <select data-vdiv="${c}" aria-label="Escala vertical CH${c + 1}">${vdivOpts}</select>
          <span class="nudge"><button data-pos="${c}" data-d="1" title="Subir la traza">▲</button><button data-pos="${c}" data-d="-1" title="Bajar la traza">▼</button></span>
          <div class="seg mini">${(["DC", "AC", "GND"] as const).map((k) => `<button data-cpl="${c}" data-v="${k}">${k}</button>`).join("")}</div>
        </div>`;
    return `
      <section class="scope-sec">
        <h2>Osciloscopio</h2>
        <div class="scope-screen" id="scopeScreen"></div>
        <div class="row buttons sc-top">
          <button data-sc="run" class="run">RUN / STOP</button><button data-sc="single">SINGLE</button><button data-sc="autoset" class="select">AUTOSET</button>
        </div>
        ${chRow(0)}${chRow(1)}
        <div class="sc-row">
          <label class="lbl">Horizontal</label>
          <select id="scTdiv" aria-label="Base de tiempo">${TDIVS.map((t) => `<option value="${t}">${fmtDiv(t, "s")}/div</option>`).join("")}</select>
          <span class="nudge"><button data-hpos="-1" title="Mover a la izquierda">◀</button><button data-hpos="1" title="Mover a la derecha">▶</button></span>
        </div>
        <div class="sc-row">
          <label class="lbl">Disparo</label>
          <div class="seg mini" id="scTsrc"><button data-tsrc="0">CH1</button><button data-tsrc="1">CH2</button></div>
          <div class="seg mini" id="scSlope"><button data-slope="rise" title="Flanco de subida">↗</button><button data-slope="fall" title="Flanco de bajada">↘</button></div>
          <span class="nudge"><button data-lvl="1" title="Subir el nivel">▲</button><button data-lvl="-1" title="Bajar el nivel">▼</button></span>
          <div class="seg mini" id="scTmode">${(["AUTO", "NORMAL", "SINGLE"] as const).map((m) => `<button data-tmode="${m}">${m === "NORMAL" ? "NORM" : m}</button>`).join("")}</div>
        </div>
        <div class="sc-row">
          <label class="lbl">Cursores</label>
          <div class="seg mini" id="scCur"><button data-cur="off">No</button><button data-cur="time">Tiempo</button><button data-cur="volt">Tensión</button></div>
          <div class="seg mini" id="scCurCh"><button data-curch="0">CH1</button><button data-curch="1">CH2</button></div>
          <label class="check inline"><input type="checkbox" id="scMeas"> Mediciones</label>
        </div>
        <p class="small muted" id="scopeStatus"></p>
        <div class="row probes three">
          <button data-probe="ch1" class="probe ch1">Punta CH1</button>
          <button data-probe="ch2" class="probe ch2">Punta CH2</button>
          <button data-probe="sgnd" class="probe sgnd">Pinza de masa</button>
        </div>
        <div class="row small" id="scopeWhere"></div>
      </section>`;
  }

  private bindScope(): void {
    const r = this.root;
    const S = (fn: (s: Oscilloscope) => void) => this.act.scope(fn);
    r.querySelectorAll<HTMLButtonElement>("[data-sc]").forEach((b) =>
      b.addEventListener("click", () =>
        S((s) => {
          if (b.dataset.sc === "run") s.toggleRun();
          else if (b.dataset.sc === "single") s.single();
          else s.autoset();
        }),
      ),
    );
    r.querySelectorAll<HTMLButtonElement>("[data-ch]").forEach((b) => b.addEventListener("click", () => S((s) => (s.ch[+b.dataset.ch!].on = !s.ch[+b.dataset.ch!].on))));
    r.querySelectorAll<HTMLSelectElement>("[data-vdiv]").forEach((sel) =>
      sel.addEventListener("change", () =>
        S((s) => {
          const c = +sel.dataset.vdiv! as 0 | 1;
          const old = s.ch[c].vdiv;
          s.ch[c].vdiv = Number(sel.value);
          s.ch[c].pos = Math.max(-4, Math.min(4, (s.ch[c].pos * old) / s.ch[c].vdiv));
        }),
      ),
    );
    r.querySelectorAll<HTMLButtonElement>("[data-pos]").forEach((b) =>
      b.addEventListener("click", () => S((s) => (s.ch[+b.dataset.pos!].pos = Math.max(-4, Math.min(4, Math.round((s.ch[+b.dataset.pos!].pos + 0.5 * +b.dataset.d!) * 10) / 10))))),
    );
    r.querySelectorAll<HTMLButtonElement>("[data-cpl]").forEach((b) => b.addEventListener("click", () => S((s) => (s.ch[+b.dataset.cpl!].coupling = b.dataset.v as "DC"))));
    r.querySelector<HTMLSelectElement>("#scTdiv")!.addEventListener("change", (e) => S((s) => s.setTdiv(Number((e.target as HTMLSelectElement).value))));
    r.querySelectorAll<HTMLButtonElement>("[data-hpos]").forEach((b) =>
      b.addEventListener("click", () => S((s) => (s.hpos = Math.max(-5 * s.tdiv, Math.min(5 * s.tdiv, s.hpos - 0.5 * s.tdiv * +b.dataset.hpos!))))),
    );
    r.querySelectorAll<HTMLButtonElement>("[data-tsrc]").forEach((b) => b.addEventListener("click", () => S((s) => (s.trig.src = +b.dataset.tsrc! as 0 | 1))));
    r.querySelectorAll<HTMLButtonElement>("[data-slope]").forEach((b) => b.addEventListener("click", () => S((s) => (s.trig.slope = b.dataset.slope as "rise"))));
    r.querySelectorAll<HTMLButtonElement>("[data-lvl]").forEach((b) => b.addEventListener("click", () => S((s) => (s.trig.level = Math.round((s.trig.level + 0.2 * s.ch[s.trig.src].vdiv * +b.dataset.lvl!) * 1000) / 1000))));
    r.querySelectorAll<HTMLButtonElement>("[data-tmode]").forEach((b) =>
      b.addEventListener("click", () =>
        S((s) => {
          if (b.dataset.tmode === "SINGLE") s.single();
          else {
            s.trig.mode = b.dataset.tmode as "AUTO";
            if (!s.running) s.toggleRun();
          }
        }),
      ),
    );
    r.querySelectorAll<HTMLButtonElement>("[data-cur]").forEach((b) => b.addEventListener("click", () => S((s) => (s.cursor.mode = b.dataset.cur as "off"))));
    r.querySelectorAll<HTMLButtonElement>("[data-curch]").forEach((b) => b.addEventListener("click", () => S((s) => (s.cursor.chan = +b.dataset.curch! as 0 | 1))));
    const meas = r.querySelector<HTMLInputElement>("#scMeas")!;
    meas.checked = this.bench.scope.measure;
    meas.addEventListener("change", () => S((s) => (s.measure = meas.checked)));
    this.mountScopeScreen();
  }

  /** Pone la pantalla del osciloscopio en el panel y permite arrastrar los cursores sobre ella. */
  private mountScopeScreen(): void {
    const slot = this.els.scopeScreen;
    const cv = this.scopeCanvas;
    if (!slot || !cv) return;
    slot.appendChild(cv);
    if (cv.dataset.bound) return;
    cv.dataset.bound = "1";
    const frac = (e: PointerEvent) => {
      const b = cv.getBoundingClientRect();
      const g = graticuleRect(cv.width, cv.height);
      const px = ((e.clientX - b.left) / b.width) * cv.width;
      const py = ((e.clientY - b.top) / b.height) * cv.height;
      return { x: (px - g.x) / g.w, y: 1 - (py - g.y) / g.h };
    };
    cv.addEventListener("pointerdown", (e) => {
      const s = this.bench.scope;
      if (s.cursor.mode === "off") return;
      const f = frac(e);
      const v = s.cursor.mode === "time" ? f.x : f.y;
      this.dragCursor = Math.abs(v - s.cursor.a) <= Math.abs(v - s.cursor.b) ? 0 : 1;
      s.cursor.sel = this.dragCursor;
      cv.setPointerCapture(e.pointerId);
      this.moveCursor(f);
      e.preventDefault();
    });
    cv.addEventListener("pointermove", (e) => {
      if (this.dragCursor !== null) this.moveCursor(frac(e));
    });
    const end = () => (this.dragCursor = null);
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
  }

  /** Mueve el cursor que se está arrastrando (fracción de la cuadrícula). */
  moveCursor(f: { x: number; y: number }, which: 0 | 1 | null = this.dragCursor): void {
    const s = this.bench.scope;
    if (which === null || s.cursor.mode === "off") return;
    const v = Math.max(0, Math.min(1, s.cursor.mode === "time" ? f.x : f.y));
    if (which === 0) s.cursor.a = v;
    else s.cursor.b = v;
  }

  private updateScope(): void {
    const b = this.bench;
    const s = b.scope;
    const r = this.root;
    const on = (sel: string, pred: (el: HTMLElement) => boolean) => r.querySelectorAll<HTMLElement>(sel).forEach((el) => el.classList.toggle("on", pred(el)));
    on("[data-ch]", (el) => s.ch[+el.dataset.ch!].on);
    on("[data-cpl]", (el) => s.ch[+el.dataset.cpl!].coupling === el.dataset.v);
    on("[data-tsrc]", (el) => s.trig.src === +el.dataset.tsrc!);
    on("[data-slope]", (el) => s.trig.slope === el.dataset.slope);
    on("[data-tmode]", (el) => s.trig.mode === el.dataset.tmode);
    on("[data-cur]", (el) => s.cursor.mode === el.dataset.cur);
    on("[data-curch]", (el) => s.cursor.chan === +el.dataset.curch!);
    r.querySelector<HTMLElement>('[data-sc="run"]')?.classList.toggle("stopped", !s.running);
    r.querySelectorAll<HTMLSelectElement>("[data-vdiv]").forEach((sel) => {
      const v = String(s.ch[+sel.dataset.vdiv!].vdiv);
      if (document.activeElement !== sel && sel.value !== v) sel.value = v;
    });
    const td = r.querySelector<HTMLSelectElement>("#scTdiv");
    if (td && document.activeElement !== td && td.value !== String(s.tdiv)) td.value = String(s.tdiv);
    const meas = r.querySelector<HTMLInputElement>("#scMeas");
    if (meas) meas.checked = s.measure;
    const where = (p: ProbeId) => b.describeTarget(b.probes[p]);
    this.els.scopeWhere.innerHTML = `<span class="dot ch1"></span> ${where("ch1")} &nbsp; <span class="dot ch2"></span> ${where("ch2")} &nbsp; <span class="dot sgnd"></span> masa: ${where("sgnd")}`;
    const slow = b.speed < 0.95 ? ` · simulación en cámara lenta (×${b.speed.toFixed(2).replace(".", ",")}) para resolver la señal` : "";
    const step = b.lastH > 0 ? `paso de simulación ${formatSI(b.lastH, "s", 2)}` : "circuito en continua";
    this.els.scopeStatus.textContent = `${step}${slow}`;
  }

  // ---------------------------------------------------------------- capacitores

  private renderCaps(): void {
    const wrap = this.els.caps;
    wrap.innerHTML = "";
    for (const c of this.bench.circuit.capacitors ?? []) {
      const part = this.bench.caps.get(c.id)!;
      const row = h("div", { class: "part cap", "data-cid": c.id });
      row.innerHTML = `
        <div class="rhead"><b>${c.id}</b><span class="csym ${part.polarized ? "elec" : ""}" title="${part.polarized ? "Electrolítico" : "Cerámico"}"></span><span class="small" data-where></span><span class="rstate" data-state></span></div>
        <div class="dctl">
          <select data-k="nominal">${CAP_VALUES.map((v) => `<option value="${v}" ${Math.abs(v - part.nominal) < v * 1e-6 ? "selected" : ""}>${formatCap(v)} · ${kindOf(v) === "ceramico" ? "cerámico" : "electrolítico"}</option>`).join("")}</select>
          ${part.polarized ? `<button class="ghost small" data-flip>Dar vuelta</button>` : ""}
        </div>
        <div class="rinfo"><span data-temp></span><span><button class="ghost small" data-dis title="Un corto con el destornillador">Descargar</button> <button class="ghost small" data-replace>Reemplazar</button></span></div>`;
      row.querySelector("select")!.addEventListener("change", (e) => {
        this.act.setCap(c.id, Number((e.target as HTMLSelectElement).value));
        this.renderCaps();
      });
      row.querySelector("[data-flip]")?.addEventListener("click", () => this.act.flipCap(c.id));
      row.querySelector("[data-dis]")!.addEventListener("click", () => this.act.dischargeCap(c.id));
      row.querySelector("[data-replace]")!.addEventListener("click", () => this.act.replaceCap(c.id));
      if (c.id === this.selectedPart) row.classList.add("selected");
      wrap.appendChild(row);
    }
  }

  private renderDiodes(): void {
    const wrap = this.els.diodes;
    wrap.innerHTML = "";
    for (const d of this.bench.circuit.diodes ?? []) {
      const part = this.bench.diodes.get(d.id)!;
      const m = part.model;
      const row = h("div", { class: "part diode", "data-did": d.id });
      row.innerHTML = `
        <div class="rhead"><b>${d.id}</b><span class="dsym${m.led ? " led" : ""}" style="--c:${m.light ?? "#1b1b1d"}" title="${m.name}"></span><span class="small" data-where></span><span class="rstate" data-state></span></div>
        <div class="dctl">
          <select data-k="type">${DIODE_TYPES.map((t) => `<option value="${t}" ${t === part.type ? "selected" : ""}>${DIODE_LABEL[t]}${t === "1N4007" ? " (rectificador)" : " 5 mm"}</option>`).join("")}</select>
          <button class="ghost small" data-flip>Dar vuelta</button>
        </div>
        <div class="rinfo"><span data-temp></span><button class="ghost small" data-replace>Reemplazar</button></div>`;
      row.querySelector("select")!.addEventListener("change", (e) => {
        this.act.setDiode(d.id, (e.target as HTMLSelectElement).value as DiodeType);
        this.renderDiodes();
      });
      row.querySelector("[data-flip]")!.addEventListener("click", () => this.act.flipDiode(d.id));
      row.querySelector("[data-replace]")!.addEventListener("click", () => this.act.replaceDiode(d.id));
      if (d.id === this.selectedPart) row.classList.add("selected");
      wrap.appendChild(row);
    }
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
      if (r.id === this.selectedPart) row.classList.add("selected");
      wrap.appendChild(row);
    }
  }

  /** Resalta un componente (resistor o diodo) en el panel. */
  selectPart(id: string): void {
    this.selectedPart = id;
    this.renderResistors();
    this.renderDiodes();
    this.renderCaps();
    this.root.querySelector(`.resistor[data-id="${id}"], .diode[data-did="${id}"], .cap[data-cid="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /** Lleva el panel a la sección del osciloscopio o del generador. */
  scrollTo(which: "scope" | "gen"): void {
    const el = which === "scope" ? this.root.querySelector(".scope-sec") : this.els.genReadout?.closest("section");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    this.renderIvSelects();
  }

  /** Opciones de la curva I-V: V del diodo (lecturas de tensión) e I (de corriente, o V_R ÷ R). */
  private renderIvSelects(): void {
    const sv = this.els.ivV as HTMLSelectElement | undefined;
    const si = this.els.ivI as HTMLSelectElement | undefined;
    if (!sv || !si) return;
    const volts = this.notes.filter((n) => n.baseUnit === "V" && n.value !== null);
    const amps = this.notes.filter((n) => n.baseUnit === "A" && n.value !== null);
    // con anotaciones nuevas se proponen las últimas (Vd y después V_R); si no, se respeta lo elegido
    const grew = this.notes.length > this.ivSeenNotes;
    this.ivSeenNotes = this.notes.length;
    const pv = grew ? "" : sv.value;
    const pi = grew ? "" : si.value;
    sv.innerHTML = volts.map((n) => `<option value="${n.n}">#${n.n} · ${n.text}</option>`).join("");
    si.innerHTML =
      amps.map((n) => `<option value="i:${n.n}">#${n.n} · ${n.text}</option>`).join("") +
      volts.map((n) => `<option value="v:${n.n}">#${n.n} · ${n.text} ÷ R</option>`).join("");
    // por defecto: si lo último anotado es una corriente, va directo; si es una tensión, es V_R y la anterior es Vd
    const last = [...amps, ...volts].sort((a, b) => b.n - a.n)[0];
    const lastIsAmp = last?.baseUnit === "A";
    const vd = lastIsAmp ? volts[volts.length - 1] : volts[volts.length - 2] ?? volts[volts.length - 1];
    if ([...sv.options].some((o) => o.value === pv)) sv.value = pv;
    else if (vd) sv.value = String(vd.n);
    if ([...si.options].some((o) => o.value === pi)) si.value = pi;
    else if (last) si.value = `${lastIsAmp ? "i" : "v"}:${last.n}`;
  }

  private addIvPoint(): void {
    const sv = this.els.ivV as HTMLSelectElement;
    const si = this.els.ivI as HTMLSelectElement;
    const vNote = this.notes.find((n) => n.n === Number(sv.value));
    const [kind, num] = si.value.split(":");
    const iNote = this.notes.find((n) => n.n === Number(num));
    const R = Number((this.els.ivR as HTMLInputElement).value);
    const diode = [...this.bench.diodes.values()][0];
    if (!vNote || vNote.value === null || !iNote || iNote.value === null || !diode) {
      this.ivMsg = "Anotá la tensión del diodo y la corriente (o la tensión sobre R) en el cuaderno.";
    } else if (kind === "v" && !(R > 0)) {
      this.ivMsg = "Para calcular I = V_R / R escribí el valor de R.";
    } else if (kind === "v" && vNote.n === iNote.n) {
      this.ivMsg = "Elegí dos lecturas distintas: la del diodo y la de la resistencia.";
    } else if (!ivSeries(this.iv).some((s) => s.type === diode.type) && ivSeries(this.iv).length >= IV_MAX_SERIES) {
      this.ivMsg = `La curva compara hasta ${IV_MAX_SERIES} componentes: borrá los puntos de alguno.`;
    } else {
      const i = kind === "v" ? Math.abs(iNote.value) / R : Math.abs(iNote.value);
      this.iv.push({ id: this.ivSeq++, type: diode.type, v: vNote.value, i, from: `#${vNote.n} y #${iNote.n}` });
      this.ivMsg = "";
    }
    this.renderIv();
  }

  private renderIv(): void {
    if (!this.els.ivChart) return;
    this.els.ivMsg.textContent = this.ivMsg;
    this.els.ivLegend.innerHTML = ivLegend(this.iv);
    this.els.ivChart.innerHTML = ivChartSvg(this.iv, this.showTheory);
    const body = this.els.ivPts;
    body.innerHTML = this.iv
      .map((p) => `<tr><td>${DIODE_LABEL[p.type]}</td><td class="mono">${formatSI(p.v, "V", 4)}</td><td class="mono">${formatSI(p.i, "A", 3)}</td><td class="small">${p.from}</td><td><button class="x" data-ivdel="${p.id}" title="Borrar">×</button></td></tr>`)
      .join("");
    body.querySelectorAll<HTMLButtonElement>("[data-ivdel]").forEach((btn) =>
      btn.addEventListener("click", () => {
        this.iv = this.iv.filter((p) => p.id !== Number(btn.dataset.ivdel));
        this.renderIv();
      }),
    );
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
    if (b.circuit.analysis) {
      const rows = b
        .analysis()
        .map((r) => `<tr><td>${r.label}</td><td>${this.showTheory ? r.theory : ""}</td><td>${this.showTruth ? `<span class="truth">${r.real}</span>` : ""}</td></tr>`)
        .join("");
      el.innerHTML = `<table class="theory analysis"><thead><tr><th></th><th>${this.showTheory ? "teórico (nominal)" : ""}</th><th>${this.showTruth ? '<span class="truth">con los valores reales</span>' : ""}</th></tr></thead><tbody>${rows}</tbody></table>`;
      return;
    }
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
    const diodeRows = (b.circuit.diodes ?? [])
      .map((d) => {
        const t = th.diodes.find((p) => p.id === d.id)!;
        const s = tr.diodes.find((p) => p.id === d.id)!;
        const part = b.diodes.get(d.id)!;
        const cell = (a: string, z: string) => `${this.showTheory ? `<span>${a}</span>` : ""}${this.showTruth ? `<span class="truth">${z}</span>` : ""}`;
        return `<tr><td><b>${d.id}</b></td>
          <td>${cell(DIODE_LABEL[part.type], part.state === "quemado" ? "abierto" : part.reversed ? "en inversa" : "en directa")}</td>
          <td>${cell(formatSI(t.v, "V", 3), formatSI(s.v, "V", 4))}</td>
          <td>${cell(formatSI(t.i, "A", 3), formatSI(s.i, "A", 4))}</td>
          <td>${cell(formatSI(t.p, "W", 3), formatSI(s.p, "W", 3))}</td></tr>`;
      })
      .join("");
    const legend = `${this.showTheory ? "<span>teórico</span>" : ""}${this.showTruth ? '<span class="truth">real</span>' : ""}`;
    el.innerHTML = `<table class="theory"><thead><tr><th></th><th>R</th><th>V</th><th>I</th><th>P</th></tr></thead><tbody>${rows}${diodeRows}</tbody></table>
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
      const p = b.power.get(part.id) ?? 0;
      const extra = this.showTruth ? ` · disipa ${formatSI(p, "W", 3)} de ${POWER_LABEL[part.spec.power]}` : ` · máx. ${POWER_LABEL[part.spec.power]}`;
      row.querySelector<HTMLElement>("[data-temp]")!.textContent = `${part.tempC.toFixed(0)} °C${extra}`;
    });
    this.root.querySelectorAll<HTMLElement>(".diode").forEach((row) => {
      const part = b.diodes.get(row.dataset.did!);
      if (!part) return;
      const def = b.circuit.diodes!.find((d) => d.id === part.id)!;
      const holes = b.diodeHoles(def);
      const m = part.model;
      row.querySelector<HTMLElement>("[data-where]")!.textContent = `${m.led ? "ánodo (pata larga)" : "ánodo"} ${holes.a} · cátodo ${holes.k}`;
      const st = row.querySelector<HTMLElement>("[data-state]")!;
      const lit = m.led && part.brightness > 0.02;
      st.textContent = part.state === "quemado" ? "QUEMADO" : part.tempC > m.tjMax ? "¡MUY CALIENTE!" : part.reversed ? "al revés" : lit ? "encendido" : "ok";
      st.className = `rstate ${part.state === "quemado" || part.tempC > m.tjMax ? "bad" : part.tempC > m.tjMax * 0.7 || part.reversed ? "warm" : "ok"}`;
      const extra = this.showTruth ? ` · ${formatSI(part.current, "A", 3)} · ${formatSI(part.power, "W", 3)}` : "";
      row.querySelector<HTMLElement>("[data-temp]")!.textContent = `${part.tempC.toFixed(0)} °C · máx. ${formatSI(m.ifMax, "A")}${extra}`;
    });
    this.root.querySelectorAll<HTMLElement>(".cap").forEach((row) => {
      const part = b.caps.get(row.dataset.cid!);
      if (!part) return;
      const def = b.circuit.capacitors!.find((c) => c.id === part.id)!;
      const holes = b.capHoles(def);
      row.querySelector<HTMLElement>("[data-where]")!.textContent = part.polarized ? `+ en ${holes.p} · − en ${holes.n}` : `entre ${def.a} y ${def.b}`;
      const st = row.querySelector<HTMLElement>("[data-state]")!;
      st.textContent = part.state === "inflado" ? "INFLADO" : part.tempC > 85 ? "¡MUY CALIENTE!" : part.tempC > 45 ? "caliente" : part.reversed ? "al revés" : "ok";
      st.className = `rstate ${part.state === "inflado" || part.tempC > 85 ? "bad" : part.tempC > 45 || part.reversed ? "warm" : "ok"}`;
      const extra = this.showTruth ? ` · ${formatCap(part.farads)} reales · ${formatSI(part.volts, "V", 3)}` : "";
      row.querySelector<HTMLElement>("[data-temp]")!.textContent = `${part.tempC.toFixed(0)} °C · ${part.polarized ? `máx. ${part.model.vMax} V` : "50 V"}${extra}`;
    });
    if (this.els.genOutput) {
      const g = b.gen;
      this.els.genReadout.innerHTML = `<span class="w">${WAVE_LABEL[g.wave]}</span> <span class="mono f">${formatFreq(g.freq)}</span> <span class="mono">${formatSI(g.vpp, "Vpp", 3)}</span> <small>offset ${formatSI(g.offset, "V", 3)}</small>`;
      this.root.querySelectorAll<HTMLElement>("[data-wave]").forEach((el) => el.classList.toggle("on", el.dataset.wave === g.wave));
      for (const [id, val] of [
        ["genFreq", String(g.freq)],
        ["genVpp", String(g.vpp)],
        ["genOff", String(g.offset)],
      ] as const) {
        const inp = this.els[id] as HTMLInputElement;
        if (document.activeElement !== inp && inp.value !== val) inp.value = val;
      }
      this.els.genOutput.classList.toggle("on", g.output);
      this.els.genOutput.textContent = g.output ? "OUTPUT: ENCENDIDA" : "OUTPUT: APAGADA";
    }
    this.updateScope();
    if (this.showTheory || this.showTruth) this.updateTheory();
  }
}

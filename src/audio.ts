/** Sonidos del banco con WebAudio (se habilitan tras el primer gesto del usuario). */
export class BenchAudio {
  private ctx: AudioContext | null = null;
  private beepOsc: OscillatorNode | null = null;
  private beepGain: GainNode | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.beepOsc = this.ctx.createOscillator();
    this.beepOsc.type = "square";
    this.beepOsc.frequency.value = 2730; // típico de un buzzer piezo
    this.beepGain = this.ctx.createGain();
    this.beepGain.gain.value = 0;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5000;
    this.beepOsc.connect(lp).connect(this.beepGain).connect(this.ctx.destination);
    this.beepOsc.start();
  }

  /** Pitido continuo (continuidad) o intermitente (alerta). */
  setBeep(on: boolean): void {
    if (!this.ctx || !this.beepGain) return;
    const g = on && !this.muted ? 0.05 : 0;
    this.beepGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.005);
  }

  /** Chasquido de fusible / resistor quemado. */
  pop(strength = 1): void {
    if (!this.ctx || this.muted) return;
    const len = Math.floor(this.ctx.sampleRate * 0.12);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.12)) * strength;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(g).connect(this.ctx.destination);
    src.start();
  }

  click(): void {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = 1800;
    g.gain.setValueAtTime(0.04, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.03);
    o.connect(g).connect(this.ctx.destination);
    o.start();
    o.stop(this.ctx.currentTime + 0.04);
  }
}

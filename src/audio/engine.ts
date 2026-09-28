/**
 * Web Audio engine. Everything is synthesised (no sample files):
 *  - suction: band-passed noise hiss that gurgles when it is actually drawing blood,
 *  - bipolar: the characteristic electrosurgical buzz,
 *  - scissors: a short metallic snip,
 *  - UI ticks.
 * Doppler, ECG beeps and alarms are added in later milestones on the same bus.
 *
 * The AudioContext is created on the first user gesture (browser autoplay policy).
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private suctionGain: GainNode | null = null;
  private suctionFilter: BiquadFilterNode | null = null;
  private gurgleGain: GainNode | null = null;
  private bipolarGain: GainNode | null = null;
  private dopGain: GainNode | null = null;
  private dopBp1: BiquadFilterNode | null = null;
  private dopBp2: BiquadFilterNode | null = null;
  private muted = false;

  init() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // One second of white noise, reused by every noisy sound.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.buildSuction();
    this.buildBipolar();
    this.buildDoppler();
  }

  get ready() {
    return !!this.ctx && !this.muted;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  private noiseSource(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  private buildSuction() {
    const ctx = this.ctx!;
    const src = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bp).connect(hp).connect(g).connect(this.master!);
    src.start();
    this.suctionGain = g;
    this.suctionFilter = bp;

    // Gurgle: low noise amplitude-modulated by a jittery LFO.
    const src2 = this.noiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 6;
    const g2 = ctx.createGain();
    g2.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    src2.connect(lp).connect(g2).connect(this.master!);
    src2.start();
    this.gurgleGain = g2;
  }

  private buildBipolar() {
    const ctx = this.ctx!;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = 118;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = 472;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 950;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = 0;
    const mix2 = ctx.createGain();
    mix2.gain.value = 0.3;
    o1.connect(bp);
    o2.connect(mix2).connect(bp);
    bp.connect(g).connect(this.master!);
    o1.start();
    o2.start();
    this.bipolarGain = g;
  }

  /**
   * Micro-Doppler audio: the Doppler shift of moving red cells is in the audible range, so the
   * probe literally lets you hear flow — band-limited noise whose pitch follows blood velocity.
   */
  private buildDoppler() {
    const ctx = this.ctx!;
    const src = this.noiseSource();
    const bp1 = ctx.createBiquadFilter();
    bp1.type = 'bandpass';
    bp1.Q.value = 3.5;
    bp1.frequency.value = 400;
    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.Q.value = 5;
    bp2.frequency.value = 650;
    const g = ctx.createGain();
    g.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.55;
    src.connect(bp1).connect(g);
    src.connect(bp2).connect(g2).connect(g);
    g.connect(this.master!);
    src.start();
    this.dopGain = g;
    this.dopBp1 = bp1;
    this.dopBp2 = bp2;
  }

  /** Doppler velocity (0 = silence … ~1.5 fast / stenotic). */
  doppler(v: number) {
    if (!this.ctx || !this.dopGain) return;
    const t = this.ctx.currentTime;
    const f = 260 + 1500 * Math.max(0, v);
    this.dopBp1!.frequency.setTargetAtTime(f, t, 0.008);
    this.dopBp2!.frequency.setTargetAtTime(f * 1.6, t, 0.008);
    this.dopGain.gain.setTargetAtTime(Math.min(0.5, Math.max(0, v) * 0.42), t, 0.01);
  }

  /** Suction on/off; `drawing` 0…1 adds the gurgle of blood being aspirated. */
  suction(on: boolean, drawing = 0) {
    if (!this.ctx || !this.suctionGain) return;
    const t = this.ctx.currentTime;
    this.suctionGain.gain.setTargetAtTime(on ? 0.1 : 0, t, on ? 0.03 : 0.08);
    this.suctionFilter!.frequency.setTargetAtTime(on && drawing > 0.05 ? 900 : 1500, t, 0.1);
    this.gurgleGain!.gain.setTargetAtTime(on ? drawing * 0.22 : 0, t, 0.05);
  }

  bipolar(on: boolean) {
    if (!this.ctx || !this.bipolarGain) return;
    this.bipolarGain.gain.setTargetAtTime(on ? 0.06 : 0, this.ctx.currentTime, on ? 0.01 : 0.04);
  }

  /** Short metallic snip of micro-scissors. */
  snip() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(hp).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5, 0.1);
    // Tiny ring of the blades.
    const o = ctx.createOscillator();
    o.frequency.value = 5200 + Math.random() * 600;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.03, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og).connect(this.master!);
    o.start(t);
    o.stop(t + 0.13);
  }

  /** Soft UI tick (tool change etc.). */
  tick(freq = 1800, vol = 0.05) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.08);
  }

  /**
   * Pulse-oximeter beep: pitch follows saturation (lower SpO₂ → lower tone), as on real
   * monitors, so you can hear desaturation without looking.
   */
  beep(spo2: number) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = 880 * Math.pow(2, (Math.min(100, spo2) - 100) / 12 * 1.5);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(this.beepVolume, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.1);
  }

  beepVolume = 0.035;

  /**
   * Alarm burst (IEC 60601-1-8 style): high priority = 10 fast pulses (C-E-G-G-C …),
   * medium = 3 slower pulses (C-E-G).
   */
  alarm(priority: 'high' | 'medium') {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = priority === 'high' ? [523, 659, 784, 784, 1047, 523, 659, 784, 784, 1047] : [523, 659, 784];
    const gap = priority === 'high' ? 0.12 : 0.22;
    notes.forEach((f, i) => {
      const t = t0 + i * gap + (priority === 'high' && i >= 5 ? 0.35 : 0);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.015);
      g.gain.setValueAtTime(0.06, t + 0.09);
      g.gain.linearRampToValueAtTime(0, t + 0.11);
      const g2 = ctx.createGain();
      g2.gain.value = 0.25;
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(this.master!);
      o.start(t);
      o2.start(t);
      o.stop(t + 0.12);
      o2.stop(t + 0.12);
    });
  }

  /** Two-tone caution chime. */
  caution() {
    this.tick(880, 0.06);
    setTimeout(() => this.tick(660, 0.06), 110);
  }
}

export const audio = new AudioEngine();

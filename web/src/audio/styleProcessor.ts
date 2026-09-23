/**
 * Real-time "style" DSP chains — a curated preset of classic audio effects
 * (drive, tone filter, tremolo, slapback delay, reverb, compression) meant
 * to evoke a genre's character. This is NOT AI style transfer: it doesn't
 * touch rhythm or arrangement, only the sound's texture — the same kind of
 * trick a live sound engineer reaches for. Fully real-time, zero network,
 * zero cost: the entire chain runs as native Web Audio API nodes.
 *
 * Fixed topology, tunable parameters: switching styles never reconnects the
 * graph (which would risk clicks) — it only updates AudioParams and the
 * waveshaper curve on an already-connected chain. "none" is a (near)
 * transparent pass-through preset, not a bypass switch.
 */

export type StyleId =
  | "none"
  | "rock"
  | "hardrock"
  | "electro"
  | "jazz"
  | "salsa"
  | "opera";

export const STYLE_IDS: StyleId[] = [
  "none",
  "rock",
  "hardrock",
  "electro",
  "jazz",
  "salsa",
  "opera",
];

export const STYLE_LABELS: Record<StyleId, string> = {
  none: "Aucun",
  rock: "Rock",
  hardrock: "Hard Rock",
  electro: "Électro",
  jazz: "Jazz",
  salsa: "Salsa",
  opera: "Diva Opéra",
};

export interface StylePreset {
  /** WaveShaper drive amount, 0 (clean) .. 1 (heavily saturated). */
  drive: number;
  /** Tone-shaping BiquadFilter. */
  filterType: BiquadFilterType;
  filterFreq: number; // Hz
  filterQ: number;
  filterGain: number; // dB — only used by shelf/peaking filter types
  /** Amplitude tremolo via an LFO on gain. 0 rate/depth = no movement. */
  tremoloRate: number; // Hz
  tremoloDepth: number; // 0..1
  /** Short slapback-style delay. 0 wet = off. */
  delayTime: number; // seconds
  delayFeedback: number; // 0..1
  delayWet: number; // 0..1
  /** Convolution reverb using a procedurally generated impulse. 0 wet = off. */
  reverbType: "room" | "hall";
  reverbWet: number; // 0..1
  /** Glue/punch compression. ratio=1 effectively disables it. */
  compThreshold: number; // dB
  compRatio: number;
}

const TRANSPARENT: StylePreset = {
  drive: 0,
  filterType: "allpass",
  filterFreq: 1000,
  filterQ: 0.7,
  filterGain: 0,
  tremoloRate: 0,
  tremoloDepth: 0,
  delayTime: 0,
  delayFeedback: 0,
  delayWet: 0,
  reverbType: "room",
  reverbWet: 0,
  compThreshold: 0,
  compRatio: 1,
};

/**
 * Pure lookup: given a style id, the exact DSP parameters that define it.
 * Extracted as data (not baked into node-wiring code) so presets are
 * unit-testable and tunable without touching the audio graph.
 */
export function getStylePreset(style: StyleId): StylePreset {
  switch (style) {
    case "none":
      return TRANSPARENT;
    case "rock":
      return {
        ...TRANSPARENT,
        drive: 0.45,
        filterType: "peaking",
        filterFreq: 1800,
        filterQ: 0.9,
        filterGain: 4,
        compThreshold: -18,
        compRatio: 4,
      };
    case "hardrock":
      return {
        ...TRANSPARENT,
        drive: 0.85,
        filterType: "peaking",
        filterFreq: 3000,
        filterQ: 1.3,
        filterGain: 6,
        reverbType: "room",
        reverbWet: 0.08,
        compThreshold: -24,
        compRatio: 6,
      };
    case "electro":
      return {
        ...TRANSPARENT,
        drive: 0.3,
        filterType: "bandpass",
        filterFreq: 1200,
        filterQ: 3,
        tremoloRate: 6,
        tremoloDepth: 0.5,
        delayTime: 0.12,
        delayFeedback: 0.15,
        delayWet: 0.15,
        reverbType: "room",
        reverbWet: 0.05,
        compThreshold: -20,
        compRatio: 8,
      };
    case "jazz":
      return {
        ...TRANSPARENT,
        drive: 0.12,
        filterType: "highshelf",
        filterFreq: 6000,
        filterGain: -4,
        tremoloRate: 4,
        tremoloDepth: 0.08,
        reverbType: "room",
        reverbWet: 0.18,
        compThreshold: -16,
        compRatio: 2.5,
      };
    case "salsa":
      return {
        ...TRANSPARENT,
        drive: 0.15,
        filterType: "peaking",
        filterFreq: 2500,
        filterQ: 1.0,
        filterGain: 5,
        tremoloRate: 5,
        tremoloDepth: 0.25,
        delayTime: 0.09,
        delayFeedback: 0.05,
        delayWet: 0.22,
        reverbType: "room",
        reverbWet: 0.08,
        compThreshold: -18,
        compRatio: 3,
      };
    case "opera":
      return {
        ...TRANSPARENT,
        filterType: "peaking",
        filterFreq: 1000,
        filterQ: 0.8,
        filterGain: 3,
        tremoloRate: 5.5,
        tremoloDepth: 0.15,
        reverbType: "hall",
        reverbWet: 0.55,
        compThreshold: -14,
        compRatio: 2,
      };
  }
}

/**
 * Soft-clip (tanh) distortion curve. amount=0 returns an exact identity
 * curve (transparent). Higher amounts increase saturation monotonically —
 * a moderate input maps progressively closer to full scale as drive rises,
 * while a full-scale input (±1) always stays at ±1 regardless of amount.
 */
export function makeDriveCurve(amount: number, samples = 2048): Float32Array {
  const curve = new Float32Array(samples);
  const clamped = Math.max(0, Math.min(1, amount));
  const k = 1 + clamped * 9; // 1 (clean) .. 10 (heavily saturated)
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = clamped <= 0 ? x : Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Per-context, per-kind cache so every stem's reverb shares one impulse buffer. */
const impulseCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

function getImpulse(ctx: BaseAudioContext, kind: "room" | "hall"): AudioBuffer {
  let cache = impulseCache.get(ctx);
  if (!cache) {
    cache = new Map();
    impulseCache.set(ctx, cache);
  }
  const existing = cache.get(kind);
  if (existing) return existing;

  const duration = kind === "hall" ? 3.5 : 1.2;
  const decay = kind === "hall" ? 3.0 : 4.5;
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  cache.set(kind, buffer);
  return buffer;
}

export interface StyleChain {
  /** Connect upstream audio INTO this node. */
  input: AudioNode;
  /** Connect this node to whatever comes next. */
  output: AudioNode;
  /** Apply a preset's parameters. Never reconnects the graph. */
  setPreset(preset: StylePreset): void;
  /** Stops the internal LFO and releases references. Call on teardown. */
  dispose(): void;
}

/**
 * Builds one fixed-topology style chain:
 * input(shaper) -> filter -> tremolo -> delay(wet/dry) -> reverb(wet/dry) -> compressor(output)
 */
export function createStyleChain(ctx: BaseAudioContext): StyleChain {
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDriveCurve(0);
  shaper.oversample = "2x";

  const filter = ctx.createBiquadFilter();
  filter.type = "allpass";
  filter.frequency.value = 1000;
  filter.Q.value = 0.7;

  const tremolo = ctx.createGain();
  tremolo.gain.value = 1;
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.001; // effectively still; real rate set by preset
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth);
  lfoDepth.connect(tremolo.gain);
  lfo.start();

  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0;
  const delayWet = ctx.createGain();
  delayWet.gain.value = 0;
  const delayDry = ctx.createGain();
  delayDry.gain.value = 1;
  const delaySum = ctx.createGain();

  const reverbConvolver = ctx.createConvolver();
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = 0;
  const reverbDry = ctx.createGain();
  reverbDry.gain.value = 1;
  const reverbSum = ctx.createGain();

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = 0;
  compressor.ratio.value = 1;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.2;
  compressor.knee.value = 6;

  // Fixed wiring — only parameters change when the style changes.
  shaper.connect(filter);
  filter.connect(tremolo);

  tremolo.connect(delayDry);
  delayDry.connect(delaySum);
  tremolo.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(delayWet);
  delayWet.connect(delaySum);

  delaySum.connect(reverbDry);
  reverbDry.connect(reverbSum);
  delaySum.connect(reverbConvolver);
  reverbConvolver.connect(reverbWet);
  reverbWet.connect(reverbSum);

  reverbSum.connect(compressor);

  function setPreset(preset: StylePreset) {
    shaper.curve = makeDriveCurve(preset.drive);

    filter.type = preset.filterType;
    filter.frequency.value = preset.filterFreq;
    filter.Q.value = preset.filterQ;
    filter.gain.value = preset.filterGain;

    lfo.frequency.value = Math.max(preset.tremoloRate, 0.001);
    lfoDepth.gain.value = preset.tremoloDepth / 2;
    tremolo.gain.value = 1 - preset.tremoloDepth / 2;

    delay.delayTime.value = preset.delayTime;
    delayFeedback.gain.value = preset.delayFeedback;
    delayWet.gain.value = preset.delayWet;
    delayDry.gain.value = 1 - preset.delayWet;

    reverbConvolver.buffer = preset.reverbWet > 0 ? getImpulse(ctx, preset.reverbType) : null;
    reverbWet.gain.value = preset.reverbWet;
    reverbDry.gain.value = 1 - preset.reverbWet;

    compressor.threshold.value = preset.compThreshold;
    compressor.ratio.value = preset.compRatio;
  }

  setPreset(TRANSPARENT);

  function dispose() {
    try {
      lfo.stop();
    } catch {
      /* already stopped */
    }
  }

  return { input: shaper, output: compressor, setPreset, dispose };
}

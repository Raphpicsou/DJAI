import { useCallback, useEffect, useRef, useState } from "react";
import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
import soundTouchProcessorUrl from "@soundtouchjs/audio-worklet/processor?url";
import {
  createStyleChain,
  getStylePreset,
  type StyleChain,
  type StyleId,
} from "../audio/styleProcessor";
export type { StyleId } from "../audio/styleProcessor";

export interface StemTrack {
  name: string;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export interface BandGains {
  low: number; // dB, shelf @ 200Hz
  mid: number; // dB, peaking @ 1000Hz
  high: number; // dB, shelf @ 3200Hz
}

export const DEFAULT_BAND_GAINS: BandGains = { low: 0, mid: 0, high: 0 };

export const MIN_TEMPO = 0.5;
export const MAX_TEMPO = 1.5;

export type StretchMode = "tempo" | "timestretch";

export interface MultiTrackPlayer {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  muted: Record<string, boolean>;
  solo: Set<string>; // cumulative — several stems can be soloed together
  levels: Record<string, number>; // 0..1.5, continuous blend per stem
  vocalReduction: number; // 0..1 — master-bus phase-cancellation vocal reduction
  bandGains: BandGains; // master-bus 3-band kill EQ, in dB
  tempo: number; // 0.5..1.5 — vinyl-style speed (pitch follows speed)
  timeStretch: number; // 0.5..1.5 — true time-stretch (pitch stays the same)
  stretchMode: StretchMode; // which of the two is currently driving playback
  styles: Record<string, StyleId>; // per-stem genre-style DSP preset
  masterStyle: StyleId; // whole-mix genre-style DSP preset, on the master bus
  loop: boolean; // whole-track looping
  toggleAll: () => void;
  playSolo: (name: string) => void;
  toggleMute: (name: string) => void;
  setLevel: (name: string, level: number) => void;
  setVocalReduction: (amount: number) => void;
  setBandGain: (band: keyof BandGains, dB: number) => void;
  setTempo: (rate: number) => void;
  setTimeStretch: (rate: number) => void;
  setStyle: (name: string, style: StyleId) => void;
  setMasterStyle: (style: StyleId) => void;
  toggleLoop: () => void;
  seek: (time: number) => void;
}

/**
 * Pure helper: resolves a stem's effective linear gain from its continuous
 * blend level plus the binary mute/solo state. Extracted as a pure function
 * so the mixing logic is unit-testable without a real AudioContext.
 */
export function computeStemGain(
  name: string,
  levels: Record<string, number>,
  muted: Record<string, boolean>,
  solo: Set<string>,
): number {
  const level = levels[name] ?? 1;
  const audible = solo.size > 0 ? solo.has(name) : !(muted[name] ?? false);
  return audible ? level : 0;
}

/**
 * Pure helper: current position in track-time, accounting for a playback
 * rate that may differ from 1x. Real elapsed wall-clock time is scaled by
 * `rate` to get elapsed track-time — e.g. at 1.5x, 2 real seconds advance
 * the track by 3 seconds. Extracted as a pure function so it is
 * unit-testable without a real AudioContext.
 */
export function computeTrackPosition(
  offset: number,
  ctxCurrentTime: number,
  startedAt: number,
  rate: number,
): number {
  return offset + (ctxCurrentTime - startedAt) * rate;
}

/**
 * Manages synchronized playback of multiple audio stems using the Web Audio API.
 *
 * All stems are decoded into AudioBuffers and played through a single
 * AudioContext, guaranteeing sample-accurate sync. Mute/solo/level are all
 * implemented via GainNodes so decoding is never interrupted.
 *
 * Every stem's gain feeds a shared master bus, which runs two additional,
 * optional "DJAI" effects before the final output:
 *   1. Vocal reduction (L-R phase-cancellation, the classic karaoke trick) —
 *      crossfaded in on top of whatever real stem mix is already selected.
 *   2. A 3-band kill EQ (low/mid/high), the same technique DJs already use
 *      on a club mixer to fake stem isolation by hand.
 * These are deliberately separate from the real per-stem levels: the stems
 * are true ML separations, the master FX are classic DSP tricks layered on
 * top for extra creative control.
 *
 * AudioBufferSourceNodes are one-shot, so pause/play recreates them at the
 * saved offset. The rAF loop simply reads the AudioContext clock.
 */
export function useMultiTrackPlayer(
  tracks: StemTrack[] | null,
): MultiTrackPlayer {
  // Web Audio API refs — per-stem
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const gainsRef = useRef<Map<string, GainNode>>(new Map());
  const sourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const soundTouchNodesRef = useRef<Map<string, SoundTouchNode>>(new Map());
  const soundTouchRegisteredRef = useRef(false);
  const styleChainsRef = useRef<Map<string, StyleChain>>(new Map());
  const masterStyleChainRef = useRef<StyleChain | null>(null);

  // Web Audio API refs — shared master FX chain (built once per AudioContext)
  const masterInputRef = useRef<GainNode | null>(null);
  const splitterRef = useRef<ChannelSplitterNode | null>(null);
  const invRRef = useRef<GainNode | null>(null);
  const instrumentalSumRef = useRef<GainNode | null>(null);
  const dryGainLRef = useRef<GainNode | null>(null);
  const dryGainRRef = useRef<GainNode | null>(null);
  const wetGainLRef = useRef<GainNode | null>(null);
  const wetGainRRef = useRef<GainNode | null>(null);
  const mergerRef = useRef<ChannelMergerNode | null>(null);
  const lowFilterRef = useRef<BiquadFilterNode | null>(null);
  const midFilterRef = useRef<BiquadFilterNode | null>(null);
  const highFilterRef = useRef<BiquadFilterNode | null>(null);

  // Playback position tracking
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const modeRef = useRef<StretchMode>("tempo");
  const loopRef = useRef(false);

  const rafRef = useRef(0);

  // Mute/solo/level refs (source of truth)
  const mutedRef = useRef<Record<string, boolean>>({});
  const soloRef = useRef<Set<string>>(new Set());
  const levelsRef = useRef<Record<string, number>>({});

  // React state for rendering
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [solo, setSolo] = useState<Set<string>>(new Set());
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [vocalReduction, setVocalReductionState] = useState(0);
  const [bandGains, setBandGainsState] = useState<BandGains>(DEFAULT_BAND_GAINS);
  const [tempo, setTempoState] = useState(1);
  const [timeStretch, setTimeStretchState] = useState(1);
  const [stretchMode, setStretchModeState] = useState<StretchMode>("tempo");
  const [styles, setStyles] = useState<Record<string, StyleId>>({});
  const [masterStyle, setMasterStyleState] = useState<StyleId>("none");
  const [loop, setLoopState] = useState(false);

  /** Build the shared master FX chain once. Safe to call multiple times. */
  const ensureMasterChain = useCallback((ctx: AudioContext) => {
    if (masterInputRef.current) return;

    const masterInput = ctx.createGain();
    masterInput.gain.value = 1;

    const splitter = ctx.createChannelSplitter(2);
    const invR = ctx.createGain();
    invR.gain.value = -1;

    const instrumentalSum = ctx.createGain();
    instrumentalSum.gain.value = 1;
    instrumentalSum.channelCount = 1;
    instrumentalSum.channelCountMode = "explicit";
    instrumentalSum.channelInterpretation = "discrete";

    const dryGainL = ctx.createGain();
    const dryGainR = ctx.createGain();
    const wetGainL = ctx.createGain();
    const wetGainR = ctx.createGain();
    dryGainL.gain.value = 1;
    dryGainR.gain.value = 1;
    wetGainL.gain.value = 0;
    wetGainR.gain.value = 0;

    const merger = ctx.createChannelMerger(2);

    const lowFilter = ctx.createBiquadFilter();
    lowFilter.type = "lowshelf";
    lowFilter.frequency.value = 200;
    lowFilter.gain.value = 0;

    const midFilter = ctx.createBiquadFilter();
    midFilter.type = "peaking";
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 0.9;
    midFilter.gain.value = 0;

    const highFilter = ctx.createBiquadFilter();
    highFilter.type = "highshelf";
    highFilter.frequency.value = 3200;
    highFilter.gain.value = 0;

    // masterInput -> split -> [dry stereo] + [L-R instrumental, phase-cancelled]
    masterInput.connect(splitter);
    splitter.connect(dryGainL, 0);
    splitter.connect(dryGainR, 1);
    splitter.connect(instrumentalSum, 0);
    splitter.connect(invR, 1);
    invR.connect(instrumentalSum);

    dryGainL.connect(merger, 0, 0);
    dryGainR.connect(merger, 0, 1);
    instrumentalSum.connect(wetGainL);
    instrumentalSum.connect(wetGainR);
    wetGainL.connect(merger, 0, 0);
    wetGainR.connect(merger, 0, 1);

    merger.connect(lowFilter);
    lowFilter.connect(midFilter);
    midFilter.connect(highFilter);

    const masterStyleChain = createStyleChain(ctx);
    highFilter.connect(masterStyleChain.input);
    masterStyleChain.output.connect(ctx.destination);
    masterStyleChainRef.current = masterStyleChain;

    masterInputRef.current = masterInput;
    splitterRef.current = splitter;
    invRRef.current = invR;
    instrumentalSumRef.current = instrumentalSum;
    dryGainLRef.current = dryGainL;
    dryGainRRef.current = dryGainR;
    wetGainLRef.current = wetGainL;
    wetGainRRef.current = wetGainR;
    mergerRef.current = merger;
    lowFilterRef.current = lowFilter;
    midFilterRef.current = midFilter;
    highFilterRef.current = highFilter;
  }, []);

  /** Registers the SoundTouch AudioWorklet processor once per AudioContext. */
  const ensureSoundTouch = useCallback(async (ctx: AudioContext) => {
    if (soundTouchRegisteredRef.current) return true;
    try {
      await SoundTouchNode.register(ctx, soundTouchProcessorUrl);
      soundTouchRegisteredRef.current = true;
      return true;
    } catch (err) {
      console.warn(
        "SoundTouch AudioWorklet unavailable — falling back to vinyl-style tempo (pitch will shift).",
        err,
      );
      return false;
    }
  }, []);

  /** Apply mute/solo/level by setting gain values. Instant, glitch-free. */
  const syncGains = useCallback(() => {
    for (const [name, gain] of gainsRef.current) {
      gain.gain.value = computeStemGain(
        name,
        levelsRef.current,
        mutedRef.current,
        soloRef.current,
      );
    }
  }, []);

  /** Stop all active source nodes, clearing onended handlers first. */
  const stopSources = useCallback(() => {
    for (const src of sourcesRef.current.values()) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    sourcesRef.current.clear();
  }, []);

  /** Create and start source nodes for all stems at the given offset. */
  const startSources = useCallback(
    (offset: number) => {
      const ctx = ctxRef.current;
      if (!ctx) return;

      stopSources();

      for (const [name, buffer] of buffersRef.current) {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rateRef.current;

        const stNode = soundTouchNodesRef.current.get(name);
        const styleChain = styleChainsRef.current.get(name);
        if (modeRef.current === "timestretch" && stNode) {
          // True time-stretch: route through SoundTouch (which compensates
          // pitch for the mirrored playback rate), then into the style chain.
          stNode.playbackRate.value = rateRef.current;
          source.connect(stNode);
        } else if (styleChain) {
          // Vinyl-style tempo (or SoundTouch unavailable as a fallback):
          // straight to the style chain, native playbackRate only — pitch
          // follows speed, same as a turntable's pitch fader.
          source.connect(styleChain.input);
        } else {
          source.connect(gainsRef.current.get(name)!);
        }
        source.start(0, offset);
        sourcesRef.current.set(name, source);
      }

      const firstSource = sourcesRef.current.values().next().value;
      if (firstSource) {
        firstSource.onended = () => {
          if (!playingRef.current) return;
          if (loopRef.current) {
            startSources(0);
          } else {
            playingRef.current = false;
            offsetRef.current = 0;
            setIsPlaying(false);
            setCurrentTime(0);
          }
        };
      }

      startedAtRef.current = ctx.currentTime;
      offsetRef.current = offset;
      playingRef.current = true;
    },
    [stopSources],
  );

  // Decode audio buffers when tracks change
  useEffect(() => {
    stopSources();
    buffersRef.current.clear();
    for (const gain of gainsRef.current.values()) gain.disconnect();
    gainsRef.current.clear();
    for (const stNode of soundTouchNodesRef.current.values()) stNode.disconnect();
    soundTouchNodesRef.current.clear();
    for (const chain of styleChainsRef.current.values()) chain.dispose();
    styleChainsRef.current.clear();

    playingRef.current = false;
    offsetRef.current = 0;
    startedAtRef.current = 0;
    rateRef.current = 1;
    modeRef.current = "tempo";
    mutedRef.current = {};
    soloRef.current = new Set();
    levelsRef.current = {};

    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setMuted({});
    setSolo(new Set());
    setLevels({});
    setTempoState(1);
    setTimeStretchState(1);
    setStretchModeState("tempo");
    setStyles({});

    if (!tracks || tracks.length === 0) return;

    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    const ctx = ctxRef.current;
    ensureMasterChain(ctx);

    let cancelled = false;

    (async () => {
      const soundTouchOk = await ensureSoundTouch(ctx);
      if (cancelled) return;

      const initialMuted: Record<string, boolean> = {};
      const initialLevels: Record<string, number> = {};

      const decoded = tracks.map((track) => {
        const buffer = ctx.createBuffer(2, track.left.length, track.sampleRate);
        buffer.copyToChannel(track.left, 0);
        buffer.copyToChannel(track.right, 1);
        return { name: track.name, buffer };
      });

      if (cancelled) return;

      for (const { name, buffer } of decoded) {
        buffersRef.current.set(name, buffer);

        const gain = ctx.createGain();
        gain.connect(masterInputRef.current!);
        gainsRef.current.set(name, gain);

        const styleChain = createStyleChain(ctx);
        styleChain.output.connect(gain);
        styleChainsRef.current.set(name, styleChain);

        if (soundTouchOk) {
          const stNode = new SoundTouchNode({ context: ctx });
          stNode.connect(styleChain.input);
          soundTouchNodesRef.current.set(name, stNode);
        }

        initialMuted[name] = false;
        initialLevels[name] = 1;
      }

      mutedRef.current = initialMuted;
      levelsRef.current = initialLevels;
      setMuted(initialMuted);
      setLevels(initialLevels);
      syncGains();

      const firstBuf = buffersRef.current.values().next().value;
      if (firstBuf) setDuration(firstBuf.duration);
    })();

    return () => {
      cancelled = true;
    };
  }, [tracks, stopSources, ensureMasterChain, syncGains]);

  // rAF loop: read the shared AudioContext clock (no drift correction needed)
  useEffect(() => {
    if (!isPlaying) return;

    const tick = () => {
      const ctx = ctxRef.current;
      if (ctx && playingRef.current) {
        const t = computeTrackPosition(
          offsetRef.current,
          ctx.currentTime,
          startedAtRef.current,
          rateRef.current,
        );
        setCurrentTime(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  const toggleAll = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || buffersRef.current.size === 0) return;

    if (ctx.state === "suspended") ctx.resume();

    if (playingRef.current) {
      const pos = computeTrackPosition(
        offsetRef.current,
        ctx.currentTime,
        startedAtRef.current,
        rateRef.current,
      );
      offsetRef.current = pos;
      stopSources();
      playingRef.current = false;
      setIsPlaying(false);
    } else {
      startSources(offsetRef.current);
      syncGains();
      setIsPlaying(true);
    }
  }, [stopSources, startSources, syncGains]);

  const playSolo = useCallback(
    (name: string) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();

      const next = new Set(soloRef.current);
      const nowSoloed = !next.has(name);
      if (nowSoloed) next.add(name);
      else next.delete(name);
      soloRef.current = next;
      setSolo(next);

      if (nowSoloed) {
        mutedRef.current = { ...mutedRef.current, [name]: false };
        setMuted({ ...mutedRef.current });
      }

      syncGains();

      if (!playingRef.current) {
        startSources(offsetRef.current);
        syncGains();
        setIsPlaying(true);
      }
    },
    [syncGains, startSources],
  );

  const toggleMute = useCallback(
    (name: string) => {
      const wasMuted = mutedRef.current[name] ?? false;
      mutedRef.current = { ...mutedRef.current, [name]: !wasMuted };
      setMuted({ ...mutedRef.current });

      if (!wasMuted && soloRef.current.has(name)) {
        const next = new Set(soloRef.current);
        next.delete(name);
        soloRef.current = next;
        setSolo(next);
      }

      syncGains();
    },
    [syncGains],
  );

  /** Continuous per-stem blend (0..1.5). This is the real-time "dosage" fader. */
  const setLevel = useCallback(
    (name: string, level: number) => {
      const clamped = Math.max(0, Math.min(1.5, level));
      levelsRef.current = { ...levelsRef.current, [name]: clamped };
      setLevels({ ...levelsRef.current });
      syncGains();
    },
    [syncGains],
  );

  /** Master-bus vocal reduction via L-R phase cancellation, crossfaded 0..1. */
  const setVocalReduction = useCallback((amount: number) => {
    const clamped = Math.max(0, Math.min(1, amount));
    setVocalReductionState(clamped);
    if (
      dryGainLRef.current &&
      dryGainRRef.current &&
      wetGainLRef.current &&
      wetGainRRef.current
    ) {
      dryGainLRef.current.gain.value = 1 - clamped;
      dryGainRRef.current.gain.value = 1 - clamped;
      wetGainLRef.current.gain.value = clamped;
      wetGainRRef.current.gain.value = clamped;
    }
  }, []);

  /** Master-bus 3-band kill EQ, in dB (-30..+6 typical DJ mixer range). */
  const setBandGain = useCallback((band: keyof BandGains, dB: number) => {
    setBandGainsState((prev) => ({ ...prev, [band]: dB }));
    const filter =
      band === "low"
        ? lowFilterRef.current
        : band === "mid"
          ? midFilterRef.current
          : highFilterRef.current;
    if (filter) filter.gain.value = dB;
  }, []);

  /** Applies a genre-style DSP preset to one stem, in place — no reconnection. */
  const setStyle = useCallback((name: string, style: StyleId) => {
    setStyles((prev) => ({ ...prev, [name]: style }));
    styleChainsRef.current.get(name)?.setPreset(getStylePreset(style));
  }, []);

  /** Applies a genre-style DSP preset to the whole mix (master bus). */
  const setMasterStyle = useCallback((style: StyleId) => {
    setMasterStyleState(style);
    masterStyleChainRef.current?.setPreset(getStylePreset(style));
  }, []);

  /**
   * Shared logic for both stretch modes: freezes the current position under
   * the old rate/mode, switches to the new rate/mode, then re-routes every
   * active source accordingly. Sources stay perfectly synced since every
   * stem gets the same rate and routing at the same instant.
   */
  const applyStretch = useCallback(
    (mode: StretchMode, rate: number) => {
      const ctx = ctxRef.current;
      const clamped = Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, rate));

      if (ctx && playingRef.current) {
        const pos = computeTrackPosition(
          offsetRef.current,
          ctx.currentTime,
          startedAtRef.current,
          rateRef.current,
        );
        offsetRef.current = pos;
        startedAtRef.current = ctx.currentTime;
      }

      rateRef.current = clamped;
      modeRef.current = mode;

      if (mode === "tempo") setTempoState(clamped);
      else setTimeStretchState(clamped);
      setStretchModeState(mode);

      // Re-route every currently playing source to match the new mode —
      // this is the same "freeze and restart" trick used elsewhere, since
      // switching between direct-to-gain and through-SoundTouch requires
      // reconnecting the graph, not just tweaking a value.
      if (playingRef.current) {
        startSources(offsetRef.current);
      }
    },
    [startSources],
  );

  /** Vinyl-style speed: pitch follows speed, exactly like a turntable's pitch fader. */
  const setTempo = useCallback(
    (rate: number) => applyStretch("tempo", rate),
    [applyStretch],
  );

  /** True time-stretch: speed changes, pitch stays exactly as recorded. */
  const setTimeStretch = useCallback(
    (rate: number) => applyStretch("timestretch", rate),
    [applyStretch],
  );

  /** Toggles whole-track looping. Takes effect on the next natural end-of-track. */
  const toggleLoop = useCallback(() => {
    loopRef.current = !loopRef.current;
    setLoopState(loopRef.current);
  }, []);

  const seek = useCallback(    (time: number) => {
      if (playingRef.current) {
        startSources(time);
        syncGains();
      } else {
        offsetRef.current = time;
      }
      setCurrentTime(time);
    },
    [startSources, syncGains],
  );

  return {
    isPlaying,
    currentTime,
    duration,
    muted,
    solo,
    levels,
    vocalReduction,
    bandGains,
    tempo,
    timeStretch,
    stretchMode,
    styles,
    masterStyle,
    loop,
    toggleAll,
    playSolo,
    toggleMute,
    setLevel,
    setVocalReduction,
    setBandGain,
    setTempo,
    setTimeStretch,
    setStyle,
    setMasterStyle,
    toggleLoop,
    seek,
  };
}

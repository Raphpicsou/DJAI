import { useCallback, useEffect, useRef, useState } from "react";

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

export interface MultiTrackPlayer {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  muted: Record<string, boolean>;
  solo: string | null;
  levels: Record<string, number>; // 0..1.5, continuous blend per stem
  vocalReduction: number; // 0..1 — master-bus phase-cancellation vocal reduction
  bandGains: BandGains; // master-bus 3-band kill EQ, in dB
  toggleAll: () => void;
  playSolo: (name: string) => void;
  toggleMute: (name: string) => void;
  setLevel: (name: string, level: number) => void;
  setVocalReduction: (amount: number) => void;
  setBandGain: (band: keyof BandGains, dB: number) => void;
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
  solo: string | null,
): number {
  const level = levels[name] ?? 1;
  const audible = solo !== null ? name === solo : !(muted[name] ?? false);
  return audible ? level : 0;
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

  const rafRef = useRef(0);

  // Mute/solo/level refs (source of truth)
  const mutedRef = useRef<Record<string, boolean>>({});
  const soloRef = useRef<string | null>(null);
  const levelsRef = useRef<Record<string, number>>({});

  // React state for rendering
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [solo, setSolo] = useState<string | null>(null);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [vocalReduction, setVocalReductionState] = useState(0);
  const [bandGains, setBandGainsState] = useState<BandGains>(DEFAULT_BAND_GAINS);

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
    highFilter.connect(ctx.destination);

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
        source.connect(gainsRef.current.get(name)!);
        source.start(0, offset);
        sourcesRef.current.set(name, source);
      }

      const firstSource = sourcesRef.current.values().next().value;
      if (firstSource) {
        firstSource.onended = () => {
          if (playingRef.current) {
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

    playingRef.current = false;
    offsetRef.current = 0;
    startedAtRef.current = 0;
    mutedRef.current = {};
    soloRef.current = null;
    levelsRef.current = {};

    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setMuted({});
    setSolo(null);
    setLevels({});

    if (!tracks || tracks.length === 0) return;

    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    const ctx = ctxRef.current;
    ensureMasterChain(ctx);

    let cancelled = false;

    (async () => {
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
        const t =
          offsetRef.current + (ctx.currentTime - startedAtRef.current);
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
      const elapsed = ctx.currentTime - startedAtRef.current;
      offsetRef.current = offsetRef.current + elapsed;
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

      const newSolo = soloRef.current === name ? null : name;
      soloRef.current = newSolo;
      setSolo(newSolo);

      if (newSolo) {
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

      if (!wasMuted && soloRef.current === name) {
        soloRef.current = null;
        setSolo(null);
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

  const seek = useCallback(
    (time: number) => {
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
    toggleAll,
    playSolo,
    toggleMute,
    setLevel,
    setVocalReduction,
    setBandGain,
    seek,
  };
}

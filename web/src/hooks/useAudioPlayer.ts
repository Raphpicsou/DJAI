import { useCallback, useEffect, useRef, useState } from "react";

export interface AudioPlayer {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  loop: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  toggleLoop: () => void;
  seek: (time: number) => void;
}

/**
 * Manages an HTMLAudioElement tied to a blob URL.
 * Provides play/pause/seek and a smooth `currentTime` driven by rAF.
 */
export function useAudioPlayer(audioUrl: string | null): AudioPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef(0);
  const loopRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(false);

  // Create / tear-down the audio element when the URL changes
  useEffect(() => {
    if (!audioUrl) {
      audioRef.current = null;
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    const audio = new Audio(audioUrl);
    audio.loop = loopRef.current;
    audioRef.current = audio;

    const onMeta = () => setDuration(audio.duration);
    const onEnded = () => setIsPlaying(false);

    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.pause();
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnded);
      audio.src = "";
    };
  }, [audioUrl]);

  // rAF loop — only ticks while playing
  useEffect(() => {
    if (!isPlaying) return;

    const tick = () => {
      if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  const play = useCallback(() => {
    audioRef.current?.play();
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    if (audioRef.current?.paused) {
      audioRef.current.play();
      setIsPlaying(true);
    } else {
      audioRef.current?.pause();
      setIsPlaying(false);
    }
  }, []);

  const seek = useCallback((t: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = t;
      setCurrentTime(t);
    }
  }, []);

  const toggleLoop = useCallback(() => {
    const next = !loopRef.current;
    loopRef.current = next;
    setLoopState(next);
    if (audioRef.current) audioRef.current.loop = next;
  }, []);

  return { isPlaying, currentTime, duration, loop, play, pause, toggle, toggleLoop, seek };
}

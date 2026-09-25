import { formatTime as fmt } from "../dsp/format";

interface Props {
  fileName: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  loop: boolean;
  onToggle: () => void;
  onToggleLoop: () => void;
}

export function PlayerControls({
  fileName,
  isPlaying,
  currentTime,
  duration,
  loop,
  onToggle,
  onToggleLoop,
}: Props) {
  return (
    <div className="controls">
      <button
        className="play-btn"
        onClick={onToggle}
        title={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="3" width="4" height="18" rx="1" />
            <rect x="15" y="3" width="4" height="18" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6,3 20,12 6,21" />
          </svg>
        )}
      </button>

      <button
        className={`loop-btn ${loop ? "loop-btn--active" : ""}`}
        onClick={onToggleLoop}
        title={loop ? "Désactiver la boucle" : "Activer la boucle"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11V9a4 4 0 014-4h14" />
          <path d="M7 22l-4-4 4-4" />
          <path d="M21 13v2a4 4 0 01-4 4H3" />
        </svg>
      </button>

      <div className="track-info">
        <span className="track-name">{fileName}</span>
      </div>

      <div className="time-display">
        <span>{fmt(currentTime)}</span>
        <span className="sep">/</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  );
}

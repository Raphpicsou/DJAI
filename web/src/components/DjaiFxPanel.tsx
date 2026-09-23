import type { MultiTrackPlayer } from "../hooks/useMultiTrackPlayer";
import type { BandGains } from "../hooks/useMultiTrackPlayer";
import { STYLE_IDS, STYLE_LABELS } from "../audio/styleProcessor";

interface Props {
  player: MultiTrackPlayer;
}

/**
 * DJAI's master-bus effects: two classic DJ-mixer tricks layered on top of
 * the real ML-separated stems, for extra creative control without needing
 * to re-run separation:
 *   - Vocal reduction: the old L-R phase-cancellation karaoke trick.
 *   - 3-band kill EQ: cut a whole band hard, the way a club mixer does.
 * These apply to the combined output of whatever stems are currently
 * audible, not to any single stem.
 */
export function DjaiFxPanel({ player }: Props) {
  const band = (key: keyof BandGains, label: string) => (
    <div className="djai-fx__band" key={key}>
      <span className="djai-fx__band-label">{label}</span>
      <input
        type="range"
        min={-30}
        max={6}
        step={1}
        value={player.bandGains[key]}
        onChange={(e) => player.setBandGain(key, Number(e.target.value))}
        aria-label={label}
      />
      <span className="djai-fx__band-value">
        {player.bandGains[key] > 0 ? "+" : ""}
        {player.bandGains[key]} dB
      </span>
    </div>
  );

  return (
    <div className="djai-fx">
      <div className="djai-fx__section">
        <span className="djai-fx__title">Style — morceau entier</span>
        <span className="djai-fx__hint">Effets DSP, pas de l'IA générative</span>
        <select
          className={`djai-fx__style-select ${player.masterStyle !== "none" ? "djai-fx__style-select--active" : ""}`}
          value={player.masterStyle}
          onChange={(e) => player.setMasterStyle(e.target.value as typeof player.masterStyle)}
          aria-label="Style du morceau entier"
        >
          {STYLE_IDS.map((id) => (
            <option key={id} value={id}>
              {STYLE_LABELS[id]}
            </option>
          ))}
        </select>
      </div>

      <div className="djai-fx__section">
        <span className="djai-fx__title">Réduction voix</span>
        <span className="djai-fx__hint">Annulation de phase (L−R)</span>
        <div className="djai-fx__row">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(player.vocalReduction * 100)}
            onChange={(e) => player.setVocalReduction(Number(e.target.value) / 100)}
            aria-label="Réduction voix"
          />
          <span className="djai-fx__row-value">
            {Math.round(player.vocalReduction * 100)}%
          </span>
        </div>
      </div>

      <div className="djai-fx__section">
        <span className="djai-fx__title">EQ 3 bandes (kill EQ)</span>
        <span className="djai-fx__hint">Technique club — coupe une bande</span>
        <div className="djai-fx__bands">
          {band("low", "Graves")}
          {band("mid", "Médiums")}
          {band("high", "Aigus")}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { getModels, type ModelVariant, type StemId, type SelectedModel } from "../models/registry";
import { useModelDownload, type DownloadState } from "../models/useModelDownload";
import { formatTime as fmt } from "../dsp/format";

interface Props {
  onRun: (model: SelectedModel) => void;
  disabled?: boolean;
  clipRange?: [number, number] | null;
}

function ModelOption({
  variant,
  selected,
  downloadState,
  onClick,
}: {
  variant: ModelVariant;
  selected: boolean;
  downloadState: DownloadState;
  onClick: () => void;
}) {
  const cached = downloadState.status === "cached";
  const downloading = downloadState.status === "downloading";

  return (
    <button
      className={`model-option ${selected ? "model-option--selected" : ""}`}
      onClick={onClick}
      title={variant.description}
    >
      <span className="model-option__label">{variant.label}</span>
      <span
        className={`model-option__meta ${cached ? "model-option__meta--ready" : ""} ${downloadState.status === "error" ? "model-option__meta--error" : ""}`}
      >
        {downloadState.status === "checking" && "…"}
        {downloadState.status === "not-downloaded" && `${variant.sizeMb} MB`}
        {downloading &&
          (() => {
            const progress = (downloadState as Extract<DownloadState, { status: "downloading" }>).progress;
            return progress !== null ? `${Math.round(progress * 100)}%` : "…";
          })()}
        {cached && "✓"}
        {downloadState.status === "error" && "⚠"}
      </span>
    </button>
  );
}

function StemChips({
  stems,
  selected,
  onToggle,
}: {
  stems: StemId[];
  selected: StemId[];
  onToggle: (stem: StemId) => void;
}) {
  return (
    <div className="stem-chips">
      <span className="stem-chips__label">Stems</span>
      <div className="stem-chips__list">
        {stems.map((stem) => (
          <button
            key={stem}
            className={`stem-chip ${selected.includes(stem) ? "stem-chip--active" : ""}`}
            onClick={() => onToggle(stem)}
          >
            {stem}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ModelSidebar({ onRun, disabled = false, clipRange = null }: Props) {
  const models = getModels();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStems, setSelectedStems] = useState<StemId[]>([]);

  // Download hooks for each model
  const dl0 = useModelDownload(models[0].id);
  const dl1 = useModelDownload(models[1].id);
  const dl2 = useModelDownload(models[2].id);
  const downloads = [dl0, dl1, dl2];

  const selectedVariant = models.find((m) => m.id === selectedId) ?? null;
  const selectedIdx = models.findIndex((m) => m.id === selectedId);
  const selectedDl = selectedIdx >= 0 ? downloads[selectedIdx] : null;

  // When model selection changes, reset stems to all
  useEffect(() => {
    if (selectedVariant) {
      setSelectedStems([...selectedVariant.stems]);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCardClick = (idx: number) => {
    const model = models[idx];
    setSelectedId(model.id);

    // Auto-start download if not cached
    const dl = downloads[idx];
    if (dl.state.status === "not-downloaded" || dl.state.status === "error") {
      dl.start();
    }
  };

  const handleStemToggle = (stem: StemId) => {
    setSelectedStems((prev) => {
      // Don't allow deselecting the last stem
      if (prev.includes(stem) && prev.length === 1) return prev;
      return prev.includes(stem)
        ? prev.filter((s) => s !== stem)
        : [...prev, stem];
    });
  };

  const canRun =
    !disabled &&
    selectedVariant !== null &&
    selectedDl?.state.status === "cached" &&
    selectedStems.length > 0;

  return (
    <aside className="model-sidebar">
      <h3 className="model-sidebar__heading">Model</h3>

      <div className="model-sidebar__cards">
        {models.map((variant, i) => (
          <ModelOption
            key={variant.id}
            variant={variant}
            selected={selectedId === variant.id}
            downloadState={downloads[i].state}
            onClick={() => handleCardClick(i)}
          />
        ))}
      </div>

      {selectedVariant?.id === "htdemucs_ft" && (
        <div className="model-sidebar__stems">
          <StemChips
            stems={selectedVariant.stems}
            selected={selectedStems}
            onToggle={handleStemToggle}
          />
        </div>
      )}

      <button
        className="run-btn"
        disabled={!canRun}
        onClick={() => {
          if (selectedVariant) {
            onRun({ variant: selectedVariant, stems: selectedStems });
          }
        }}
      >
        {clipRange
          ? `Run separation (${fmt(clipRange[0])} – ${fmt(clipRange[1])})`
          : "Run separation"}
      </button>
    </aside>
  );
}

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff, PatchDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({
  card,
  hostContext,
  errorMessage = null,
}: PayloadRendererOptions) {
  const patch = card.payload?.patch;
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const files = useMemo(() => parseFiles(patch), [patch]);
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());
  const [showFullDiff, setShowFullDiff] = useState(false);

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);

  return (
    <div className="review-diff">
      <div className="review-diff-toolbar">
        <button
          type="button"
          className="review-action"
          onClick={() => setShowFullDiff((value) => !value)}
        >
          {showFullDiff ? "Hide full diff" : "View full diff"}
        </button>
      </div>

      {showFullDiff ? (
        <PatchDiff patch={patch} options={options} className="pierre-diff" />
      ) : (
        <div className="review-diff-files">
          {files.map((fileDiff, index) => {
            const key = fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
            const isOpen = openFiles.has(key);

            return (
              <div className="review-diff-file" key={key}>
                <button
                  type="button"
                  className="review-diff-file-toggle"
                  aria-expanded={isOpen}
                  onClick={() => {
                    const next = new Set(openFiles);
                    if (next.has(key)) {
                      next.delete(key);
                    } else {
                      next.add(key);
                    }
                    setOpenFiles(next);
                  }}
                >
                  <span className="review-diff-file-name">{fileDiff.name}</span>
                  <span className="review-diff-file-type">{fileDiff.type}</span>
                </button>
                {isOpen ? (
                  <FileDiff fileDiff={fileDiff} options={options} className="pierre-diff" />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function parseFiles(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
}

function diffOptions(themeType: ThemeType): FileDiffOptions<undefined> {
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    themeType,
    diffStyle: "unified",
    diffIndicators: "bars",
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
  };
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}

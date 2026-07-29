import { useEffect, useRef } from 'react';

interface TranscriptViewerProps {
  transcript: string;
  /**
   * Index of the block to highlight and scroll to — a checkpoint's evidence,
   * located by the server (services/evidence-locator.ts). Block indices are the
   * non-blank lines of the stored transcript, split exactly as below, so the
   * two agree.
   */
  highlightIndex?: number | null;
}

export function TranscriptViewer({ transcript, highlightIndex }: TranscriptViewerProps) {
  const lines = transcript.split('\n').filter((line) => line.trim());
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // Bring the quoted passage into view when arriving from the review queue.
  // Scoped to the transcript's own scroll container (block: 'nearest'), so the
  // page around it doesn't jump.
  useEffect(() => {
    if (highlightIndex == null) return;
    highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightIndex]);

  return (
    <div className="overflow-y-auto flex-1 min-h-0 max-h-[75vh] lg:max-h-none px-5 py-4">
      {lines.map((line, i) => {
        const isAgent = line.startsWith('Agent:');
        const isCustomer = line.startsWith('Customer:');
        const speaker = isAgent ? 'Agent' : isCustomer ? 'Customer' : null;
        const text = speaker ? line.slice(speaker.length + 1).trim() : line;
        const isHighlight = highlightIndex === i;

        return (
          <div
            key={i}
            ref={isHighlight ? highlightRef : undefined}
            className={`py-1.5 text-table-cell leading-relaxed text-text-cell ${
              isHighlight
                ? 'bg-review-bg -mx-2 px-2 rounded-btn border-l-2 border-l-review text-text-primary'
                : ''
            }`}
          >
            {speaker && (
              <span
                className={`font-semibold mr-1.5 ${
                  isAgent ? 'text-speaker-agent' : 'text-speaker-customer'
                }`}
              >
                {speaker}:
              </span>
            )}
            {text}
            {isHighlight && <span className="sr-only"> (the passage you came here to check)</span>}
          </div>
        );
      })}
    </div>
  );
}

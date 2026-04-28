interface TranscriptViewerProps {
  transcript: string;
}

export function TranscriptViewer({ transcript }: TranscriptViewerProps) {
  const lines = transcript.split('\n').filter((line) => line.trim());

  return (
    <div className="overflow-y-auto max-h-[430px] px-5 py-4">
      {lines.map((line, i) => {
        const isAgent = line.startsWith('Agent:');
        const isCustomer = line.startsWith('Customer:');
        const speaker = isAgent ? 'Agent' : isCustomer ? 'Customer' : null;
        const text = speaker ? line.slice(speaker.length + 1).trim() : line;

        return (
          <div key={i} className="py-1.5 text-table-cell leading-relaxed text-text-cell">
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
          </div>
        );
      })}
    </div>
  );
}

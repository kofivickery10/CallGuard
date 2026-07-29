import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { formatClock } from '../lib/format';

interface AudioPlayerProps {
  callId: string;
  /**
   * Second to start from — the moment a checkpoint's evidence was said. The
   * recording is fetched on first play, so this is applied once the audio's
   * metadata is available, and "Replay from quote" returns to it.
   */
  startAt?: number | null;
  /** Label for the seek slider, e.g. the checkpoint being reviewed. */
  label?: string;
  /**
   * Known length of the call, so the slider is to scale before the file has
   * been fetched (the audio element only reports its own duration once loaded).
   */
  duration?: number | null;
  className?: string;
}

/**
 * Plays a call's recording inline. The audio endpoint is auth-gated and serves
 * the decrypted file in one response (no range requests), so the file is
 * fetched as a blob on first play rather than streamed by the <audio> element —
 * which is also what lets us seek straight to a quote.
 */
export function AudioPlayer({
  callId,
  startAt,
  label,
  duration: knownDuration,
  className = '',
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(startAt ?? 0);
  const [duration, setDuration] = useState(knownDuration ?? 0);

  // The cue point can arrive after the player has rendered (the caller is still
  // resolving where the quote sits), so follow it until the audio is loaded —
  // after that the element's own position is the truth.
  useEffect(() => {
    if (!audioRef.current) setPosition(startAt ?? 0);
  }, [startAt]);

  // Release the blob when the player goes away (a queue of these would
  // otherwise hold every recording the reviewer opened in memory).
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const load = async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current;
    setLoading(true);
    setError(null);
    try {
      const url = await api.objectUrl(`/calls/${callId}/audio`);
      urlRef.current = url;
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.addEventListener('timeupdate', () => setPosition(audio.currentTime));
      audio.addEventListener('durationchange', () => {
        if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      });
      audio.addEventListener('play', () => setPlaying(true));
      audio.addEventListener('pause', () => setPlaying(false));
      audio.addEventListener('ended', () => setPlaying(false));
      audio.addEventListener('error', () => setError('The recording could not be played.'));
      await new Promise<void>((resolve) => {
        if (audio.readyState >= 1) return resolve();
        audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
        // Never leave the reviewer on a spinner if metadata never arrives —
        // playback can still work without a known duration.
        audio.addEventListener('error', () => resolve(), { once: true });
      });
      if (startAt != null && startAt > 0) audio.currentTime = startAt;
      audioRef.current = audio;
      setReady(true);
      return audio;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The recording could not be loaded.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    const audio = audioRef.current ?? (await load());
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const seek = (seconds: number) => {
    setPosition(seconds);
    if (audioRef.current) audioRef.current.currentTime = seconds;
  };

  const replayFromQuote = async () => {
    const audio = audioRef.current ?? (await load());
    if (!audio) return;
    audio.currentTime = startAt ?? 0;
    setPosition(startAt ?? 0);
    void audio.play();
  };

  if (error) {
    return (
      <div className={`text-xs text-fail bg-fail-bg rounded-btn px-2.5 py-1.5 ${className}`} role="alert">
        {error}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {loading ? (
          <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
        ) : playing ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M9 5v14M15 5v14" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 ml-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5l12 7.5-12 7.5z" />
          </svg>
        )}
      </button>

      <input
        type="range"
        min={0}
        max={duration || Math.max(position, 1)}
        step={0.5}
        value={position}
        disabled={!ready}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label={label ? `Seek within the recording — ${label}` : 'Seek within the recording'}
        className="flex-1 min-w-[100px] h-1.5 accent-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full"
      />

      <span className="shrink-0 text-xs text-text-muted tabular-nums">
        {formatClock(position)}
        {duration > 0 ? ` / ${formatClock(duration)}` : ''}
      </span>

      {startAt != null && startAt > 0 && (
        <button
          type="button"
          onClick={replayFromQuote}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-text-muted hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          title={`Play again from ${formatClock(startAt)}, where the quote was said`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
          </svg>
          From quote
        </button>
      )}
    </div>
  );
}

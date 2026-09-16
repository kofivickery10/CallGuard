#!/usr/bin/env bash
# Probe call recordings before ingest: format, channel count, whether a stereo
# file is genuinely split (one speaker per channel) or just mono duplicated,
# and which channel carries the adviser.
#
# Usage: ./scripts/probe-audio.sh /path/to/*.wav
#
# Reads the tenant settings that matter:
#   transcription_mode  stereo_multichannel (true split) | mono_diarize (everything else)
#   adviser_channel     0 = left, 1 = right, null = auto-detect
#
# Deepgram bills multichannel per channel, so a duplicated-stereo file sent as
# multichannel costs about twice what it should and gains nothing.

set -uo pipefail

for f in "$@"; do
  [ -f "$f" ] || { echo "skip (not a file): $f"; continue; }
  echo "==================================================================="
  echo "FILE: $f"

  read -r codec ch rate dur < <(ffprobe -v error -select_streams a:0 \
    -show_entries stream=codec_name,channels,sample_rate:format=duration \
    -of default=nw=1:nk=1 "$f" | paste -sd' ' -)

  printf "  codec=%s  channels=%s  sample_rate=%s Hz  duration=%.1fs\n" \
    "$codec" "$ch" "$rate" "$dur"

  if [ "$ch" != "2" ]; then
    echo "  VERDICT: mono. Use transcription_mode = mono_diarize."
    echo "           Speaker separation comes from diarisation, so check"
    echo "           mono_first_speaker matches who talks first."
    continue
  fi

  # Difference signal: if L and R are identical this is near digital silence.
  diff_db=$(ffmpeg -v error -i "$f" -af "pan=mono|c0=0.5*c0-0.5*c1,volumedetect" \
    -f null - 2>&1 | awk -F': ' '/mean_volume/{print $2}' | awk '{print $1}')
  l_db=$(ffmpeg -v error -i "$f" -af "pan=mono|c0=c0,volumedetect" \
    -f null - 2>&1 | awk -F': ' '/mean_volume/{print $2}' | awk '{print $1}')
  r_db=$(ffmpeg -v error -i "$f" -af "pan=mono|c0=c1,volumedetect" \
    -f null - 2>&1 | awk -F': ' '/mean_volume/{print $2}' | awk '{print $1}')

  printf "  mean level  L=%s dB  R=%s dB  (L-R difference=%s dB)\n" \
    "$l_db" "$r_db" "$diff_db"

  is_dup=$(awk -v d="$diff_db" 'BEGIN{print (d=="" || d < -60) ? 1 : 0}')
  if [ "$is_dup" = "1" ]; then
    echo "  VERDICT: stereo container, duplicated content. Treat as MONO."
    echo "           transcription_mode = mono_diarize. Sending this as"
    echo "           multichannel doubles the Deepgram bill for nothing."
    continue
  fi

  echo "  VERDICT: two distinct channels. Likely true split-stereo."
  echo "  Who speaks first (first 20s, per channel):"
  for c in 0 1; do
    first=$(ffmpeg -v error -i "$f" -t 20 -af "pan=mono|c0=c$c,silencedetect=n=-35dB:d=0.4" \
      -f null - 2>&1 | awk -F': ' '/silence_end/{print $2; exit}' | awk '{print $1}')
    printf "    channel %s: first speech at %ss\n" "$c" "${first:-0 (talking from the start)}"
  done
  echo "  Listen to 10s of each to confirm which is the adviser:"
  echo "    ffplay -v error -af \"pan=mono|c0=c0\" -t 10 \"$f\"   # channel 0 / left"
  echo "    ffplay -v error -af \"pan=mono|c0=c1\" -t 10 \"$f\"   # channel 1 / right"
  echo "  Then set transcription_mode = stereo_multichannel and adviser_channel"
  echo "  to whichever channel is the adviser."
done

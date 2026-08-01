#!/usr/bin/env python
"""Transcribe a video/audio file (local path or URL) to timed, speaker-labelled cues.

Usage:  python transcribe.py <path-or-url> [model] [num_speakers]
Prints one JSON object to stdout:
  {"language","duration","segments":[{start,end,text,speaker}], ...}

- Audio is decoded tolerantly with PyAV: undecodable packets (e.g. malformed AAC)
  are skipped and left as silence, and good frames are placed by their timestamp so
  the timeline stays correct even when parts of the stream can't be decoded.
- Whisper (faster-whisper) transcribes with word timestamps; words are regrouped
  into sentence-level cues.
- Speakers are separated with MFCC features + agglomerative clustering (no external
  models / tokens needed). Labels are "Speaker 1", "Speaker 2", ... in first-seen order.
"""
import sys, json, re
import numpy as np
import av
from faster_whisper import WhisperModel

RATE = 16000
SENT_END = re.compile(r"[.!?…]+[\"')\]]*\s*$")


def extract_audio(path):
    container = av.open(path)
    stream = container.streams.audio[0]
    if stream.duration:
        dur = float(stream.duration * stream.time_base)
    elif container.duration:
        dur = float(container.duration / 1e6)
    else:
        dur = 0.0
    buf = np.zeros(int(dur * RATE) + RATE, dtype=np.float32)
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=RATE)
    good = bad = 0
    last_t = 0.0
    for packet in container.demux(stream):
        try:
            for frame in packet.decode():
                t = float(frame.time) if frame.time is not None else last_t
                for rf in resampler.resample(frame):
                    a = rf.to_ndarray().astype(np.float32).flatten() / 32768.0
                    pos = int(t * RATE)
                    end = min(pos + len(a), len(buf))
                    if 0 <= pos < len(buf):
                        buf[pos:end] = a[: end - pos]
                    t += len(a) / RATE
                    last_t = t
                good += 1
        except Exception:
            bad += 1
            continue
    container.close()
    return buf, dur, good, bad


def to_sentences(words):
    """Regroup Whisper word objects into sentence-level cues."""
    cues, cur = [], []
    for w in words:
        cur.append(w)
        if SENT_END.search(w.word):
            cues.append(cur)
            cur = []
    if cur:
        cues.append(cur)
    out = []
    for group in cues:
        text = "".join(w.word for w in group).strip()
        if text:
            out.append({"start": round(group[0].start, 3), "end": round(group[-1].end, 3), "text": text})
    return out


def diarize(audio, cues, num_speakers):
    """Assign a speaker to each cue via MFCC features + agglomerative clustering.

    num_speakers <= 0 auto-detects the count (2..6) by silhouette score.
    """
    if len(cues) < 2:
        for c in cues:
            c["speaker"] = "Speaker 1"
        return cues
    try:
        import librosa
        from sklearn.cluster import AgglomerativeClustering
        from sklearn.preprocessing import StandardScaler
        from sklearn.metrics import silhouette_score
        feats = []
        for c in cues:
            a = audio[int(c["start"] * RATE):int(c["end"] * RATE)]
            if len(a) < RATE // 10:  # pad very short cues
                a = np.pad(a, (0, RATE // 10 - len(a)))
            mfcc = librosa.feature.mfcc(y=a, sr=RATE, n_mfcc=20)
            feats.append(np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1)]))
        X = StandardScaler().fit_transform(np.array(feats))
        if num_speakers and num_speakers > 0:
            k = min(num_speakers, len(cues))
            labels = AgglomerativeClustering(n_clusters=k).fit_predict(X)
        else:
            best = None
            for k in range(2, min(6, len(cues)) + 1):
                lab = AgglomerativeClustering(n_clusters=k).fit_predict(X)
                try:
                    score = silhouette_score(X, lab)
                except Exception:
                    continue
                if best is None or score > best[0]:
                    best = (score, lab)
            labels = best[1] if best else [0] * len(cues)
    except Exception:
        labels = [0] * len(cues)
    # relabel in first-seen order -> Speaker 1, Speaker 2, ...
    mapping = {}
    for lab in labels:
        if lab not in mapping:
            mapping[lab] = f"Speaker {len(mapping) + 1}"
    for c, lab in zip(cues, labels):
        c["speaker"] = mapping[lab]
    return cues


def main():
    src = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"
    num_speakers = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    audio, dur, good, bad = extract_audio(src)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, vad_filter=True, language="en", word_timestamps=True)
    words = []
    for s in segments:
        if s.words:
            words.extend(s.words)
    cues = to_sentences(words)
    cues = diarize(audio, cues, num_speakers)
    print(json.dumps({
        "language": info.language,
        "duration": round(dur, 3),
        "model": model_size,
        "decoded_frames": good,
        "undecodable_frames": bad,
        "segments": cues,
    }))


if __name__ == "__main__":
    main()

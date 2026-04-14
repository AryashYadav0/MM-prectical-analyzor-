import { useState, useEffect, useRef, useCallback } from "react";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToNote(freq: number) {
  if (freq <= 0) return { note: "-", octave: 0, cents: 0 };
  const semitones = 12 * Math.log2(freq / 440);
  const rounded = Math.round(semitones);
  const noteIndex = ((rounded % 12) + 12 + 9) % 12;
  const octave = Math.floor((rounded + 9) / 12) + 4;
  const cents = Math.round((semitones - rounded) * 100);
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  const SIZE = buf.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);
  let best_offset = -1, best_correlation = 0, rms = 0, lastCorrelation = 1;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;
  for (let offset = 0; offset < MAX_SAMPLES; offset++) {
    let correlation = 0;
    for (let i = 0; i < MAX_SAMPLES; i++) correlation += Math.abs(buf[i] - buf[i + offset]);
    correlation = 1 - correlation / MAX_SAMPLES;
    if (correlation > 0.9 && correlation > lastCorrelation && correlation > best_correlation) {
      best_correlation = correlation; best_offset = offset;
    }
    lastCorrelation = correlation;
  }
  return best_offset === -1 ? -1 : sampleRate / best_offset;
}

function rmsToDb(rms: number): number {
  if (rms < 1e-10) return -96;
  return Math.max(-96, 20 * Math.log10(rms));
}

interface DataPoint {
  time: number;
  hz: number;
  db: number;
  rms: number;
}

interface NoteEvent {
  startTime: number;
  endTime: number;
  hz: number;
  note: string;
  octave: number;
  durationMs: number;
}

interface Beat {
  time: number;
  energy: number;
}

function drawCanvasLine(
  canvas: HTMLCanvasElement,
  points: DataPoint[],
  key: "hz" | "db",
  color: string,
  glow: string,
  labelSuffix: string,
  minVal: number,
  maxVal: number,
  gridCount = 4,
  filterZero = true
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  if (points.length < 2) return;

  const maxTime = Math.max(...points.map(p => p.time));
  const valid = filterZero ? points.filter(p => (p[key] as number) > (key === "db" ? -96 : 0)) : points;
  if (valid.length === 0) return;

  const range = Math.max(maxVal - minVal, 1);
  ctx.strokeStyle = "rgba(100,116,139,0.25)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridCount; i++) {
    const y = H * 0.08 + (H * 0.84 * i) / gridCount;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    const v = Math.round(maxVal - (range * i) / gridCount);
    ctx.fillStyle = "#475569";
    ctx.font = "9px monospace";
    ctx.fillText(`${v}${labelSuffix}`, 3, y - 2);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowBlur = 8; ctx.shadowColor = glow;
  ctx.beginPath();
  let first = true;
  for (const p of points) {
    const val = p[key] as number;
    if (filterZero && val <= (key === "db" ? -96 : 0)) continue;
    const x = (p.time / Math.max(maxTime, 1)) * W;
    const y = H * 0.92 - ((val - minVal) / range) * H * 0.84;
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawBpmGraph(canvas: HTMLCanvasElement, bpmHistory: { time: number; bpm: number }[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  if (bpmHistory.length < 2) return;

  const maxTime = Math.max(...bpmHistory.map(p => p.time));
  const bpms = bpmHistory.map(p => p.bpm);
  const minBpm = Math.max(0, Math.min(...bpms) - 10);
  const maxBpm = Math.max(...bpms) + 10;
  const range = Math.max(maxBpm - minBpm, 20);

  ctx.strokeStyle = "rgba(100,116,139,0.25)";
  ctx.lineWidth = 1;
  [0, 60, 90, 120, 180].forEach(bv => {
    if (bv < minBpm || bv > maxBpm) return;
    const y = H * 0.92 - ((bv - minBpm) / range) * H * 0.84;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = "#475569"; ctx.font = "9px monospace";
    ctx.fillText(`${bv}bpm`, 3, y - 2);
  });

  ctx.strokeStyle = "#fb923c"; ctx.lineWidth = 2;
  ctx.shadowBlur = 8; ctx.shadowColor = "#fb923c";
  ctx.beginPath();
  let first = true;
  for (const p of bpmHistory) {
    const x = (p.time / Math.max(maxTime, 1)) * W;
    const y = H * 0.92 - ((p.bpm - minBpm) / range) * H * 0.84;
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawNoteDurations(canvas: HTMLCanvasElement, notes: NoteEvent[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  if (notes.length === 0) return;

  const recent = notes.slice(-20);
  const maxDur = Math.max(...recent.map(n => n.durationMs), 500);
  const barW = Math.floor((W - 16) / recent.length);

  recent.forEach((note, i) => {
    const barH = Math.max(4, ((note.durationMs / maxDur) * (H - 36)));
    const x = 8 + i * barW;
    const y = H - 20 - barH;
    const hue = ((note.hz / 1000) * 240) % 360;
    ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
    ctx.fillRect(x, y, barW - 3, barH);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "8px monospace";
    ctx.fillText(`${note.note}${note.octave}`, x, H - 6);
  });

  ctx.fillStyle = "#475569"; ctx.font = "9px monospace";
  ctx.fillText(`${(maxDur).toFixed(0)}ms`, 3, 14);
}

function drawWaveform(canvas: HTMLCanvasElement, dataArray: Float32Array) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1.5;
  ctx.shadowBlur = 6; ctx.shadowColor = "#22d3ee";
  ctx.beginPath();
  const sliceW = W / dataArray.length;
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const y = (dataArray[i] + 1) * H / 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    x += sliceW;
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

function detectTimeSignature(beats: Beat[]): string {
  if (beats.length < 4) return "?/?";
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i].time - beats[i - 1].time);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const energies = beats.map(b => b.energy);
  const maxE = Math.max(...energies);
  const threshold = maxE * 0.7;
  let strongBeats = 0, totalBeats = 0;
  for (const b of beats.slice(-8)) {
    totalBeats++;
    if (b.energy >= threshold) strongBeats++;
  }
  const ratio = strongBeats / Math.max(totalBeats, 1);
  if (avg < 400) return "4/4";
  if (ratio < 0.4) return "3/4";
  if (ratio < 0.6) return "6/8";
  return "4/4";
}

export default function AudioTracker() {
  const [isListening, setIsListening] = useState(false);
  const [currentHz, setCurrentHz] = useState(0);
  const [currentNote, setCurrentNote] = useState({ note: "-", octave: 0, cents: 0 });
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [currentDb, setCurrentDb] = useState(-96);
  const [currentBpm, setCurrentBpm] = useState(0);
  const [timeSignature, setTimeSignature] = useState("?/?");
  const [noteEvents, setNoteEvents] = useState<NoteEvent[]>([]);
  const [bpmHistory, setBpmHistory] = useState<{ time: number; bpm: number }[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [amplitude, setAmplitude] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef(new Float32Array(2048));
  const waveRef = useRef(new Float32Array(2048));
  const startTsRef = useRef(0);

  const beatsRef = useRef<Beat[]>([]);
  const lastBeatTimeRef = useRef(0);
  const energyHistRef = useRef<number[]>([]);
  const activeNoteRef = useRef<{ hz: number; startTime: number; note: string; octave: number } | null>(null);

  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const pitchCanvasRef = useRef<HTMLCanvasElement>(null);
  const dbCanvasRef = useRef<HTMLCanvasElement>(null);
  const bpmCanvasRef = useRef<HTMLCanvasElement>(null);
  const noteCanvasRef = useRef<HTMLCanvasElement>(null);

  const analyze = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    analyser.getFloatTimeDomainData(bufRef.current);
    analyser.getFloatTimeDomainData(waveRef.current);

    let rms = 0;
    for (let i = 0; i < bufRef.current.length; i++) rms += bufRef.current[i] ** 2;
    rms = Math.sqrt(rms / bufRef.current.length);

    const db = rmsToDb(rms);
    setCurrentDb(Math.round(db * 10) / 10);
    setAmplitude(Math.min(rms * 4, 1));

    const freq = autoCorrelate(bufRef.current, audioCtxRef.current!.sampleRate);
    const hz = freq > 0 ? Math.round(freq * 10) / 10 : 0;
    setCurrentHz(hz);
    const noteInfo = freqToNote(hz);
    setCurrentNote(noteInfo);

    const now = Date.now() - startTsRef.current;
    setElapsedMs(now);

    // Beat / BPM detection via onset energy
    energyHistRef.current.push(rms);
    if (energyHistRef.current.length > 43) energyHistRef.current.shift();
    const localAvg = energyHistRef.current.reduce((a, b) => a + b, 0) / energyHistRef.current.length;
    const isBeat = rms > localAvg * 1.5 && rms > 0.03 && (now - lastBeatTimeRef.current) > 250;
    if (isBeat) {
      const interval = now - lastBeatTimeRef.current;
      lastBeatTimeRef.current = now;
      beatsRef.current.push({ time: now, energy: rms });
      if (beatsRef.current.length > 32) beatsRef.current.shift();

      if (interval < 2000 && interval > 250) {
        const bpm = Math.round(60000 / interval);
        if (bpm > 20 && bpm < 300) {
          setCurrentBpm(bpm);
          setBpmHistory(prev => [...prev, { time: now, bpm }].slice(-200));
        }
      }
      const ts = detectTimeSignature(beatsRef.current);
      setTimeSignature(ts);
    }

    // Note duration tracking
    const STABLE_THRESH = 15;
    if (hz > 0) {
      if (!activeNoteRef.current) {
        activeNoteRef.current = { hz, startTime: now, note: noteInfo.note, octave: noteInfo.octave };
      } else if (Math.abs(hz - activeNoteRef.current.hz) > STABLE_THRESH) {
        const dur = now - activeNoteRef.current.startTime;
        if (dur > 80) {
          const ev: NoteEvent = {
            startTime: activeNoteRef.current.startTime,
            endTime: now,
            hz: activeNoteRef.current.hz,
            note: activeNoteRef.current.note,
            octave: activeNoteRef.current.octave,
            durationMs: dur,
          };
          setNoteEvents(prev => [...prev, ev].slice(-40));
          if (noteCanvasRef.current) drawNoteDurations(noteCanvasRef.current, [...noteCanvasRef.current.__notes ?? [], ev].slice(-20));
        }
        activeNoteRef.current = { hz, startTime: now, note: noteInfo.note, octave: noteInfo.octave };
      }
    } else {
      if (activeNoteRef.current) {
        const dur = now - activeNoteRef.current.startTime;
        if (dur > 80) {
          const ev: NoteEvent = {
            startTime: activeNoteRef.current.startTime,
            endTime: now,
            hz: activeNoteRef.current.hz,
            note: activeNoteRef.current.note,
            octave: activeNoteRef.current.octave,
            durationMs: dur,
          };
          setNoteEvents(prev => {
            const updated = [...prev, ev].slice(-40);
            if (noteCanvasRef.current) drawNoteDurations(noteCanvasRef.current, updated.slice(-20));
            return updated;
          });
        }
        activeNoteRef.current = null;
      }
    }

    setDataPoints(prev => {
      const updated = [...prev, { time: now, hz, db, rms }].slice(-500);
      if (pitchCanvasRef.current) {
        const validHz = updated.filter(p => p.hz > 0).map(p => p.hz);
        const minH = validHz.length ? Math.min(...validHz) - 20 : 50;
        const maxH = validHz.length ? Math.max(...validHz) + 20 : 1000;
        drawCanvasLine(pitchCanvasRef.current, updated, "hz", "#a78bfa", "#a78bfa", "Hz", minH, maxH, 4);
      }
      if (dbCanvasRef.current) drawCanvasLine(dbCanvasRef.current, updated, "db", "#22c55e", "#22c55e", "dB", -80, 0, 4, false);
      return updated;
    });

    setBpmHistory(prev => {
      if (bpmCanvasRef.current) drawBpmGraph(bpmCanvasRef.current, prev);
      return prev;
    });

    if (waveCanvasRef.current) drawWaveform(waveCanvasRef.current, waveRef.current);

    rafRef.current = requestAnimationFrame(analyze);
  }, []);

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      startTsRef.current = Date.now();
      beatsRef.current = [];
      lastBeatTimeRef.current = 0;
      energyHistRef.current = [];
      activeNoteRef.current = null;
      setDataPoints([]); setBpmHistory([]); setNoteEvents([]);
      setStartTime(null); setEndTime(null); setCurrentBpm(0); setTimeSignature("?/?");
      setIsListening(true);
      rafRef.current = requestAnimationFrame(analyze);
    } catch {
      alert("Microphone access denied. Please allow microphone permission.");
    }
  };

  const stopListening = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) audioCtxRef.current.close();
    setIsListening(false);
    setCurrentHz(0); setCurrentNote({ note: "-", octave: 0, cents: 0 });
    setCurrentDb(-96); setAmplitude(0);
  };

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }, []);

  useEffect(() => {
    if (noteCanvasRef.current) drawNoteDurations(noteCanvasRef.current, noteEvents.slice(-20));
  }, [noteEvents]);

  const statCards = [
    { label: "PITCH", value: currentHz > 0 ? `${currentHz}` : "---", unit: "Hz", color: "#a78bfa", border: "#2d1f5e" },
    { label: "NOTE", value: currentNote.note !== "-" ? `${currentNote.note}${currentNote.octave}` : "---", unit: currentNote.cents !== 0 ? `${currentNote.cents > 0 ? "+" : ""}${currentNote.cents}¢` : "in tune", color: "#22d3ee", border: "#1e3a5f" },
    { label: "LOUDNESS", value: currentDb > -96 ? `${currentDb}` : "---", unit: "dB", color: "#22c55e", border: "#1f3a2d" },
    { label: "TEMPO", value: currentBpm > 0 ? `${currentBpm}` : "---", unit: "BPM", color: "#fb923c", border: "#3a2a1f" },
    { label: "RHYTHM", value: timeSignature, unit: "time sig", color: "#f472b6", border: "#3a1f33" },
  ];

  const lastNote = noteEvents.length > 0 ? noteEvents[noteEvents.length - 1] : null;

  return (
    <div style={{ minHeight: "100vh", background: "#07101f", color: "#e2e8f0", fontFamily: "monospace" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "18px 14px" }}>

        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#22d3ee", letterSpacing: 2, margin: 0 }}>
            MUSIC MASTER AUDIO TRACKER
          </h1>
          <p style={{ color: "#64748b", fontSize: 12, marginTop: 3 }}>Pitch · Tempo · Rhythm · Loudness · Duration</p>
        </div>

        {/* Stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 16 }}>
          {statCards.map(s => (
            <div key={s.label} style={{ background: "#111827", border: `1px solid ${s.border}`, borderRadius: 10, padding: "12px 8px", textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 9, color: "#64748b", marginTop: 3 }}>{s.unit}</div>
            </div>
          ))}
        </div>

        {/* Amplitude bar */}
        <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, whiteSpace: "nowrap" }}>AMPLITUDE</span>
          <div style={{ flex: 1, height: 12, background: "#0f172a", borderRadius: 6, overflow: "hidden" }}>
            <div style={{
              width: `${amplitude * 100}%`, height: "100%", borderRadius: 6,
              background: amplitude > 0.7 ? "#ef4444" : amplitude > 0.4 ? "#f59e0b" : "#22c55e",
              transition: "width 0.05s, background 0.1s"
            }} />
          </div>
          <span style={{ fontSize: 10, color: "#64748b", width: 32, textAlign: "right" }}>{Math.round(amplitude * 100)}%</span>
        </div>

        {/* WAVEFORM */}
        <GraphCard label="WAVEFORM — Live Audio Signal">
          <canvas ref={waveCanvasRef} width={920} height={70}
            style={{ width: "100%", height: 70, borderRadius: 6, display: "block" }} />
        </GraphCard>

        {/* PITCH */}
        <GraphCard label="PITCH — Frequency (Hz) over Time">
          <canvas ref={pitchCanvasRef} width={920} height={110}
            style={{ width: "100%", height: 110, borderRadius: 6, display: "block" }} />
        </GraphCard>

        {/* LOUDNESS */}
        <GraphCard label="LOUDNESS — Decibels (dB) over Time">
          <canvas ref={dbCanvasRef} width={920} height={100}
            style={{ width: "100%", height: 100, borderRadius: 6, display: "block" }} />
        </GraphCard>

        {/* TEMPO */}
        <GraphCard label={`TEMPO — BPM over Time  |  RHYTHM: ${timeSignature}`}>
          <canvas ref={bpmCanvasRef} width={920} height={100}
            style={{ width: "100%", height: 100, borderRadius: 6, display: "block" }} />
        </GraphCard>

        {/* NOTE DURATION */}
        <GraphCard label={`NOTE DURATION — Length of Each Note${lastNote ? `  |  Last: ${lastNote.note}${lastNote.octave} = ${lastNote.durationMs}ms` : ""}`}>
          <canvas ref={noteCanvasRef} width={920} height={100}
            style={{ width: "100%", height: 100, borderRadius: 6, display: "block" }} />
        </GraphCard>

        {/* START / END markers */}
        <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 8 }}>SEGMENT MARKERS</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setStartTime(elapsedMs)} disabled={!isListening}
              style={{ flex: 1, padding: "7px 0", background: "#14532d", border: "1px solid #22c55e", borderRadius: 7, color: "#22c55e", fontFamily: "monospace", fontSize: 11, cursor: isListening ? "pointer" : "not-allowed", opacity: isListening ? 1 : 0.4 }}>
              Mark START [{startTime !== null ? `${(startTime / 1000).toFixed(2)}s` : "-"}]
            </button>
            <button onClick={() => setEndTime(elapsedMs)} disabled={!isListening}
              style={{ flex: 1, padding: "7px 0", background: "#450a0a", border: "1px solid #ef4444", borderRadius: 7, color: "#ef4444", fontFamily: "monospace", fontSize: 11, cursor: isListening ? "pointer" : "not-allowed", opacity: isListening ? 1 : 0.4 }}>
              Mark END [{endTime !== null ? `${(endTime / 1000).toFixed(2)}s` : "-"}]
            </button>
            <button onClick={() => { setStartTime(null); setEndTime(null); }}
              style={{ flex: 1, padding: "7px 0", background: "#1e293b", border: "1px solid #475569", borderRadius: 7, color: "#94a3b8", fontFamily: "monospace", fontSize: 11, cursor: "pointer" }}>
              Clear
            </button>
          </div>
          {startTime !== null && endTime !== null && (() => {
            const seg = dataPoints.filter(p => p.time >= startTime && p.time <= endTime);
            const validHz = seg.filter(p => p.hz > 0);
            const avgHz = validHz.length ? Math.round(validHz.reduce((a, b) => a + b.hz, 0) / validHz.length) : 0;
            const avgDb = seg.length ? Math.round(seg.reduce((a, b) => a + b.db, 0) / seg.length * 10) / 10 : 0;
            const dur = ((endTime - startTime) / 1000).toFixed(2);
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 10 }}>
                {[
                  { l: "AVG Hz", v: avgHz > 0 ? `${avgHz}` : "---" },
                  { l: "AVG dB", v: avgDb < 0 ? `${avgDb}` : "---" },
                  { l: "DURATION", v: `${dur}s` },
                  { l: "NOTES", v: `${noteEvents.filter(n => n.startTime >= startTime && n.endTime <= endTime).length}` },
                ].map(item => (
                  <div key={item.l} style={{ background: "#0f172a", borderRadius: 7, padding: "8px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: "#64748b" }}>{item.l}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9", marginTop: 2 }}>{item.v}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: 10 }}>
          {!isListening ? (
            <button onClick={startListening}
              style={{ flex: 2, padding: "13px 0", background: "linear-gradient(135deg,#0e7490,#1d4ed8)", border: "none", borderRadius: 10, color: "#fff", fontFamily: "monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
              START LISTENING
            </button>
          ) : (
            <button onClick={stopListening}
              style={{ flex: 2, padding: "13px 0", background: "linear-gradient(135deg,#7f1d1d,#991b1b)", border: "none", borderRadius: 10, color: "#fff", fontFamily: "monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
              STOP
            </button>
          )}
          <button onClick={() => {
            setDataPoints([]); setBpmHistory([]); setNoteEvents([]);
            setStartTime(null); setEndTime(null); setElapsedMs(0);
            setCurrentBpm(0); setTimeSignature("?/?");
            startTsRef.current = Date.now();
            beatsRef.current = []; energyHistRef.current = []; activeNoteRef.current = null;
          }}
            style={{ flex: 1, padding: "13px 0", background: "#1e293b", border: "1px solid #334155", borderRadius: 10, color: "#94a3b8", fontFamily: "monospace", fontSize: 12, cursor: "pointer" }}>
            CLEAR
          </button>
        </div>

        <div style={{ marginTop: 10, textAlign: "center", fontSize: 10, color: "#334155" }}>
          {isListening
            ? `Recording ${(elapsedMs / 1000).toFixed(1)}s · ${dataPoints.length} samples · ${noteEvents.length} notes detected`
            : "Press START to begin analysis"}
        </div>
      </div>
    </div>
  );
}

function GraphCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
      <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

// Extend canvas element type for note storage
declare global {
  interface HTMLCanvasElement {
    __notes?: NoteEvent[];
  }
}

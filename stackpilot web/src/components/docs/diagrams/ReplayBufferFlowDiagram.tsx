import React, { useState } from 'react';
import {
  Video,
  Layers,
  CheckCircle2,
  Database,
  Sliders,
  Play,
  RotateCcw,
  Sparkles,
  ArrowRight,
  Activity,
  Zap
} from 'lucide-react';

interface BufferStage {
  id: string;
  name: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  techDetails: string[];
  metrics: string;
}

const STAGES: BufferStage[] = [
  {
    id: 'stream',
    name: 'Incoming 60 FPS Video Stream',
    subtitle: 'H.264 Raw Video Stream',
    icon: Video,
    description: 'Raw video frames received over WebSocket from Xvfb display via FFmpeg x11grab. Emits a new frame chunk every 16.6ms.',
    techDetails: ['Format: Annex-B NALU (SPS/PPS + IDR + P-frames)', 'Framerate: 60 FPS Target', 'Bitrate: ~1.8 - 3.2 Mbps adaptive'],
    metrics: '16.6ms / frame'
  },
  {
    id: 'filter',
    name: 'Action & Throttle Filter',
    subtitle: 'FrameCheck Decision',
    icon: Sliders,
    description: 'Evaluates if an active user interaction occurred (click, scroll, keystroke) or if >65ms elapsed since the last recorded frame.',
    techDetails: ['Prevents idle static screen bloat', 'Preserves 100% of interaction transitions', 'Throttles static idle from 60 FPS to 15 FPS in buffer'],
    metrics: '>65ms OR Action'
  },
  {
    id: 'push',
    name: 'Push to recordedFramesRef',
    subtitle: 'In-Memory Ring Buffer',
    icon: Layers,
    description: 'The valid video chunk along with DOM event timestamp and coordinates is appended to React useRef circular array.',
    techDetails: ['TypedArray: Uint8Array memory chunks', 'Zero React re-render overhead (Ref-based)', 'Coupled with mouse coordinate telemetry'],
    metrics: 'Append to Array'
  },
  {
    id: 'cap',
    name: 'CapCheck (Length > 700)',
    subtitle: '700-Frame Ring Boundary',
    icon: Database,
    description: 'Checks if array exceeds 700 frames. 700 frames at dynamic rate covers ~11.6 seconds of intense action or up to 45 seconds of mixed interaction.',
    techDetails: ['Maximum Memory Cap: ~24 MB RAM', 'Prevents memory leak on multi-hour sessions', 'Zero Garbage Collection pauses'],
    metrics: 'Max 700 Elements'
  },
  {
    id: 'evict',
    name: 'buffer.shift() & Retain',
    subtitle: 'FIFO Eviction & Seek Ready',
    icon: RotateCcw,
    description: 'When length > 700, the oldest frame is popped from the front (FIFO). Otherwise, frames are immediately seekable via the UI scrubber.',
    techDetails: ['O(1) amortized ring buffer eviction', 'Instant seek to any timestamp via WebCodecs', 'Fast IDR keyframe reference resolution'],
    metrics: 'Oldest Evicted'
  }
];

export const ReplayBufferFlowDiagram: React.FC = () => {
  const [selectedStage, setSelectedStage] = useState<BufferStage>(STAGES[1]);
  const [simulatedFrame, setSimulatedFrame] = useState<number>(542);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // Time calculation from frame
  const secondsAgo = ((700 - simulatedFrame) * (11.6 / 700)).toFixed(1);

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/90 bg-[#18181b]/90 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <RotateCcw className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Time-Travel 700-Frame FIFO Ring Buffer
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            Zero-leak circular memory pipeline for instant 60 FPS visual session rewinds.
          </p>
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Activity className="w-3 h-3 text-white" />
            <span>Capacity: 700 Frames (~24MB)</span>
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Zap className="w-3 h-3 text-white" />
            <span>~11.6s Time-Travel</span>
          </span>
        </div>
      </div>

      {/* Interactive 5-Stage Pipeline */}
      <div className="space-y-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          Ring Buffer Ingestion Pipeline (Click stage to inspect)
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {STAGES.map((stage, idx) => {
            const Icon = stage.icon;
            const isSelected = selectedStage.id === stage.id;
            return (
              <div
                key={stage.id}
                onClick={() => setSelectedStage(stage)}
                className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                  isSelected
                    ? 'bg-zinc-800 text-white shadow-md'
                    : 'bg-zinc-900/70 hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400">
                    Step {idx + 1}
                  </span>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white tracking-tight leading-snug">{stage.name}</h4>
                  <p className="text-[10px] text-zinc-400 mt-0.5">{stage.subtitle}</p>
                </div>
                <div className="pt-1 flex items-center justify-between text-[10px] font-mono text-zinc-400">
                  <span className="truncate">{stage.metrics}</span>
                  <ArrowRight className="w-3 h-3 text-white shrink-0 ml-1" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Decision Flow Breakdown - Direct Flat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Gate 1 */}
        <div className="p-4 rounded-xl bg-zinc-900/80 border-0 space-y-3">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-mono font-bold text-white flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Incoming Frame Ingestion Gate
            </span>
            <span className="text-[10px] font-mono text-zinc-400">isPlaybackModeRef check</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-lg bg-emerald-950/20 border-l-2 border-emerald-500 space-y-1">
              <div className="font-semibold text-emerald-300">Live Mode (False)</div>
              <p className="text-[11px] text-zinc-400">Binary frames append to recordedFramesRef. Scrubber expands.</p>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950/60 border-l-2 border-zinc-600 space-y-1">
              <div className="font-semibold text-zinc-300">Replay Mode (True)</div>
              <p className="text-[11px] text-zinc-400">Incoming frames silent-dropped or buffered without disrupting playback canvas.</p>
            </div>
          </div>
        </div>

        {/* Gate 2 */}
        <div className="p-4 rounded-xl bg-zinc-900/80 border-0 space-y-3">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-bold text-white font-mono flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-white" />
              <span>Gate 2: Capacity Check</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-400">Length &gt; 700 Frames</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5 text-xs">
            <div className="p-2.5 rounded-lg bg-amber-950/20 border-l-2 border-amber-500 space-y-1">
              <div className="text-amber-400 font-bold font-mono text-[11px]">&bull; YES (Evict)</div>
              <p className="text-[11px] text-zinc-300">
                Executes <code className="text-white bg-zinc-800 px-1 py-0.5 rounded text-[10px]">buffer.shift()</code> to remove oldest frame.
              </p>
            </div>
            <div className="p-2.5 rounded-lg bg-emerald-950/20 border-l-2 border-emerald-500 space-y-1">
              <div className="text-emerald-400 font-bold font-mono text-[11px]">&bull; NO (Retain)</div>
              <p className="text-[11px] text-zinc-300">
                Buffer retains frame; ready for scrubber seek.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Time-Travel Scrubber Simulator */}
      <div className="p-4 sm:p-5 rounded-xl bg-black/60 border-0 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-zinc-800 text-white">
                <Sliders className="w-3.5 h-3.5 text-white" />
              </span>
              <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                Interactive Time-Travel Scrubber Preview
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Drag scrubber to simulate traveling back across the in-memory 700-frame ring buffer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border-0">
              Seek: <span className="text-white font-bold">{simulatedFrame} / 700</span>
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <input
            type="range"
            min={0}
            max={700}
            value={simulatedFrame}
            onChange={(e) => setSimulatedFrame(Number(e.target.value))}
            className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-white"
          />
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
            <span>Oldest Evicted (-11.6s)</span>
            <span>Buffer Center (-5.8s)</span>
            <span className="text-emerald-400 font-bold">Live Stream (0.0s)</span>
          </div>
        </div>
      </div>

      {/* Selected Stage Detail Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-black/60 border-0 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <selectedStage.icon className="w-4 h-4 text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white">
                {selectedStage.name}
              </h4>
              <p className="text-[11px] font-mono text-zinc-400">{selectedStage.subtitle}</p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border-0">
            Metric: <span className="text-white font-bold">{selectedStage.metrics}</span>
          </span>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedStage.description}
        </p>

        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-mono uppercase text-zinc-500">
            Technical Implementation Rules
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {selectedStage.techDetails.map((detail, idx) => (
              <div
                key={idx}
                className="px-3 py-2 rounded-lg bg-zinc-950/80 border-l-2 border-zinc-700 text-[11px] font-mono text-zinc-300 flex items-start gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white shrink-0 mt-1.5" />
                <span>{detail}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReplayBufferFlowDiagram;

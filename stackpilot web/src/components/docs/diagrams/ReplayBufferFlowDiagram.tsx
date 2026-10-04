import React, { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ComputerVideoIcon,
  SlidersHorizontalIcon,
  Layers01Icon,
  DatabaseIcon,
  RotateCcwIcon,
  ArrowRight01Icon
} from '@hugeicons/core-free-icons';

interface BufferStage {
  id: string;
  name: string;
  subtitle: string;
  icon: any;
  description: string;
  techDetails: string[];
  metrics: string;
}

const STAGES: BufferStage[] = [
  {
    id: 'stream',
    name: '1. Receive video stream',
    subtitle: 'Live browser feed',
    icon: ComputerVideoIcon,
    description: 'Receives video frames from the browser session in real time as tests run.',
    techDetails: ['Smooth 60 frames per second', 'Lightweight video stream', 'Low delay under 35ms'],
    metrics: 'Live stream'
  },
  {
    id: 'filter',
    name: '2. Skip idle frames',
    subtitle: 'Save frames on change',
    icon: SlidersHorizontalIcon,
    description: 'Checks if anything changed on screen (clicks, scrolling, typing). When idle, it saves fewer frames to keep memory low.',
    techDetails: ['Captures every user interaction', 'Drops repeated static frames', 'Saves memory on longer runs'],
    metrics: 'Only on changes'
  },
  {
    id: 'push',
    name: '3. Save to memory',
    subtitle: 'Store in temporary list',
    icon: Layers01Icon,
    description: 'Stores each video frame along with the time and mouse position in memory.',
    techDetails: ['Kept in browser memory', 'Very fast with zero re-rendering lag', 'Tracks mouse coordinates'],
    metrics: 'Saved to list'
  },
  {
    id: 'cap',
    name: '4. Check buffer size',
    subtitle: 'Up to 700 frames',
    icon: DatabaseIcon,
    description: 'Checks if the buffer has reached the 700-frame limit (about 12 to 45 seconds of video).',
    techDetails: ['Memory stays under 30 MB', 'Stops memory from growing infinitely', 'Runs smoothly for hours'],
    metrics: 'Max 700 frames'
  },
  {
    id: 'evict',
    name: '5. Keep newest frames',
    subtitle: 'Drop oldest frame',
    icon: RotateCcwIcon,
    description: 'When the buffer is full, the oldest frame is removed so you always have the most recent video ready to play.',
    techDetails: ['Oldest frame drops automatically', 'Rewind to any second instantly', 'Smooth playback at any speed'],
    metrics: 'Oldest removed'
  }
];

export const ReplayBufferFlowDiagram: React.FC = () => {
  const [selectedStage, setSelectedStage] = useState<BufferStage>(STAGES[1]);
  const [simulatedFrame, setSimulatedFrame] = useState<number>(542);

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/60 bg-[#121214]/95 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <HugeiconsIcon icon={RotateCcwIcon} size={16} strokeWidth={1.8} className="text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Video Replay Buffer (Last 700 Frames)
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            Saves recent video frames in memory so you can rewind and inspect what happened during tests.
          </p>
        </div>
      </div>

      {/* Interactive 5-Stage Pipeline */}
      <div className="space-y-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          How video frames are saved (click a step to inspect)
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {STAGES.map((stage, idx) => {
            const isSelected = selectedStage.id === stage.id;
            return (
              <div
                key={stage.id}
                onClick={() => setSelectedStage(stage)}
                className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                  isSelected
                    ? 'bg-[#222228] text-white shadow-md'
                    : 'bg-[#18181c]/80 hover:bg-[#202026]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <HugeiconsIcon icon={stage.icon} size={14} strokeWidth={1.8} className="text-white" />
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
                  <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={1.8} className="text-white shrink-0 ml-1" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Decision Flow Breakdown - Outline-less, border-0 cards with simple language */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Stream Mode */}
        <div className="p-4 rounded-xl bg-[#18181c]/80 border-0 space-y-3">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-mono font-bold text-white flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Live Stream vs Replay Mode
            </span>
            <span className="text-[10px] font-mono text-zinc-400">Current state</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-3 rounded-lg bg-[#202024] space-y-1">
              <div className="font-semibold text-emerald-400">Watching live</div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Saves new video frames so you can rewind later. The replay bar grows as the test runs.
              </p>
            </div>
            <div className="p-3 rounded-lg bg-[#202024] space-y-1">
              <div className="font-semibold text-zinc-300">Watching replay</div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Pauses saving new frames so your replay plays smoothly without jumping around.
              </p>
            </div>
          </div>
        </div>

        {/* Capacity Check */}
        <div className="p-4 rounded-xl bg-[#18181c]/80 border-0 space-y-3">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-bold text-white font-mono flex items-center gap-1.5">
              <HugeiconsIcon icon={DatabaseIcon} size={14} strokeWidth={1.8} className="text-white" />
              <span>Memory limit check</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-400">700 frames max</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-3 rounded-lg bg-[#202024] space-y-1">
              <div className="text-amber-400 font-semibold font-mono text-[11px]">Over 700 frames</div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Removes the oldest frame to keep memory usage low and smooth.
              </p>
            </div>
            <div className="p-3 rounded-lg bg-[#202024] space-y-1">
              <div className="text-emerald-400 font-semibold font-mono text-[11px]">Under 700 frames</div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Keeps the frame in memory ready to rewind and play.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Time-Travel Scrubber Simulator */}
      <div className="p-4 sm:p-5 rounded-xl bg-[#141416] border-0 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-zinc-800 text-white">
                <HugeiconsIcon icon={SlidersHorizontalIcon} size={14} strokeWidth={1.8} className="text-white" />
              </span>
              <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                Interactive Replay Scrubber Preview
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Drag the slider to test scrubbing backwards through recent test frames.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-zinc-400 bg-[#18181c] px-2 py-1 rounded border-0">
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
            <span>Oldest saved frame (-11.6s)</span>
            <span>Middle (-5.8s)</span>
            <span className="text-emerald-400 font-bold">Live (0.0s)</span>
          </div>
        </div>
      </div>

      {/* Selected Stage Detail Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-[#0a0a0c] border-0 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <HugeiconsIcon icon={selectedStage.icon} size={16} strokeWidth={1.8} className="text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white">
                {selectedStage.name}
              </h4>
              <p className="text-[11px] font-mono text-zinc-400">{selectedStage.subtitle}</p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border-0">
            Status: <span className="text-white font-bold">{selectedStage.metrics}</span>
          </span>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedStage.description}
        </p>

        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-mono uppercase text-zinc-500">
            How this works
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {selectedStage.techDetails.map((detail, idx) => (
              <div
                key={idx}
                className="px-3 py-2 rounded-lg bg-[#18181c] text-[11px] font-mono text-zinc-300 flex items-start gap-2 border-0"
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

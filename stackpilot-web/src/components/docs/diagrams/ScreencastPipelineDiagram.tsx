import React, { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComputerVideoIcon } from '@hugeicons/core-free-icons';

interface ScreencastStage {
  id: string;
  name: string;
  category: 'sandbox' | 'bridge' | 'client';
  port: string;
  description: string;
  specs: string[];
}

const STAGES: ScreencastStage[] = [
  {
    id: 'xvfb',
    name: 'Xvfb Virtual Display (:99)',
    category: 'sandbox',
    port: 'Display :99',
    description: '1280x720 24-bit virtual X11 framebuffer running inside rootless Alpine container.',
    specs: ['Resolution: 1280x720', 'Color Depth: 24bpp', 'Format: Raw RGB']
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg (x11grab)',
    category: 'sandbox',
    port: 'Video Encoder',
    description: 'Captures virtual display buffer and encodes to Annex-B H.264 NALUs with zero latency flags.',
    specs: ['Codec: libx264 ultrafast', 'Tune: zerolatency', 'FPS: 60 fps target']
  },
  {
    id: 'streamer',
    name: 'streamer.py (TCP 8099)',
    category: 'sandbox',
    port: 'TCP :8099',
    description: 'Custom Python TCP server packaging raw H.264 NALUs with microsecond frame headers.',
    specs: ['Protocol: Raw TCP Socket', 'Packaging: Annex-B NALUs', 'Latency: < 4ms']
  },
  {
    id: 'driver',
    name: 'browser_driver.py',
    category: 'bridge',
    port: 'FastAPI Bridge',
    description: 'Multiplexes Chrome DevTools Protocol (CDP) events with high-FPS binary video streams.',
    specs: ['CDP Port: 9223', 'Binary Framing: Custom "SP" header', 'Heartbeat: 2000ms']
  },
  {
    id: 'ws',
    name: 'FastAPI WebSocket Stream',
    category: 'bridge',
    port: '/ws/browser/{id}',
    description: 'Direct binary WebSocket connection streaming H.264 chunks to frontend clients.',
    specs: ['Format: Binary ArrayBuffer', 'Compression: None (raw NALU)', 'Traffic: ~2.4 Mbps']
  },
  {
    id: 'webcodecs',
    name: 'WebCodecs VideoDecoder',
    category: 'client',
    port: 'Hardware GPU',
    description: 'W3C WebCodecs hardware-accelerated video decoding directly on user GPU without CPU load.',
    specs: ['Decoder: VideoDecoder API', 'Codec: avc1.42001f (Baseline)', 'Render: OffscreenCanvas']
  },
  {
    id: 'canvas',
    name: 'Interactive Canvas (2D)',
    category: 'client',
    port: 'requestAnimationFrame',
    description: 'Blits decoded VideoFrame or createImageBitmap fallback to HTML5 canvas at monitor refresh rate.',
    specs: ['Render Cadence: 60 Hz rAF', 'User Clicks: Reverse coordinate mapping', 'Fallback: JPEG stream']
  }
];

export const ScreencastPipelineDiagram: React.FC = () => {
  const [selectedStage, setSelectedStage] = useState<ScreencastStage>(STAGES[5]); // default to WebCodecs

  const sandboxStages = STAGES.filter((s) => s.category === 'sandbox');
  const bridgeStages = STAGES.filter((s) => s.category === 'bridge');
  const clientStages = STAGES.filter((s) => s.category === 'client');

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/60 bg-[#121214]/95 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <HugeiconsIcon icon={ComputerVideoIcon} size={16} strokeWidth={1.8} className="text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Live Browser Video Stream
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            How browser video is captured and shown in your dashboard in real time.
          </p>
        </div>
      </div>

      {/* 3 Major Pipeline Zones - Clean flat layout without nested card boxes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Sandbox Container */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between pb-1 px-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <span>1. Chromium Sandbox</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-500">Rootless</span>
          </div>
          <div className="space-y-2">
            {sandboxStages.map((s) => (
              <div
                key={s.id}
                onClick={() => setSelectedStage(s)}
                className={`p-3 rounded-xl border-0 transition-all cursor-pointer flex flex-col gap-1 ${
                  selectedStage.id === s.id
                    ? 'bg-[#222228] text-white shadow-md'
                    : 'bg-[#18181c]/80 hover:bg-[#202026]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white truncate">{s.name}</span>
                  <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
                    {s.port}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* AI Service Bridge */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between pb-1 px-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
              <span>2. AI Service Bridge</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-500">FastAPI</span>
          </div>
          <div className="space-y-2">
            {bridgeStages.map((s) => (
              <div
                key={s.id}
                onClick={() => setSelectedStage(s)}
                className={`p-3 rounded-xl border-0 transition-all cursor-pointer flex flex-col gap-1 ${
                  selectedStage.id === s.id
                    ? 'bg-[#222228] text-white shadow-md'
                    : 'bg-[#18181c]/80 hover:bg-[#202026]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white truncate">{s.name}</span>
                  <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
                    {s.port}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Client Rendering */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between pb-1 px-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>3. Next.js Client</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-500">Browser</span>
          </div>
          <div className="space-y-2">
            {clientStages.map((s) => (
              <div
                key={s.id}
                onClick={() => setSelectedStage(s)}
                className={`p-3 rounded-xl border-0 transition-all cursor-pointer flex flex-col gap-1 ${
                  selectedStage.id === s.id
                    ? 'bg-[#222228] text-white shadow-md'
                    : 'bg-[#18181c]/80 hover:bg-[#202026]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white truncate">{s.name}</span>
                  <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">
                    {s.port}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Selected Stage Detail Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-[#0a0a0c] border-0 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <HugeiconsIcon icon={ComputerVideoIcon} size={16} strokeWidth={1.8} className="text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white">
                {selectedStage.name}
              </h4>
              <p className="text-[11px] font-mono text-zinc-400">
                Layer: <span className="text-white uppercase">{selectedStage.category}</span> &bull; Port: <span className="text-white">{selectedStage.port}</span>
              </p>
            </div>
          </div>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedStage.description}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
          {selectedStage.specs.map((spec, i) => (
            <div
              key={i}
              className="px-3 py-2 rounded-lg bg-[#18181c] text-[11px] font-mono text-zinc-300 flex items-center gap-2 border-0"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-white shrink-0" />
              <span>{spec}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ScreencastPipelineDiagram;

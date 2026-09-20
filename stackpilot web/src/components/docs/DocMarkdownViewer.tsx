import React, { useState } from 'react';
import { Copy, Check, Terminal, ExternalLink } from 'lucide-react';
import confetti from 'canvas-confetti';

interface DocMarkdownViewerProps {
  content: string;
  docId: string;
}

export const DocMarkdownViewer: React.FC<DocMarkdownViewerProps> = ({ content, docId }) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (text: string, id: string, e?: React.MouseEvent) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);

    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (rect.left + rect.width / 2) / window.innerWidth;
      const y = (rect.top + rect.height / 2) / window.innerHeight;
      confetti({
        particleCount: 24,
        spread: 45,
        startVelocity: 16,
        origin: { x, y },
        colors: ['#ffffff', '#a1a1aa', '#71717a', '#38bdf8'],
        ticks: 50,
      });
    }

    setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 2000);
  };

  // Parse markdown into blocks
  const renderBlocks = () => {
    const lines = content.split('\n');
    const blocks: React.ReactNode[] = [];
    let i = 0;
    let blockKey = 0;

    // Helper for inline formatting: bold, link, code
    const renderInline = (text: string): React.ReactNode => {
      // Split by markdown elements
      const parts: React.ReactNode[] = [];
      let remaining = text;
      let partKey = 0;

      while (remaining.length > 0) {
        // Inline code: `...`
        const codeMatch = remaining.match(/`([^`]+)`/);
        // Link: [text](url)
        const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
        // Bold: **...**
        const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);

        // Find which match comes first
        let firstMatch: { type: 'code' | 'link' | 'bold'; index: number; length: number; match: RegExpMatchArray } | null = null;

        if (codeMatch && codeMatch.index !== undefined) {
          firstMatch = { type: 'code', index: codeMatch.index, length: codeMatch[0].length, match: codeMatch };
        }
        if (linkMatch && linkMatch.index !== undefined && (!firstMatch || linkMatch.index < firstMatch.index)) {
          firstMatch = { type: 'link', index: linkMatch.index, length: linkMatch[0].length, match: linkMatch };
        }
        if (boldMatch && boldMatch.index !== undefined && (!firstMatch || boldMatch.index < firstMatch.index)) {
          firstMatch = { type: 'bold', index: boldMatch.index, length: boldMatch[0].length, match: boldMatch };
        }

        if (!firstMatch) {
          parts.push(remaining);
          break;
        }

        // Add text before match
        if (firstMatch.index > 0) {
          parts.push(remaining.substring(0, firstMatch.index));
        }

        // Add formatted match
        if (firstMatch.type === 'code') {
          parts.push(
            <code
              key={`c-${partKey++}`}
              className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 font-mono text-[11px]"
            >
              {firstMatch.match[1]}
            </code>
          );
        } else if (firstMatch.type === 'link') {
          const isExternal = firstMatch.match[2].startsWith('http');
          parts.push(
            <a
              key={`l-${partKey++}`}
              href={firstMatch.match[2]}
              target={isExternal ? '_blank' : undefined}
              rel={isExternal ? 'noopener noreferrer' : undefined}
              className="text-zinc-200 hover:text-white underline underline-offset-4 decoration-zinc-600 hover:decoration-white transition-colors inline-flex items-center gap-1"
            >
              <span>{firstMatch.match[1]}</span>
              {isExternal && <ExternalLink className="w-3 h-3 text-white inline-block shrink-0" />}
            </a>
          );
        } else if (firstMatch.type === 'bold') {
          parts.push(
            <strong key={`b-${partKey++}`} className="font-semibold text-white">
              {firstMatch.match[1]}
            </strong>
          );
        }

        remaining = remaining.substring(firstMatch.index + firstMatch.length);
      }

      return parts;
    };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block (```)
      if (line.trim().startsWith('```')) {
        const lang = line.trim().replace(/^```/, '').trim() || 'text';
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing ```
        const codeString = codeLines.join('\n');
        const codeId = `code-${docId}-${blockKey++}`;

        // If mermaid diagram, render an interactive diagram container
        if (lang === 'mermaid') {
          blocks.push(
            <div
              key={`mermaid-${blockKey}`}
              className="my-6 rounded-2xl border border-zinc-800 bg-[#161619] p-5 space-y-3"
            >
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-300">
                  <Terminal className="w-3.5 h-3.5 text-white" />
                  <span className="font-semibold text-white">Architecture Flowchart / Sequence</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleCopy(codeString, codeId, e)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 hover:text-white transition-colors cursor-pointer border-0"
                  title="Copy Mermaid source"
                >
                  {copiedId === codeId ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-[11px] text-emerald-400 font-mono">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 text-white" />
                      <span className="text-[11px] font-mono">Copy Diagram</span>
                    </>
                  )}
                </button>
              </div>
              <div className="p-4 rounded-xl bg-black border border-zinc-800/80 overflow-x-auto text-[11px] font-mono text-zinc-300 leading-relaxed">
                <pre>{codeString}</pre>
              </div>
            </div>
          );
          continue;
        }

        blocks.push(
          <div
            key={`code-block-${blockKey}`}
            className="my-5 rounded-2xl border border-zinc-800 bg-[#141416] overflow-hidden shadow-lg group"
          >
            {/* Code Block Header */}
            <div className="px-4 py-2.5 bg-[#18181b] border-b border-zinc-800/80 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                <span className="ml-2 text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold">
                  {lang}
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => handleCopy(codeString, codeId, e)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-xs text-zinc-300 hover:text-white transition-colors cursor-pointer border-0"
                title="Copy code"
              >
                {copiedId === codeId ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-[11px] text-emerald-400 font-mono font-medium">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-white" />
                    <span className="text-[11px] font-mono">Copy</span>
                  </>
                )}
              </button>
            </div>
            {/* Code Block Content */}
            <div className="p-4 bg-black overflow-x-auto">
              <pre className="font-mono text-xs text-zinc-200 leading-relaxed selection:bg-zinc-800 selection:text-white">
                <code>{codeString}</code>
              </pre>
            </div>
          </div>
        );
        continue;
      }

      // Markdown Table (| col | col |)
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          tableLines.push(lines[i]);
          i++;
        }

        if (tableLines.length >= 2) {
          const parseRow = (rowStr: string) =>
            rowStr
              .split('|')
              .slice(1, -1)
              .map((c) => c.trim());

          const headers = parseRow(tableLines[0]);
          // tableLines[1] is divider (| :--- | :--- |)
          const rows = tableLines.slice(2).map(parseRow);

          blocks.push(
            <div
              key={`table-${blockKey++}`}
              className="my-6 rounded-2xl border border-zinc-800 bg-[#161619] overflow-hidden shadow-md"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-zinc-300 border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-[#1a1a1e]">
                      {headers.map((h, idx) => (
                        <th
                          key={`th-${idx}`}
                          className="py-3 px-4 font-mono font-semibold text-white text-[11px] uppercase tracking-wider"
                        >
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 font-sans">
                    {rows.map((r, rIdx) => (
                      <tr key={`tr-${rIdx}`} className="hover:bg-zinc-800/30 transition-colors">
                        {r.map((cell, cIdx) => (
                          <td key={`td-${cIdx}`} className="py-2.5 px-4 text-zinc-300 align-top leading-relaxed">
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
          continue;
        }
      }

      // Horizontal Rule (---)
      if (line.trim() === '---') {
        blocks.push(<hr key={`hr-${blockKey++}`} className="border-t border-zinc-800/80 my-8" />);
        i++;
        continue;
      }

      // Headings
      if (line.startsWith('# ')) {
        blocks.push(
          <h1 key={`h1-${blockKey++}`} className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white mt-8 mb-4">
            {renderInline(line.substring(2))}
          </h1>
        );
        i++;
        continue;
      }

      if (line.startsWith('## ')) {
        blocks.push(
          <h2 key={`h2-${blockKey++}`} className="text-xl sm:text-2xl font-bold tracking-tight text-white mt-8 mb-3 flex items-center gap-2.5">
            <span className="w-1.5 h-5 rounded-full bg-white inline-block shrink-0" />
            <span>{renderInline(line.substring(3))}</span>
          </h2>
        );
        i++;
        continue;
      }

      if (line.startsWith('### ')) {
        blocks.push(
          <h3 key={`h3-${blockKey++}`} className="text-base sm:text-lg font-semibold tracking-tight text-zinc-100 mt-6 mb-2">
            {renderInline(line.substring(4))}
          </h3>
        );
        i++;
        continue;
      }

      if (line.startsWith('#### ')) {
        blocks.push(
          <h4 key={`h4-${blockKey++}`} className="text-sm font-semibold tracking-tight text-zinc-200 mt-4 mb-1">
            {renderInline(line.substring(5))}
          </h4>
        );
        i++;
        continue;
      }

      // Blockquotes (> ...)
      if (line.startsWith('> ')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          quoteLines.push(lines[i].substring(2));
          i++;
        }
        blocks.push(
          <div
            key={`bq-${blockKey++}`}
            className="my-4 p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/90 border-l-4 border-l-white text-xs text-zinc-300 space-y-1.5"
          >
            {quoteLines.map((ql, qIdx) => (
              <p key={`ql-${qIdx}`} className="leading-relaxed">
                {renderInline(ql)}
              </p>
            ))}
          </div>
        );
        continue;
      }

      // Unordered list item (- ... or * ...)
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        const listItems: string[] = [];
        while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
          listItems.push(lines[i].trim().substring(2));
          i++;
        }
        blocks.push(
          <ul key={`ul-${blockKey++}`} className="my-3 space-y-2 text-xs text-zinc-300">
            {listItems.map((item, itemIdx) => (
              <li key={`li-${itemIdx}`} className="flex items-start gap-2.5 leading-relaxed">
                <span className="w-1.5 h-1.5 rounded-full bg-white shrink-0 mt-1.5" />
                <span>{renderInline(item)}</span>
              </li>
            ))}
          </ul>
        );
        continue;
      }

      // Ordered list item (1. ...)
      if (/^\s*\d+\.\s/.test(line)) {
        const listItems: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
          listItems.push(lines[i].replace(/^\s*\d+\.\s/, ''));
          i++;
        }
        blocks.push(
          <ol key={`ol-${blockKey++}`} className="my-3 space-y-2 text-xs text-zinc-300">
            {listItems.map((item, itemIdx) => (
              <li key={`oli-${itemIdx}`} className="flex items-start gap-2.5 leading-relaxed">
                <span className="font-mono text-[11px] font-bold text-white shrink-0 mt-0.5">
                  {itemIdx + 1}.
                </span>
                <span>{renderInline(item)}</span>
              </li>
            ))}
          </ol>
        );
        continue;
      }

      // Empty line
      if (!line.trim()) {
        i++;
        continue;
      }

      // Regular paragraph
      blocks.push(
        <p key={`p-${blockKey++}`} className="my-3 text-sm text-zinc-300 leading-relaxed font-sans">
          {renderInline(line)}
        </p>
      );
      i++;
    }

    return blocks;
  };

  return <div className="space-y-2">{renderBlocks()}</div>;
};

export default DocMarkdownViewer;

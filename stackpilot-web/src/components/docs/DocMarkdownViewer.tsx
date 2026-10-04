import React, { useState } from 'react';
import confetti from 'canvas-confetti';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { DocDiagramDispatcher } from './diagrams/DocDiagramDispatcher';
import { CodeBlock } from './CodeBlock';

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
              {isExternal && <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={1.8} className="text-white inline-block shrink-0" />}
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

        // If mermaid diagram, render native interactive React visual diagram component
        if (lang === 'mermaid') {
          blocks.push(
            <DocDiagramDispatcher
              key={`diagram-${docId}-${blockKey++}`}
              docId={docId}
              code={codeString}
            />
          );
          continue;
        }

        blocks.push(
          <CodeBlock
            key={`code-block-${docId}-${blockKey++}`}
            code={codeString}
            lang={lang}
            id={codeId}
          />
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
              className="my-6 rounded-2xl border border-zinc-800/60 bg-[#121214] overflow-hidden shadow-md"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-zinc-300 border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800/60 bg-[#161619]">
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

      // Section Break (---) - Clean spacing without dividing line
      if (line.trim() === '---') {
        blocks.push(<div key={`spacer-${blockKey++}`} className="h-6 select-none" />);
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
            className="my-4 p-4 rounded-2xl border border-zinc-800/60 bg-[#121214]/95 border-l-4 border-l-white text-xs text-zinc-300 space-y-1.5"
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

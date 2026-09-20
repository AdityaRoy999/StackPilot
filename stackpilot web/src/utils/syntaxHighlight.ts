import Prism from 'prismjs';

// Import core Prism languages in dependency order
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-toml';

// Map common aliases to Prism language keys
const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  json: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  cmd: 'bash',
  terminal: 'bash',
  console: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  python: 'python',
  sql: 'sql',
  docker: 'docker',
  dockerfile: 'docker',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  nginx: 'nginx',
  env: 'ini',
  ini: 'ini',
  toml: 'toml',
  html: 'markup',
  xml: 'markup',
  markup: 'markup',
  css: 'css'
};

/**
 * Highlights code string into colored HTML using Prism
 */
export function highlightCode(code: string, lang: string): string {
  const normalizedLang = (lang || 'text').toLowerCase().trim();
  const prismLangKey = LANG_MAP[normalizedLang] || normalizedLang;

  const grammar = Prism.languages[prismLangKey];
  if (grammar) {
    try {
      return Prism.highlight(code, grammar, prismLangKey);
    } catch {
      // fallback to plain escaped code
    }
  }

  // Fallback for json if grammar not found or malformed
  if (normalizedLang === 'json' && Prism.languages.json) {
    try {
      return Prism.highlight(code, Prism.languages.json, 'json');
    } catch {
      // fallback
    }
  }

  // Fallback for shell/bash commands
  if (Prism.languages.bash) {
    try {
      return Prism.highlight(code, Prism.languages.bash, 'bash');
    } catch {
      // fallback
    }
  }

  // Basic HTML entity escape if no grammar found
  return escapeHtml(code);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

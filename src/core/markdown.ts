/** Markdown → HTML for agent-authored text shown in the UI (approval bodies, Q&A answers).
 *  `breaks: true` honors the agent's single newlines as <br> (GitHub-style) so findings and
 *  answers don't collapse into one dense paragraph. */
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(md: string): string {
  try {
    return marked.parse(md, { async: false });
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

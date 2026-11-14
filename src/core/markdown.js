/* Minimal, lossless Markdown <-> HTML codec for the task drawer's rich-text subset:
   blocks: <p>, <h4>, <ul><li>, <ol><li>, <pre><code>
   inline: <b>, <i>, <code>, <a href="https://...">, <br> */
import { esc } from './dates.js';

export function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&');
}

export function stripHtml(html) {
  if (!html) return '';
  return unescapeHtml(
    String(html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|h[1-6]|li|div|pre)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function inlineToHtml(text) {
  let out = '';
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        out += `<code>${esc(s.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (s[i] === '[') {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/.exec(s.slice(i));
      if (m) {
        out += `<a href="${esc(m[2])}">${inlineToHtml(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        out += `<b>${inlineToHtml(s.slice(i + 2, end))}</b>`;
        i = end + 2;
        continue;
      }
    }
    if (s[i] === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1) {
        out += `<i>${inlineToHtml(s.slice(i + 1, end))}</i>`;
        i = end + 1;
        continue;
      }
    }
    const nextSpecial = s.slice(i + 1).search(/[`[*]/);
    const chunk = nextSpecial === -1 ? s.slice(i) : s.slice(i, i + 1 + nextSpecial);
    out += esc(chunk);
    i += chunk.length;
  }
  return out;
}

const isFence = line => /^```/.test(line);
const matchHeading = line => /^#{1,6}\s+(.+)$/.exec(line);
const matchUl = line => /^\s*[-*]\s+(.+)$/.exec(line);
const matchOl = line => /^\s*\d+\.\s+(.+)$/.exec(line);
const isBlockStart = line => isFence(line) || !!matchHeading(line) || !!matchUl(line) || !!matchOl(line);

export function markdownToHtml(md) {
  const raw = String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!raw) return '';
  const lines = raw.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFence(line)) {
      i++;
      const code = [];
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      if (i < lines.length && isFence(lines[i])) i++;
      blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = matchHeading(line);
    if (h) {
      blocks.push(`<h4>${inlineToHtml(h[1].trim())}</h4>`);
      i++;
      continue;
    }
    if (matchUl(line)) {
      const items = [];
      while (i < lines.length) {
        const m = matchUl(lines[i]);
        if (!m) break;
        items.push(`<li>${inlineToHtml(m[1].trim())}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (matchOl(line)) {
      const items = [];
      while (i < lines.length) {
        const m = matchOl(lines[i]);
        if (!m) break;
        items.push(`<li>${inlineToHtml(m[1].trim())}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(inlineToHtml(lines[i]));
      i++;
    }
    blocks.push(`<p>${para.join('<br>')}</p>`);
  }
  return blocks.join('');
}

function inlineHtmlToMd(html) {
  const codes = [];
  let s = String(html ?? '').replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
    const idx = codes.push('`' + unescapeHtml(inner) + '`') - 1;
    return `\uFDD0${idx}\uFDD1`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  let prev;
  do {
    prev = s;
    s = s
      .replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `[${inlineHtmlToMd(label)}](${unescapeHtml(href)})`)
      .replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, (_, inner) => `**${inlineHtmlToMd(inner)}**`)
      .replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, (_, inner) => `*${inlineHtmlToMd(inner)}*`);
  } while (s !== prev);
  s = unescapeHtml(s.replace(/<[^>]+>/g, ''));
  return s.replace(/\uFDD0(\d+)\uFDD1/g, (_, idx) => codes[+idx]);
}

const BLOCK_RE = /<(pre|h[1-6]|ul|ol|p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export function htmlToMarkdown(html) {
  const raw = String(html ?? '').trim();
  if (!raw) return '';
  const blocks = [];
  let lastIdx = 0;
  for (const m of raw.matchAll(BLOCK_RE)) {
    const lead = raw.slice(lastIdx, m.index).trim();
    if (lead) {
      const txt = inlineHtmlToMd(lead).trim();
      if (txt) blocks.push(txt);
    }
    lastIdx = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (tag === 'pre') {
      const codeMatch = /^<code\b[^>]*>([\s\S]*?)<\/code>$/i.exec(inner.trim());
      const body = unescapeHtml((codeMatch ? codeMatch[1] : inner).replace(/<[^>]+>/g, ''));
      blocks.push('```\n' + body + '\n```');
    } else if (tag.startsWith('h')) {
      const txt = inlineHtmlToMd(inner)
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      if (txt) blocks.push(`#### ${txt}`);
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li, idx) => {
        const txt = inlineHtmlToMd(li[1])
          .replace(/\s*\n\s*/g, ' ')
          .trim();
        return tag === 'ol' ? `${idx + 1}. ${txt}` : `- ${txt}`;
      });
      if (items.length) blocks.push(items.join('\n'));
    } else {
      const txt = inlineHtmlToMd(inner).trim();
      if (txt) blocks.push(txt);
    }
  }
  const tail = raw.slice(lastIdx).trim();
  if (tail) {
    const txt = inlineHtmlToMd(tail).trim();
    if (txt) blocks.push(txt);
  }
  return blocks.join('\n\n');
}

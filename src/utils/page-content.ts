import type { PageWithContent } from '../types';

/**
 * Page content helpers for partial page editing
 *
 * The BookStack API only supports full replacement of page content
 * (`PUT /api/pages/{id}` with a complete `html` or `markdown` field).
 * These pure functions let the MCP server perform the read-modify-write
 * cycle itself, so callers only ever send the changed fragment.
 */

export type PageWriteField = 'html' | 'markdown';

export interface PageSource {
  /** Field to send back to the API when writing */
  writeField: PageWriteField;
  /** Content to patch against */
  source: string;
  /** Editor type reported by BookStack */
  editor: string;
}

export interface PageEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface AppliedEdit {
  index: number;
  occurrences_replaced: number;
  context: string;
}

export interface Heading {
  level: number;
  text: string;
  offset: number;
  length: number;
}

export interface GrepMatch {
  offset: number;
  match: string;
  context: string;
}

/**
 * Error carrying actionable detail back to the caller without
 * dumping the whole page content into the response.
 */
export class PageContentError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PageContentError';
  }
}

/**
 * The page changed between the read the caller based its anchor on and this write.
 *
 * Separate from PageContentError because it maps to a different MCP error code: the caller's
 * parameters were fine, the world moved. A client should re-read and retry, not rewrite its
 * arguments. See ErrorHandler.handleError().
 */
export class PageStaleError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PageStaleError';
  }
}

const CONTEXT_RADIUS = 120;
const MAX_DIAGNOSTIC_LENGTH = 300;

/** Escape literal anchor text for the whitespace-tolerant diagnostic only. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide which field to patch and which one to write back.
 *
 * Markdown pages must be patched and written as `markdown`, otherwise
 * BookStack may switch the page editor type. HTML pages must be patched
 * against `raw_html` (the stored source) rather than `html` (the rendered
 * output), otherwise page include tags get expanded permanently.
 */
export function selectSource(page: PageWithContent): PageSource {
  const editor = page.editor || '';
  const rawHtml = typeof page.raw_html === 'string' ? page.raw_html : '';

  if (editor === 'markdown' && typeof page.markdown === 'string') {
    // Stay on the markdown path even when the page is still empty, otherwise
    // the first append to a fresh markdown page would switch its editor type.
    // Only an inconsistent page (no markdown but stored HTML) falls back.
    if (page.markdown.trim().length > 0 || rawHtml.trim().length === 0) {
      return { writeField: 'markdown', source: page.markdown, editor };
    }
  }

  const source = rawHtml.length > 0 ? rawHtml : page.html || '';

  return { writeField: 'html', source, editor };
}

/**
 * Count literal (non-regex) occurrences of a needle.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

/**
 * Build a short excerpt around a position, with ellipses where truncated.
 */
export function contextAround(
  text: string,
  offset: number,
  radius: number = CONTEXT_RADIUS
): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * When an exact match fails, look for the same text with different
 * whitespace. HTML stored by BookStack often differs from what a caller
 * copied out of a rendered view only by line breaks and indentation.
 */
function findWhitespaceTolerantMatch(source: string, needle: string): string | null {
  const trimmed = needle.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const pattern = trimmed.split(/\s+/).map(escapeRegExp).join('\\s+');

  const match = new RegExp(pattern).exec(source);
  if (!match) {
    return null;
  }

  return match[0].length > MAX_DIAGNOSTIC_LENGTH
    ? `${match[0].slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : match[0];
}

/**
 * Apply a list of literal string edits in order.
 *
 * Each `old_string` must appear exactly once unless `replace_all` is set,
 * so an ambiguous anchor can never silently patch the wrong place.
 */
export function applyEdits(
  source: string,
  edits: PageEdit[]
): { result: string; applied: AppliedEdit[] } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new PageContentError('At least one edit is required');
  }

  let current = source;
  const applied: AppliedEdit[] = [];

  edits.forEach((edit, index) => {
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = edit;

    if (typeof oldString !== 'string' || oldString.length === 0) {
      throw new PageContentError(`Edit ${index}: old_string must be a non-empty string`, {
        edit_index: index,
      });
    }

    if (oldString === newString) {
      throw new PageContentError(`Edit ${index}: old_string and new_string are identical`, {
        edit_index: index,
      });
    }

    const occurrences = countOccurrences(current, oldString);

    if (occurrences === 0) {
      const whitespaceMatch = findWhitespaceTolerantMatch(current, oldString);
      throw new PageContentError(`Edit ${index}: old_string not found in page content`, {
        edit_index: index,
        occurrences: 0,
        found_with_different_whitespace: whitespaceMatch,
        hint: whitespaceMatch
          ? 'The text exists but with different whitespace. Retry with the exact text shown in found_with_different_whitespace.'
          : 'Use bookstack_pages_read with the grep parameter to obtain an exact anchor string.',
      });
    }

    if (occurrences > 1 && !replaceAll) {
      const contexts: string[] = [];
      let searchFrom = 0;
      while (contexts.length < 3) {
        const at = current.indexOf(oldString, searchFrom);
        if (at === -1) {
          break;
        }
        contexts.push(contextAround(current, at));
        searchFrom = at + oldString.length;
      }

      throw new PageContentError(
        `Edit ${index}: old_string is not unique (${occurrences} occurrences)`,
        {
          edit_index: index,
          occurrences,
          first_occurrences: contexts,
          hint: 'Extend old_string with surrounding text to make it unique, or set replace_all to true.',
        }
      );
    }

    const firstOffset = current.indexOf(oldString);
    current = replaceAll
      ? current.split(oldString).join(newString)
      : `${current.slice(0, firstOffset)}${newString}${current.slice(firstOffset + oldString.length)}`;

    applied.push({
      index,
      occurrences_replaced: replaceAll ? occurrences : 1,
      context: contextAround(current, firstOffset),
    });
  });

  return { result: current, applied };
}

/**
 * Strip tags and decode the handful of entities BookStack emits in headings.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce content to comparable text.
 *
 * BookStack rewrites stored HTML on save (heading anchors, `id` attributes),
 * so written content is verified on its text, not byte for byte.
 */
export function normalizeForComparison(value: string, writeField: PageWriteField): string {
  const text = writeField === 'markdown' ? value : htmlToText(value);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Check whether a fragment is present, ignoring markup normalisation.
 */
export function containsNormalized(
  haystack: string,
  needle: string,
  writeField: PageWriteField
): boolean {
  const normalizedNeedle = normalizeForComparison(needle, writeField);
  if (normalizedNeedle.length === 0) {
    return true;
  }
  return normalizeForComparison(haystack, writeField).includes(normalizedNeedle);
}

/**
 * Map the heading structure of a page, so a large page can be navigated
 * without loading its content.
 */
export function buildOutline(source: string, writeField: PageWriteField): Heading[] {
  const headings: Omit<Heading, 'length'>[] = [];

  // `matchAll` rather than a `while ((m = re.exec(s)))` loop: the assignment-in-condition
  // form is what the linter flags, and matchAll also advances past a zero-length match on its
  // own, which that loop has to remember to do by hand.
  if (writeField === 'markdown') {
    for (const match of source.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*$/gm)) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        offset: match.index,
      });
    }
  } else {
    for (const match of source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
      headings.push({
        level: Number(match[1]),
        text: htmlToText(match[2]),
        offset: match.index,
      });
    }
  }

  return headings.map((heading, i) => ({
    ...heading,
    length: (i + 1 < headings.length ? headings[i + 1].offset : source.length) - heading.offset,
  }));
}

/**
 * Search inside page content and return exact matches with surrounding
 * context, suitable for building an `old_string` anchor.
 */
export function grepContent(
  source: string,
  query: string,
  options: { caseInsensitive?: boolean; contextChars?: number; maxMatches?: number } = {}
): { matches: GrepMatch[]; total: number; truncated: boolean } {
  const { caseInsensitive = true, contextChars = 200, maxMatches = 10 } = options;

  if (query.length === 0) {
    throw new PageContentError('Search text must be non-empty');
  }

  // This is intentionally literal search rather than caller-supplied RegExp. Apart from
  // catastrophic backtracking, a regex match can span an entire large page and defeat the
  // narrow-read contract even when context/maxMatches are bounded.
  const haystack = caseInsensitive ? source.toLowerCase() : source;
  const needle = caseInsensitive ? query.toLowerCase() : query;
  const matches: GrepMatch[] = [];
  let total = 0;
  let searchFrom = 0;

  // `total` counts EVERY match while only `maxMatches` are collected: a truncated result that
  // under-reported the total would read as "this anchor is unique" and a caller would edit on
  // that basis.
  while (searchFrom <= haystack.length) {
    const offset = haystack.indexOf(needle, searchFrom);
    if (offset === -1) {
      break;
    }
    total += 1;
    if (matches.length < maxMatches) {
      matches.push({
        offset,
        match: source.slice(offset, offset + query.length),
        context: contextAround(source, offset, contextChars),
      });
    }
    searchFrom = offset + query.length;
  }

  return { matches, total, truncated: total > matches.length };
}

/**
 * Insert content at the start or end of a page, or of a named section.
 */
export function insertContent(
  source: string,
  content: string,
  options: {
    position?: 'start' | 'end';
    section?: string;
    separator?: string;
    writeField: PageWriteField;
  }
): string {
  const { position = 'end', section, writeField } = options;
  const separator = options.separator ?? (writeField === 'markdown' ? '\n\n' : '\n');

  let rangeStart = 0;
  let rangeEnd = source.length;

  if (section) {
    const headings = buildOutline(source, writeField);
    const wanted = section.trim().toLowerCase();
    const found =
      headings.find((h) => h.text.toLowerCase() === wanted) ??
      headings.find((h) => h.text.toLowerCase().includes(wanted));

    if (!found) {
      throw new PageContentError(`Section not found: ${section}`, {
        available_sections: headings.map((h) => h.text),
        hint: 'Use bookstack_pages_outline to list the exact heading texts.',
      });
    }

    // "start" means directly after the heading itself, not before it
    const headingBlock = source.slice(found.offset, found.offset + found.length);
    let headingEnd: number;
    if (writeField === 'markdown') {
      const lineBreak = headingBlock.indexOf('\n');
      headingEnd = found.offset + (lineBreak === -1 ? headingBlock.length : lineBreak);
    } else {
      const closing = /<\/h[1-6]>/i.exec(headingBlock);
      headingEnd =
        found.offset + (closing ? closing.index + closing[0].length : headingBlock.length);
    }

    rangeStart = headingEnd;
    rangeEnd = found.offset + found.length;
  }

  let insertAt = rangeStart;
  if (position === 'end') {
    // Step back over trailing whitespace so the inserted text stays inside
    // the section instead of being pushed against the next heading
    insertAt = rangeEnd;
    while (insertAt > rangeStart && /\s/.test(source[insertAt - 1])) {
      insertAt -= 1;
    }
  }

  return insertAt > 0
    ? `${source.slice(0, insertAt)}${separator}${content}${source.slice(insertAt)}`
    : `${content}${separator}${source.slice(insertAt)}`;
}

/**
 * Refuse writes that would drop a large part of the page, unless the
 * caller explicitly opted in. Guards against an anchor that accidentally
 * swallows most of a document.
 */
export function assertNoUnexpectedShrink(before: string, after: string, allowShrink = false): void {
  if (allowShrink || before.length === 0) {
    return;
  }

  if (after.length < before.length * 0.5) {
    throw new PageContentError('Refusing to write: result is less than half the original size', {
      chars_before: before.length,
      chars_after: after.length,
      hint: 'Set allow_shrink to true if this reduction is intended.',
    });
  }
}

/**
 * Extract a character window from page content.
 */
export function sliceContent(
  source: string,
  offset = 0,
  length?: number
): {
  content: string;
  offset: number;
  length: number;
  total_chars: number;
  truncated: boolean;
} {
  const start = Math.max(0, Math.min(offset, source.length));
  const end = length === undefined ? source.length : Math.min(source.length, start + length);
  const content = source.slice(start, end);

  return {
    content,
    offset: start,
    length: content.length,
    total_chars: source.length,
    truncated: end < source.length,
  };
}

/**
 * Unit tests for the partial-page-editing helpers.
 *
 * These are pure functions - no client, no HTTP, no BookStack. What they encode is the two
 * invariants the whole feature rests on, so they are asserted directly rather than through a
 * tool handler:
 *
 *  - a markdown page is patched and written through `markdown`, because writing `html` to one
 *    switches its editor type;
 *  - every other page is patched against `raw_html`, the STORED source, never against `html`,
 *    the rendered output - patching the rendered output writes back expanded page-include
 *    tags and destroys the includes permanently.
 *
 * The diagnostics are under test as much as the results: an anchor that does not match is the
 * normal case for a model driving these tools, and what it gets back - the same text found
 * with different whitespace, the first few ambiguous matches, the list of real section names -
 * is what lets it fix its own call instead of guessing.
 */

import { describe, expect, it } from 'bun:test';
import type { PageWithContent } from '../../src/types';
import {
  applyEdits,
  assertNoUnexpectedShrink,
  buildOutline,
  containsNormalized,
  countOccurrences,
  grepContent,
  insertContent,
  PageContentError,
  selectSource,
  sliceContent,
} from '../../src/utils/page-content';

const basePage: PageWithContent = {
  id: 1,
  book_id: 2,
  chapter_id: null,
  name: 'Test page',
  slug: 'test-page',
  priority: 0,
  draft: false,
  template: false,
  created_at: '2026-01-01T00:00:00.000000Z',
  updated_at: '2026-01-02T00:00:00.000000Z',
  created_by: 1,
  updated_by: 1,
  owned_by: 1,
  revision_count: 3,
  editor: 'wysiwyg',
  tags: [],
  html: '<p>rendered</p>',
  raw_html: '<p>stored</p>',
};

/** Capture the error a thunk throws, without depending on a `fail()` helper. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('selectSource', () => {
  it('patches the stored html, not the rendered html', () => {
    // THE INVARIANT. `html` is what BookStack renders, with page includes resolved;
    // `raw_html` is what it stores. Patching the rendered output and writing it back would
    // replace every `{{@42}}` include with a frozen copy of its target, irreversibly.
    const result = selectSource(basePage);

    expect(result.writeField).toBe('html');
    expect(result.source).toBe('<p>stored</p>');
  });

  it('patches and writes markdown for markdown pages', () => {
    const result = selectSource({
      ...basePage,
      editor: 'markdown',
      markdown: '# Heading\n\nBody',
    });

    expect(result.writeField).toBe('markdown');
    expect(result.source).toBe('# Heading\n\nBody');
  });

  it('falls back to the rendered html when raw_html is absent', () => {
    const { raw_html: _omitted, ...withoutRaw } = basePage;
    const result = selectSource(withoutRaw as PageWithContent);

    expect(result.source).toBe('<p>rendered</p>');
  });

  it('ignores a blank markdown field on a markdown page that has stored html', () => {
    const result = selectSource({ ...basePage, editor: 'markdown', markdown: '   ' });

    expect(result.writeField).toBe('html');
  });

  it('keeps writing markdown on an empty markdown page', () => {
    // Falling back to html here would flip the editor type on the very first append to a
    // freshly created markdown page - the one case where there is no content to judge by.
    const result = selectSource({
      ...basePage,
      editor: 'markdown',
      markdown: '',
      raw_html: '',
      html: '',
    });

    expect(result.writeField).toBe('markdown');
    expect(result.source).toBe('');
  });
});

describe('countOccurrences', () => {
  it('counts literally, without regex interpretation', () => {
    // '.' as a regex would match every character. Anchors are caller-supplied prose full of
    // dots, brackets and parentheses, so the match has to be literal.
    expect(countOccurrences('a.b.c', '.')).toBe(2);
    // Non-overlapping, which is what a sequence of replacements will actually do.
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});

describe('applyEdits', () => {
  const source = 'Intro paragraph.\n\nData is transferred on request.\n\nOutro.';

  it('replaces a unique anchor', () => {
    const { result, applied } = applyEdits(source, [
      {
        old_string: 'Data is transferred on request.',
        new_string: 'Data is transferred only with consent.',
      },
    ]);

    expect(result).toContain('only with consent');
    expect(result).not.toContain('on request.');
    expect(applied[0].occurrences_replaced).toBe(1);
  });

  it('applies multiple edits in order, each to the previous result', () => {
    const { result, applied } = applyEdits(source, [
      { old_string: 'Intro paragraph.', new_string: 'Introduction.' },
      { old_string: 'Outro.', new_string: 'Conclusion.' },
    ]);

    expect(result).toContain('Introduction.');
    expect(result).toContain('Conclusion.');
    expect(applied).toHaveLength(2);
  });

  it('rejects an anchor that is not present', () => {
    expect(() => applyEdits(source, [{ old_string: 'missing text', new_string: 'x' }])).toThrow(
      PageContentError
    );
  });

  it('reports the exact text when only the whitespace differs', () => {
    // The most common near-miss by far: a model reproduces an anchor with collapsed
    // whitespace, because that is how the text reads. Saying "not found" and stopping there
    // would leave it with no way forward, so the diagnostic carries the real bytes.
    const error = thrownBy(() =>
      applyEdits('<p>One  long\nsentence</p>', [
        { old_string: 'One long sentence', new_string: 'x' },
      ])
    );

    expect(error).toBeInstanceOf(PageContentError);
    expect((error as PageContentError).details?.found_with_different_whitespace).toBe(
      'One  long\nsentence'
    );
  });

  it('refuses an ambiguous anchor, and reports where the matches are', () => {
    const repeated = 'yes. yes. yes.';

    const error = thrownBy(() => applyEdits(repeated, [{ old_string: 'yes.', new_string: 'no.' }]));
    expect((error as PageContentError).message).toMatch(/not unique \(3 occurrences\)/);
    expect((error as PageContentError).details?.first_occurrences).toBeArray();

    // replace_all is the explicit opt-in for a rename that legitimately repeats.
    const { result, applied } = applyEdits(repeated, [
      { old_string: 'yes.', new_string: 'no.', replace_all: true },
    ]);
    expect(result).toBe('no. no. no.');
    expect(applied[0].occurrences_replaced).toBe(3);
  });

  it('rejects empty, no-op and absent edits', () => {
    expect(() => applyEdits(source, [{ old_string: '', new_string: 'x' }])).toThrow(
      PageContentError
    );
    expect(() => applyEdits(source, [{ old_string: 'Outro.', new_string: 'Outro.' }])).toThrow(
      PageContentError
    );
    expect(() => applyEdits(source, [])).toThrow(PageContentError);
  });

  it('replaces only the first occurrence once the anchor is unique', () => {
    const { result } = applyEdits('one two one', [
      { old_string: 'one two', new_string: 'ONE TWO' },
    ]);

    expect(result).toBe('ONE TWO one');
  });
});

describe('buildOutline', () => {
  it('maps markdown headings with offsets and section sizes', () => {
    const markdown = '# Title\n\nText\n\n## Section A\n\nMore text\n\n## Section B\n\nEnd';
    const headings = buildOutline(markdown, 'markdown');

    expect(headings.map((heading) => heading.text)).toEqual(['Title', 'Section A', 'Section B']);
    expect(headings[0].level).toBe(1);
    expect(headings[1].level).toBe(2);
    expect(headings[0].offset).toBe(0);
    // A heading's `length` is its SECTION's size, so the last one has to reach the end of
    // the document - that is what makes the offsets usable as insertion ranges.
    expect(headings[2].offset + headings[2].length).toBe(markdown.length);
  });

  it('maps html headings, stripping the markup and entities BookStack emits', () => {
    // `id="bkmrk-…"` is injected by BookStack on save, and `&amp;` is how it stores an
    // ampersand. A section name a caller can actually type has to survive both.
    const html =
      '<h1 id="bkmrk-a">Title &amp; more</h1><p>Text</p><h2>Section <em>A</em></h2><p>End</p>';
    const headings = buildOutline(html, 'html');

    expect(headings.map((heading) => heading.text)).toEqual(['Title & more', 'Section A']);
    expect(headings[1].level).toBe(2);
  });

  it('returns an empty outline for a page without headings', () => {
    expect(buildOutline('<p>Just a paragraph</p>', 'html')).toEqual([]);
  });
});

describe('grepContent', () => {
  const source = 'Line one\nLine two\nLine three';

  it('returns literal matches with their offsets, matched text and context', () => {
    const { matches, total, truncated } = grepContent(source, 'Line one', { contextChars: 5 });

    expect(total).toBe(1);
    expect(truncated).toBe(false);
    expect(matches[0].match).toBe('Line one');
    expect(matches[0].offset).toBe(source.indexOf('Line one'));
  });

  it('honours maxMatches while still reporting the true total', () => {
    // A truncated result that under-reported the total would read as "there is one match",
    // and a caller would anchor on it believing it unique.
    const { matches, total, truncated } = grepContent(source, 'Line', { maxMatches: 1 });

    expect(matches).toHaveLength(1);
    expect(total).toBe(3);
    expect(truncated).toBe(true);
  });

  it('is case insensitive by default and case sensitive on request', () => {
    expect(grepContent(source, 'line').total).toBe(3);
    expect(grepContent(source, 'line', { caseInsensitive: false }).total).toBe(0);
  });

  it('treats regex syntax literally so it cannot return the whole page as one match', () => {
    const wholePagePattern = '[\\s\\S]*';

    expect(
      grepContent('All of this content must stay out of the response', wholePagePattern)
    ).toEqual({
      matches: [],
      total: 0,
      truncated: false,
    });
  });
});

describe('insertContent', () => {
  const markdown = '# Title\n\nIntro\n\n## Measures\n\nExisting text\n\n## Other\n\nEnd';

  it('appends at the end of the page', () => {
    const result = insertContent(markdown, 'New sentence', { writeField: 'markdown' });

    expect(result.endsWith('End\n\nNew sentence')).toBe(true);
  });

  it('appends at the end of a named section, before the next heading', () => {
    // Section targeting only works if the text lands inside the section it was addressed to,
    // instead of being pushed past its boundary into the following one.
    const result = insertContent(markdown, 'New sentence', {
      writeField: 'markdown',
      section: 'Measures',
    });

    expect(result).toContain('Existing text\n\nNew sentence\n\n## Other');
  });

  it('inserts directly after a section heading with position: start', () => {
    const result = insertContent(markdown, 'New sentence', {
      writeField: 'markdown',
      section: 'Measures',
      position: 'start',
    });

    expect(result).toContain('## Measures\n\nNew sentence');
  });

  it('inserts after an html section heading', () => {
    const html = '<h2 id="bkmrk-m">Measures</h2><p>Old</p><h2>Other</h2><p>End</p>';
    const result = insertContent(html, '<p>New</p>', {
      writeField: 'html',
      section: 'Measures',
      position: 'start',
      separator: '',
    });

    expect(result).toContain('<h2 id="bkmrk-m">Measures</h2><p>New</p><p>Old</p>');
  });

  it('matches a section name case-insensitively', () => {
    const result = insertContent(markdown, 'New sentence', {
      writeField: 'markdown',
      section: 'measures',
    });

    expect(result).toContain('Existing text\n\nNew sentence');
  });

  it('lists the real section names when the section is unknown', () => {
    const error = thrownBy(() =>
      insertContent(markdown, 'x', { writeField: 'markdown', section: 'Absent' })
    );

    expect(error).toBeInstanceOf(PageContentError);
    expect((error as PageContentError).details?.available_sections).toEqual([
      'Title',
      'Measures',
      'Other',
    ]);
  });
});

describe('assertNoUnexpectedShrink', () => {
  it('allows an ordinary edit', () => {
    expect(() => assertNoUnexpectedShrink('a'.repeat(100), 'a'.repeat(80))).not.toThrow();
  });

  it('blocks a drastic reduction unless it was asked for', () => {
    // The failure this guards: an anchor whose closing text appears far earlier than the
    // author meant, so the replacement swallows most of the document. The write is refused
    // rather than applied, because BookStack's revision history is the only way back.
    expect(() => assertNoUnexpectedShrink('a'.repeat(100), 'a'.repeat(10))).toThrow(
      PageContentError
    );
    expect(() => assertNoUnexpectedShrink('a'.repeat(100), 'a'.repeat(10), true)).not.toThrow();
  });
});

describe('containsNormalized', () => {
  it('recognises written content after BookStack rewrote the markup', () => {
    // BookStack re-generates heading anchors and injects `id` attributes on save, so the
    // bytes that come back are not the bytes that were sent. Verifying byte-for-byte would
    // report every successful write as unverified.
    const stored = '<p id="bkmrk-new">Data is transferred only with consent.</p>';

    expect(
      containsNormalized(stored, '<p>Data is transferred only with consent.</p>', 'html')
    ).toBe(true);
    expect(containsNormalized(stored, '<p>Something else entirely</p>', 'html')).toBe(false);
  });

  it('compares markdown on collapsed whitespace', () => {
    expect(containsNormalized('# Title\n\nOne  sentence', 'One sentence', 'markdown')).toBe(true);
  });
});

describe('sliceContent', () => {
  it('returns a window and reports whether more follows', () => {
    const result = sliceContent('0123456789', 2, 3);

    expect(result.content).toBe('234');
    expect(result.offset).toBe(2);
    expect(result.total_chars).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('clamps an out-of-range offset instead of throwing', () => {
    expect(sliceContent('abc', 99).content).toBe('');
  });
});

import { fontFamilies } from '../fonts';
import { DARK_PALETTE, radius, space, type Theme } from '../Preferences';
import { highlightLatex } from '../latexHighlight';

function fakeTheme(): Theme {
  return {
    ...DARK_PALETTE,
    mode: 'dark',
    effective: 'dark',
    scale: (n: number) => n,
    reduceMotion: false,
    fonts: fontFamilies(false),
    space,
    radius,
  };
}

describe('highlightLatex', () => {
  it('wraps a LaTeX command in an inline-colored span', () => {
    const html = highlightLatex('\\section{Intro}', fakeTheme());
    expect(html).toContain('<span');
    // "section" is a headline command — its ARGUMENT is aliased to
    // class-name (bold, theme.text); the command name itself
    // ("section") is aliased to selector (theme.accent).
    expect(html).toContain(`color:${DARK_PALETTE.accent}`);
    expect(html).toContain(`color:${DARK_PALETTE.text}`);
  });

  it('colors comments distinctly and never drops their text', () => {
    const html = highlightLatex('% a note\nBody text.', fakeTheme());
    expect(html).toContain('% a note');
    expect(html).toContain(`color:${DARK_PALETTE.faint}`);
    expect(html).toContain('Body text.');
  });

  it('colors \\cite{} arguments as keywords', () => {
    const html = highlightLatex('\\cite{smith2020}', fakeTheme());
    expect(html).toContain('smith2020');
    expect(html).toContain(`color:${DARK_PALETTE.accent}`);
  });

  it('never throws and always round-trips the plain text content for arbitrary input', () => {
    const source = '\\documentclass{article}\n\\begin{document}\nHello & world $x^2$\n\\end{document}';
    expect(() => highlightLatex(source, fakeTheme())).not.toThrow();
    const html = highlightLatex(source, fakeTheme());
    // Strip tags — the underlying text content must be fully preserved
    // (highlighting must never alter or drop manuscript characters).
    const textOnly = html.replace(/<[^>]+>/g, '');
    expect(textOnly).toContain('Hello');
    expect(textOnly).toContain('world');
  });

  it('HTML-escapes angle brackets and ampersands in the source so they can never break out of the highlighted markup', () => {
    const html = highlightLatex('Body text 1 < 2 & 3 > 1', fakeTheme());
    expect(html).not.toContain('1 < 2');
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
  });

  it('repaints with the new palette when the theme changes', () => {
    const darkHtml = highlightLatex('\\cite{smith2020}', fakeTheme());
    const lightTheme: Theme = { ...fakeTheme(), accent: '#123456', effective: 'light' };
    const lightHtml = highlightLatex('\\cite{smith2020}', lightTheme);
    expect(lightHtml).toContain('color:#123456');
    expect(lightHtml).not.toBe(darkHtml);
  });
});

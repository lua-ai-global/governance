// Generates .github/og-image.png — the social preview card shown when the
// repo URL is shared on Twitter / Slack / LinkedIn / etc.
//
// Run:  node scripts/build-og-image.mjs
// Output: .github/og-image.png (1280x640)
//
// Not shipped in the npm tarball — generator-only. Deps: satori + resvg
// are root devDependencies.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const assetsDir = resolve(__dirname, 'og-assets');

// Auto-fetch fonts (SIL OFL licensed) on first run so the repo stays lean.
function ensureFonts() {
  const required = [
    'Inter-Regular.otf',
    'Inter-Medium.otf',
    'Inter-Bold.otf',
    'JetBrainsMono-Regular.ttf',
  ];
  if (required.every((f) => existsSync(resolve(assetsDir, f)))) return;

  mkdirSync(assetsDir, { recursive: true });
  console.log('Fetching fonts (Inter + JetBrains Mono, SIL OFL)…');

  const interZip = resolve(assetsDir, '_inter.zip');
  execSync(
    `curl -fsSLo "${interZip}" https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip`,
    { stdio: 'inherit' },
  );
  execSync(
    `cd "${assetsDir}" && unzip -o -j _inter.zip "*Inter-Regular.otf" "*Inter-Medium.otf" "*Inter-Bold.otf" && rm _inter.zip`,
    { stdio: 'inherit' },
  );

  execSync(
    `curl -fsSLo "${resolve(assetsDir, 'JetBrainsMono-Regular.ttf')}" ` +
      `https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Regular.ttf`,
    { stdio: 'inherit' },
  );
}

ensureFonts();

const interRegular = readFileSync(resolve(assetsDir, 'Inter-Regular.otf'));
const interMedium = readFileSync(resolve(assetsDir, 'Inter-Medium.otf'));
const interBold = readFileSync(resolve(assetsDir, 'Inter-Bold.otf'));
const mono = readFileSync(resolve(assetsDir, 'JetBrainsMono-Regular.ttf'));

const WIDTH = 1280;
const HEIGHT = 640;

// Palette — dark, confident, slightly warm.
const bg = '#0a0a0a';
const bgGradient = 'radial-gradient(circle at 20% 0%, #1a1a1a 0%, #0a0a0a 55%)';
const fg = '#f5f5f5';
const dim = '#a1a1aa';
const accent = '#f97316'; // orange-500, matches the Lua avatar vibe
const codeBg = '#111111';
const codeBorder = '#27272a';
const keyword = '#f97316';
const string = '#a3e635';
const comment = '#71717a';
const ident = '#e4e4e7';
const block = '#ef4444';

const monoFont = { fontFamily: 'JetBrains Mono', fontSize: 20, lineHeight: 1.4 };

function CodeLine({ children }) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', ...monoFont, color: ident, whiteSpace: 'pre' },
      children,
    },
  };
}

function span(text, color, weight = 400) {
  return {
    type: 'span',
    props: { style: { color, fontWeight: weight }, children: text },
  };
}

const tree = {
  type: 'div',
  props: {
    style: {
      width: WIDTH,
      height: HEIGHT,
      background: bgGradient,
      backgroundColor: bg,
      display: 'flex',
      flexDirection: 'column',
      padding: '64px 72px',
      fontFamily: 'Inter',
      color: fg,
      position: 'relative',
    },
    children: [
      // accent bar
      {
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: WIDTH,
            height: 6,
            backgroundColor: accent,
            display: 'flex',
          },
        },
      },

      // top row: wordmark + tagline LEFT, "MIT · Zero deps" badge RIGHT
      {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            width: '100%',
          },
          children: [
            {
              type: 'div',
              props: {
                style: { display: 'flex', flexDirection: 'column' },
                children: [
                  {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: 64,
                        fontWeight: 700,
                        letterSpacing: -1.5,
                        color: fg,
                        display: 'flex',
                      },
                      children: [
                        span('governance', fg, 700),
                        span('-sdk', accent, 700),
                      ],
                    },
                  },
                  {
                    type: 'div',
                    props: {
                      style: {
                        fontSize: 26,
                        color: dim,
                        marginTop: 12,
                        fontWeight: 400,
                        display: 'flex',
                      },
                      children: 'AI Agent Governance for TypeScript',
                    },
                  },
                ],
              },
            },
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: 6,
                  marginTop: 6,
                },
                children: [
                  {
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        padding: '6px 14px',
                        backgroundColor: '#18181b',
                        border: `1px solid ${codeBorder}`,
                        borderRadius: 999,
                        fontSize: 16,
                        color: dim,
                        fontWeight: 500,
                      },
                      children: '0 runtime dependencies',
                    },
                  },
                  {
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex',
                        padding: '6px 14px',
                        backgroundColor: '#18181b',
                        border: `1px solid ${codeBorder}`,
                        borderRadius: 999,
                        fontSize: 16,
                        color: dim,
                        fontWeight: 500,
                      },
                      children: '1,291 tests · MIT',
                    },
                  },
                ],
              },
            },
          ],
        },
      },

      // code card
      {
        type: 'div',
        props: {
          style: {
            marginTop: 38,
            backgroundColor: codeBg,
            border: `1px solid ${codeBorder}`,
            borderRadius: 14,
            padding: '26px 30px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          },
          children: [
            CodeLine({
              children: [
                span('import ', keyword),
                span('{ createGovernance, blockTools } ', ident),
                span('from ', keyword),
                span("'governance-sdk'", string),
                span(';', ident),
              ],
            }),
            CodeLine({ children: ' ' }),
            CodeLine({
              children: [
                span('const ', keyword),
                span('gov = ', ident),
                span('createGovernance', ident, 500),
                span('({ rules: [', ident),
                span('blockTools', ident, 500),
                span('([', ident),
                span("'shell_exec'", string),
                span(']) ', ident),
                span('] });', ident),
              ],
            }),
            CodeLine({ children: ' ' }),
            CodeLine({
              children: [
                span('const ', keyword),
                span('decision = ', ident),
                span('await ', keyword),
                span('gov.', ident),
                span('enforce', ident, 500),
                span('({ agentId, action: ', ident),
                span("'tool_call'", string),
                span(', tool: ', ident),
                span("'shell_exec'", string),
                span(' });', ident),
              ],
            }),
            CodeLine({
              children: [
                span('//→ { outcome: ', comment),
                span("'block'", block),
                span(', reason: ', comment),
                span("'tool blocked by policy'", block),
                span(' }', comment),
              ],
            }),
          ],
        },
      },

      // footer strip
      {
        type: 'div',
        props: {
          style: {
            marginTop: 'auto',
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 17,
            color: dim,
          },
          children: [
            {
              type: 'div',
              props: {
                style: { display: 'flex', gap: 16 },
                children: 'EU AI Act · OWASP · NIST AI RMF · ISO 42001',
              },
            },
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  color: fg,
                  fontWeight: 500,
                },
                children: 'heygovernance.ai',
              },
            },
          ],
        },
      },
    ],
  },
};

const svg = await satori(tree, {
  width: WIDTH,
  height: HEIGHT,
  fonts: [
    { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
    { name: 'Inter', data: interMedium, weight: 500, style: 'normal' },
    { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
    { name: 'JetBrains Mono', data: mono, weight: 400, style: 'normal' },
  ],
});

const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } });
const png = resvg.render().asPng();

const outDir = resolve(root, '.github');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'og-image.png');
writeFileSync(outPath, png);

console.log(`✓ Wrote ${outPath} (${(png.length / 1024).toFixed(1)} KB, ${WIDTH}x${HEIGHT})`);

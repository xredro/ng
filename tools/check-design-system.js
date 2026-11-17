// Run: node tools/check-design-system.js
// Checks (1) WCAG contrast of every text/background token pair, light and dark,
// (2) that xr-*.css has no !important, no unprefixed class selectors, balanced braces,
// (3) that every var(--xr-*) used in components is defined in tokens.
const fs = require('fs');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = strip(fs.readFileSync('css/xr-tokens.css', 'utf8'));
const comps = strip(fs.readFileSync('css/xr-components.css', 'utf8'));

function block(src, startRe) {
  const m = src.match(startRe); if (!m) throw new Error('block not found ' + startRe);
  let i = src.indexOf('{', m.index), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(i + 1, j);
}
function vars(b) { const o = {}; for (const m of b.matchAll(/(--xr-[a-z0-9-]+)\s*:\s*([^;]+);/g)) o[m[1]] = m[2].trim(); return o; }
const light = vars(block(tokens, /:root\s*\{/));
const dark = Object.assign({}, light, vars(block(tokens, /\[data-theme="dark"\]\s*\{/)));

const lum = h => { h = h.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255).map(c => c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4)); return .2126 * r + .7152 * g + .0722 * b; };
const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

// [foreground token, background token, minimum ratio, note]
const pairs = [
  ['--xr-text', '--xr-bg', 4.5], ['--xr-text', '--xr-surface', 4.5],
  ['--xr-text-2', '--xr-bg', 4.5], ['--xr-text-2', '--xr-surface', 4.5], ['--xr-text-2', '--xr-surface-2', 4.5],
  ['--xr-text-3', '--xr-bg', 4.5], ['--xr-text-3', '--xr-surface', 4.5],
  ['--xr-green-text', '--xr-surface', 4.5], ['--xr-green', '--xr-surface', 3, 'UI/focus only'],
  ['--xr-lime-ink', '--xr-lime', 4.5], ['--xr-lime-ink', '--xr-lime-hover', 4.5],
  ['--xr-text-inverse', '--xr-ink', 4.5],
  ['--xr-info-text', '--xr-info-bg', 4.5], ['--xr-success-text', '--xr-success-bg', 4.5],
  ['--xr-danger-text', '--xr-danger-bg', 4.5], ['--xr-warning-text', '--xr-warning-bg', 4.5],
  ['--xr-neutral-text', '--xr-neutral-bg', 4.5],
  ['--xr-danger-text', '--xr-surface', 4.5],
  ['--xr-focus', '--xr-surface', 3, 'focus ring'], ['--xr-focus', '--xr-bg', 3, 'focus ring'],
  ['--xr-border-strong', '--xr-surface', 1.4, 'input border (decorative, not the only cue)'],
];
let fail = 0;
for (const [name, set] of [['LIGHT', light], ['DARK', dark]]) {
  for (const [f, b, min, note] of pairs) {
    const fv = set[f], bv = set[b];
    if (!/^#/.test(fv) || !/^#/.test(bv)) { console.log('skip', f, b); continue; }
    const r = cr(fv, bv), ok = r >= min; if (!ok) fail++;
    if (!ok || process.argv.includes('-v')) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${r.toFixed(2)} (min ${min}) ${f} on ${b} ${note || ''}`);
  }
}
// extra: white on danger-solid button
for (const [name, set] of [['LIGHT', light], ['DARK', dark]]) {
  const fg = name === 'LIGHT' ? '#ffffff' : '#ffffff', r = cr(fg, set['--xr-danger-solid']);
  if (r < 4.5) { fail++; console.log(`FAIL ${name} ${r.toFixed(2)} white on --xr-danger-solid`); }
}

// lint
const lint = [];
if (/!important/.test(tokens + comps)) lint.push('contains !important');
for (const m of comps.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
  for (const sel of m[2].split(',')) {
    const s = sel.trim(); if (!s || /^(from|to|\d+%)/.test(s)) continue;
    if (!/^\.xr-/.test(s) && !/^\.xr-/.test(s.replace(/^[a-z]+\s*/, ''))) lint.push('unprefixed selector: ' + s);
  }
}
const open = (comps.match(/\{/g) || []).length, close = (comps.match(/\}/g) || []).length;
if (open !== close) lint.push(`unbalanced braces ${open}/${close}`);
const used = new Set([...comps.matchAll(/var\((--xr-[a-z0-9-]+)/g)].map(m => m[1]));
for (const u of used) if (!(u in light)) lint.push('undefined token: ' + u);
const unused = Object.keys(light).filter(k => !used.has(k) && !tokens.includes('var(' + k));
console.log(`tokens: ${Object.keys(light).length}  used by components: ${used.size}`);
console.log('lint problems:', lint.length ? '\n  ' + lint.join('\n  ') : 'none');
console.log('contrast failures:', fail);
process.exit(fail || lint.length ? 1 : 0);

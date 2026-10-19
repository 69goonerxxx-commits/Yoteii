// Small shared helpers.
export const esc = z => (z || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- appearance: surface themes and accent colours (the surfaces live in styles.css as :root[data-pal=...]) ----
export const PALS = [
  { id:'dark', name:'Dark', base:'dark' }, { id:'light', name:'Light', base:'light' },
  { id:'midnight', name:'Midnight (black)', base:'dark' }, { id:'slate', name:'Slate', base:'dark' },
  { id:'forest', name:'Forest', base:'dark' }, { id:'warm', name:'Warm paper', base:'light' }
];
export const ACCENTS = [
  { id:'blue', name:'Blue', dark:'#5e96cb', light:'#2563eb' },
  { id:'teal', name:'Teal', dark:'#2fbfae', light:'#0f766e' },
  { id:'green', name:'Green', dark:'#4cc77a', light:'#15803d' },
  { id:'amber', name:'Amber', dark:'#f0b43c', light:'#b45309' },
  { id:'orange', name:'Orange', dark:'#fb923c', light:'#c2410c' },
  { id:'red', name:'Red', dark:'#f87171', light:'#dc2626' },
  { id:'pink', name:'Pink', dark:'#f472b6', light:'#be185d' },
  { id:'purple', name:'Purple', dark:'#a78bfa', light:'#7c3aed' }
];
export function luminance(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0;
  const v = [0, 2, 4].map(i => { const x = parseInt(m[1].substr(i, 2), 16) / 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); });
  return .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
}
export function contrast(a, b){ const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
export function onAccent(hex){ return contrast(hex, '#ffffff') >= contrast(hex, '#06121f') ? '#ffffff' : '#06121f'; }   // readable text on an accent fill

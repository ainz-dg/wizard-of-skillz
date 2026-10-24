/**
 * Pixel-art branding for the guided overview only.
 * Pure presentation: no input, model, proposal, or Apply dependencies.
 * "▀" combines two vertical pixels into one terminal row.
 */
const CSI='\x1b[';
const RESET=CSI+'0m';
const COLORS=Object.freeze({
  n:[10,14,36],   d:[21,29,98],   b:[28,76,200],
  B:[28,127,252], c:[85,212,250], p:[75,28,129],
  v:[131,67,234],g:[255,207,30], o:[232,128,13],
  r:[144,66,25], w:[245,243,240],l:[174,168,209]
});

// Compact, hand-quantized sprites derived from the approved wizard artwork.
// Dots are transparent pixels. Each pair of image rows is one terminal row.
const FULL=Object.freeze([
  '.......npbbbdn................',
  '......dvbdbbBbbp..............',
  '....dddbndbbbbbbvn............',
  '....nppd.dpdbbolbpp...........',
  '...r......pbbrggobbd..........',
  '.rprnpp..dbdbbrrorlorddd......',
  'pdrggrrr.pddprrorbbBBBbbddd...',
  '.pggwgonnprrrpbBBBbdnnnndpbn..',
  'ppooggrrrrddbBBbnnnrnndpppd...',
  'pprrornpbbbbbdnornngnnpppn....',
  '.rrnnrpbbbdddpnrrllrlld.......',
  '...pdrrddndllwllwwlwwldbbvvvvb',
  '.....nrndddnplwwwwwwlpBbbbppvb',
  '.....nllrbbbdplwwwwwlbprnnnnbn',
  '....pbllrlBbddpllwwlppnlpdndb.',
  '....bdnrnobddbrdlwldbnddnpdbd.',
  '...nbdnnrrndblrddlldbddllpdd..',
  '....ddpnrndbbgnbbdppnrnbbp....',
  '.....dnndrdbgrdbbbddrrrdn.....',
  '.......ddnrornddddbdrnn.......'
]);
const FACE=Object.freeze([
  'ppd.dpbbggbp......',
  '.p..dpbbggbbpr....',
  'pp..pddbrrorrrbbbd',
  'gordpdrrrbBBbbdddd',
  'gonrrpdbBbddnnnddp',
  'orpbbbbbdonngrnppp',
  'rpbbbddpnorlrlld..',
  'nrddnrlwllwllwldlv',
  '.rdddddlwwwwwlpbbp',
  'nllrbbddlwwwwlpprn'
]);

export function stripTerminalColors(value){
  return String(value).replace(/\x1b\[[0-9;]*m/g,'');
}
function fg(rgb){return '38;2;'+rgb.join(';');}
function bg(rgb){return '48;2;'+rgb.join(';');}
function pixel(top,bottom,colors){
  if(top==='.' && bottom==='.')return ' ';
  const upper=COLORS[top],lower=COLORS[bottom];
  const glyph=upper&&lower?'▀':upper?'▀':'▄';
  if(!colors)return glyph;
  if(upper&&lower)return CSI+fg(upper)+';'+bg(lower)+'m'+glyph+RESET;
  const rgb=upper??lower;
  return CSI+fg(rgb)+'m'+glyph+RESET;
}
export function wizardSprite({variant='full',colors=true}={}){
  const source=variant==='face'?FACE:FULL;
  const rows=[];
  for(let y=0;y<source.length;y+=2){
    let line='';
    for(let x=0;x<source[y].length;x++){
      line+=pixel(source[y][x],source[y+1][x],colors);
    }
    rows.push(line);
  }
  return rows;
}
export function decorateWizardOverview(lines,{width=90,height=28,colors=true}={}){
  if(!Array.isArray(lines))return lines;
  // Never consume more rows or interfere with short terminal controls.
  const variant=width>=108 && height>=24?'full':
    width>=90 && height>=20?'face':null;
  if(!variant)return lines;
  const art=wizardSprite({variant,colors});
  const artWidth=variant==='full'?FULL[0].length:FACE[0].length;
  const leftLimit=width-artWidth-4;
  const start=variant==='full'?3:3;
  return lines.map((line,i)=>{
    const piece=art[i-start];
    if(piece===undefined)return line;
    const used=stripTerminalColors(line).length;
    if(used>leftLimit)return line; // preserving text outranks decorations
    return line+' '.repeat(leftLimit-used)+'  '+piece;
  });
}

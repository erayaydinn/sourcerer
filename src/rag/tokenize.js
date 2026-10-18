// Turns code (or a task text) into search terms: identifiers split on camelCase / snake_case / digits,
// lowercased, with the parts and the whole identifier. Words that appear everywhere are dropped.

const STOP = new Set(`
a an and are as at be but by do does for from has have if in into is it its no not of on or so such that the their then there
these this to was were will with you your we our can should must may
when what which how who why where all any each only also just than too very out up down over after before about
abstract async await bool boolean break case catch class const continue def default defer delete do echo elif else enum
except export extends false final finally fn for foreach func function global go if implements import in instanceof
interface is lambda let map namespace new nil none null or package pass private protected public raise readonly require
return self static struct super switch this throw throws trait true try type typeof use var void while with yield
string int float number object array list dict err error value data result item get set args kwargs
`.split(/\s+/).filter(Boolean));

const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

function parts(identifier) {
  return identifier
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean);
}

const keep = (term) => term.length >= 2 && !STOP.has(term) && !/^\d+$/.test(term);

export function tokenize(text) {
  const out = [];
  for (const match of String(text).matchAll(IDENTIFIER)) {
    const pieces = parts(match[0]).map((piece) => piece.toLowerCase());
    for (const piece of pieces) if (keep(piece)) out.push(piece);
    const whole = match[0].toLowerCase().replace(/^[_$]+|[_$]+$/g, '');
    if (pieces.length > 1 && keep(whole)) out.push(whole);
  }
  return out;
}

// Names defined in a file (functions, classes, types, ...), by extension. Regex, not a parser.
const DEFINITIONS = [
  [/\.php$/i, [/\b(?:function|class|interface|trait|enum)\s+&?([A-Za-z_]\w*)/g]],
  [/\.py$/i, [/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm]],
  [/\.go$/i, [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^\s*type\s+([A-Za-z_]\w*)/gm]],
  [/\.(?:[cm]?jsx?|tsx?|vue|svelte)$/i, [
    /\b(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  ]],
];

export function definitions(path, text) {
  const rules = DEFINITIONS.find(([ext]) => ext.test(path))?.[1] ?? [];
  const names = [];
  for (const rule of rules) for (const match of String(text).matchAll(rule)) names.push(match[1]);
  return names;
}

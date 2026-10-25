/**
 * How an include that resolves to nothing travels from expansion to the page: its reason, line and
 * file, then its literal, each spelled in private-use characters between three markers, so markdown
 * reads none of it as syntax and a slug drops all of it; the page spells the literal back as written.
 */

const OPEN = "\uE000";
/** Present in any text holding a marked include. */
export const MARKED = OPEN;
const SPLIT = "\uE001";
const CLOSE = "\uE002";
const DIGIT = 0xe010;
const SPELLED = /\uE000([\uE010-\uE01F]*)\uE001([\uE010-\uE01F]*)\uE002/g;
const SHOWN = /\uE000([\uE010-\uE01F]*)\uE001([^\uE000-\uE002]*)\uE002/g;

export interface Unresolved {
  why: string;
  line: number;
  column: number;
  file: string;
}

export function marked({ why, line, column, file }: Unresolved, written: string): string {
  return `${OPEN}${spell(`${why}\n${line}\n${column}\n${file}`)}${SPLIT}${spell(written)}${CLOSE}`;
}

/** The text with every marked include back as written and unmarked, as raw text and attributes show it. */
export function unmarked(text: string): string {
  return text.replace(SPELLED, (_, __, written: string) => read(written));
}

/**
 * An address with every marked include back as written, its colon escaped so the literal reads as a
 * path rather than a scheme and the address survives sanitizing.
 */
export function unmarkedAddress(text: string): string {
  return text.replace(SPELLED, (_, __, written: string) => read(written).replaceAll(":", "%3A"));
}

/** Text the page has spelled back, with every marker dropped and only the literals left. */
export function literal(text: string): string {
  return text.replace(SHOWN, (_, __, written: string) => written);
}

/** The text with each marked include's literal spelled back as written, still marked for the page. */
export function shown(text: string): string {
  return text.replace(
    SPELLED,
    (_, where: string, written: string) => `${OPEN}${where}${SPLIT}${read(written)}${CLOSE}`,
  );
}

export function spelledIn(text: string): string[] {
  return [...text.matchAll(SPELLED)].map(([run]) => run);
}

export function markers(
  text: string,
): { at: number; length: number; written: string; where: Unresolved }[] {
  return [...text.matchAll(SHOWN)].map((match) => {
    const [why, line, column, file] = read(match[1]).split("\n");
    return {
      at: match.index,
      length: match[0].length,
      written: match[2],
      where: { why, line: Number(line), column: Number(column), file },
    };
  });
}

function spell(text: string): string {
  let spelled = "";

  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);

    for (const shift of [12, 8, 4, 0]) {
      spelled += String.fromCharCode(DIGIT + ((code >> shift) & 15));
    }
  }

  return spelled;
}

function read(spelled: string): string {
  let text = "";

  for (let at = 0; at + 4 <= spelled.length; at += 4) {
    let code = 0;

    for (let digit = 0; digit < 4; digit++) {
      code = code * 16 + (spelled.charCodeAt(at + digit) - DIGIT);
    }

    text += String.fromCharCode(code);
  }

  return text;
}

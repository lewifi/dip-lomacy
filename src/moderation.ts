// Comment moderation for the public war-room chat. Ported from PasteDrops'
// vetted patterns, adapted for a BROADCAST channel: this runs server-side before
// fan-out, so every viewer sees the cleaned text (not just the typer).
//
// Three tiers:
//   - HATE  → hard reject (never broadcast, never stored)
//   - SLURS → fully masked (all asterisks)
//   - PROFANITY → first two letters kept, rest masked (comedic, on-brand)
// Plus link stripping (scam/malware) and a length cap.

const MAX_LEN = 140;

// Hard-block: hate/slurs never reach the feed. Tolerates spacing/leet; the
// double-letter requirement avoids false positives like "Niger"/"Nigeria".
const HATE = [
  /\bn[\s\-_.*+]*[i1!|][\s\-_.*+]*g[\s\-_.*+]*g[\s\-_.*+]*[e3a@][\s\-_.*+]*r?/i,
  /\bf[a@4][\s\-_.*+]*g[\s\-_.*+]*g[\s\-_.*+]*[o0][\s\-_.*+]*t/i,
];
function isHate(t: string): boolean {
  return HATE.some((re) => re.test(t));
}

// Profanity → first two letters revealed, rest starred.
const VULGAR_PATTERNS = [
  /f+u+c+k+\w*/gi,
  /sh[i1!|]t\w*/gi,
  /b[i1!|]tch+\w*/gi,
  /\ba+s+s+h+o+l+e+\w*/gi,
  /\bass(es|hat|hats|wipe|wipes|clown|clowns)?\b/gi,
  /\b(dumb|jack|smart|bad|fat|hard|wise|kick|lard|half)ass(es|ed|ery)?\b/gi,
  /\bd[i1!|]ck(head|heads|s|wad|wads|ish)?\b/gi,
  /\bc+u+n+t+\w*/gi,
  /b+a+s+t+a+r+d+\w*/gi,
  /\bp[i1!|]ss\w*/gi,
  /\bwh+o+r+e+\w*/gi,
  /\bslut+\w*/gi,
  /\btwat\w*/gi,
  /\bwank\w*/gi,
  /\bprick(s|ish)?\b/gi,
  /\bcock(s|sucker|suckers|head|heads)?\b/gi,
];

// Slurs → fully masked (no letters shown).
const SLUR_PATTERNS = [
  /\bn[\s\-_.*+]*[i1!|][\s\-_.*+]*g[\s\-_.*+]*g[\s\-_.*+]*[e3a@][\s\-_.*+]*r?/gi,
  /\bf[a@4][\s\-_.*+]*g[\s\-_.*+]*g[\s\-_.*+]*[o0][\s\-_.*+]*t?/gi,
  /\bkike\w*/gi,
  /\bchink(y|ies)\b/gi,
  /\bspic\b/gi,
  /\bretard(ed|s|ing|o|os)?\b/gi,
  /\bspastic(s|ally)?\b/gi,
  /\bspaz\w*/gi,
];

interface Range { s: number; e: number; full: boolean; }

// Graduated mask: whole-word, profanity keeps 2 leading letters, slurs go full.
function censor(text: string): string {
  const ranges: Range[] = [];
  const collect = (patterns: RegExp[], full: boolean) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        let s = m.index, e = m.index + m[0].length;
        while (s > 0 && /\w/.test(text[s - 1])) s--;
        while (e < text.length && /\w/.test(text[e])) e++;
        ranges.push({ s, e, full });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  };
  collect(VULGAR_PATTERNS, false);
  collect(SLUR_PATTERNS, true);
  if (!ranges.length) return text;

  ranges.sort((a, b) => a.s - b.s);
  const merged: Range[] = [{ ...ranges[0] }];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i].s <= last.e) {
      last.e = Math.max(last.e, ranges[i].e);
      last.full = last.full || ranges[i].full; // a slur anywhere in the span → full mask
    } else merged.push({ ...ranges[i] });
  }

  let out = '', pos = 0;
  for (const { s, e, full } of merged) {
    out += text.slice(pos, s);
    const w = text.slice(s, e);
    if (full) out += '*'.repeat(w.length);
    else out += w.length <= 2 ? w : w.slice(0, 2) + '*'.repeat(w.length - 2);
    pos = e;
  }
  return out + text.slice(pos);
}

// Strip URLs and bare domains so the feed can't spread scam/malware links.
function stripLinks(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|xyz|gg|co|ru|link|click|tk|app|dev)\b\S*/gi, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export interface ModerationResult {
  ok: boolean;
  text: string;
}

// Full pipeline: reject hate, strip links, mask profanity/slurs, cap length.
export function moderateComment(raw: string): ModerationResult {
  if (typeof raw !== 'string') return { ok: false, text: '' };
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, text: '' };
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);

  // Hard block: hate/slur content is never broadcast or stored.
  if (isHate(text)) return { ok: false, text: '' };

  text = stripLinks(text);
  if (!text) return { ok: false, text: '' };

  text = censor(text);
  return { ok: true, text };
}

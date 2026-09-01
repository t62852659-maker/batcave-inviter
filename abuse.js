'use strict';
// Severe abuse, found without asking a model.
//
// Written after the worst message of a day was thrown away and the owner had
// to ban by hand, while the model spent the same hour removing newcomers for
// jokes. With the model in cool mode this layer IS the protection, so it has
// to catch the real thing on its own.
//
// The dominant form of severe abuse in these rooms is RELATIONAL — an insult
// aimed at somebody's mother or sister — and a word list cannot see it,
// because it is built from ordinary words in a particular order:
//
//     maa ki <vulgar>      behen ke <vulgar>      teri maa ko <verb>
//
// Every individual word there is innocent. "Koi apni behen ki pic dikhaega"
// is a real line from these rooms and is NOT this; the completion is what
// makes it abuse, so the completion is what is matched.
//
// Validated against 40,264 recorded messages from the rooms it protects, in
// both directions — the misses matter as much as the catches, because a
// filter that removes people wrongly is worse than none.

// Written as separators rather than spaces: these arrive as "maaki",
// "maa_ki", "maa.ki", "m@@ ki". Leetspeak is folded before matching.
const SEP = '[^a-z]{0,3}';
const REL = '(maa|ma|mata|behen|bahen|bhen|behn|beti|bahan|ammi|amma)';
const POSS = '(ki|ka|ke|ko)';
// The completion. Without one of these the phrase is an ordinary sentence.
const VULGAR = '(lund|land|loda|lodi|lauda|lawda|lodu|chut|choot|bhosda|bhosdi|bhosdike'
    + '|gaand|gand|gaandu|chod|chodu|chudai|chuda|pel|pela|pelte|pelna|pelunga'
    + '|rand|randi|gashti|chinal|kutti|kutiya|jhaat|jhant|tatti|hagg)';

const RELATIONAL = new RegExp(`\\b${REL}${SEP}${POSS}?${SEP}${VULGAR}`, 'i');
// The other order: "<vulgar> teri maa", "chod di teri behen".
// One short word may sit between: "chod DI teri behen", "pel DIYA uski maa".
// Hindi puts the tense marker there, so without this the reverse form only
// matched the terse version nobody actually types.
const GAP = '(\\s+[a-z]{1,4})?';
const RELATIONAL_REV = new RegExp(
    `\\b${VULGAR}\\w*${GAP}${SEP}(teri|tere|tumhari|apni|uski|iski)?${SEP}${REL}\\b`, 'i');

// Standalone slurs aimed at a person. Kept separate from the owner's
// SEVERE_WORDS secret so the code carries a floor that cannot be misconfigured
// to empty — an empty list silently means "allow everything", and that has
// already happened once in this project.
const SLURS = /\b(gashti|randi|chinal|rand|bhosdike|bhosdiwale|madarchod|madrchod|behenchod|bhenchod|bahenchod|lundtopi|gaandu|chutmarike)\b/i;
// NOT "mc" and "bc". They abbreviate the two words above, and in this room
// they are filler — "aaahhh bc", "Bc incidence k ke baad life bdal gaye" —
// used the way an English speaker uses "damn". All five occurrences in 40,264
// recorded messages are that, and none is an attack on anybody. Removing a
// person over an interjection is the mistake this whole layer exists to stop
// making; the spelled-out words are still caught.

// Sexual content aimed at a named person rather than said in general.
const SEXUAL_AT = /\b(nude|nudes|fingering|fingerin|chuswa|chusna|rape|molest|strip|nangi|nanga)\b/i;

/** Fold leetspeak and separators the way the rest of the bot does. */
function normalise(text) {
    return String(text || '').toLowerCase()
        .replace(/[1!|]/g, 'i').replace(/[0]/g, 'o').replace(/[3]/g, 'e')
        .replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't');
}

/**
 * Is this severe abuse, deterministically?
 *
 * @param {string} text
 * @param {(n:string)=>boolean} [isPresent] to tell "aimed at somebody here"
 * @returns {{severe:boolean, why:string}}
 */
function severeAbuse(text, isPresent) {
    const n = normalise(text);
    if (RELATIONAL.test(n) || RELATIONAL_REV.test(n)) {
        return { severe: true, why: 'abuse aimed at family' };
    }
    if (SLURS.test(n)) return { severe: true, why: 'slur' };
    // Sexual language only counts as severe when it is pointed AT somebody in
    // the room. Said in general it is crude, which is a different problem and
    // one the room mostly polices itself.
    if (SEXUAL_AT.test(n) && typeof isPresent === 'function') {
        for (const tok of String(text).split(/[\s,:;!?.]+/)) {
            const who = tok.replace(/^[@+~&%]/, '');
            if (who.length >= 3 && isPresent(who)) {
                return { severe: true, why: `sexual language aimed at ${who}` };
            }
        }
    }
    return { severe: false, why: '' };
}

module.exports = { severeAbuse, RELATIONAL, RELATIONAL_REV, SLURS, SEXUAL_AT, normalise };

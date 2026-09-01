'use strict';
// Dracula goes out into the night and brings someone home.
//
// He sits in channels the owner runs, and occasionally invites one person to
// #batcave. Luna does the same for the other half of the room, so nobody is
// singled out — the split is thematic, and a wrong guess just means the other
// bot would have done it.
//
// THE POOL, NOT THE CLOCK, IS WHAT LIMITS THIS. The bot is identified to the
// FOUNDER account, so a network-level ban would take the channels with it.
// What keeps that from happening is `invited`: nobody is ever asked twice, so
// the eligible pool DRAINS and the loop goes quiet by itself. A one-minute
// gap therefore means a short burst until the room is exhausted, not a
// sustained thousand invites a day. Raise RECRUIT_MIN_GAP_MIN if that burst
// ever draws attention. The remaining guards:
//
//   - random gaps, never a fixed interval (paced by RECRUIT_MIN/MAX_GAP_MIN)
//   - one person at a time, never a sweep
//   - nobody is ever invited twice, so an ignored invite is the end of it
//   - operators, bots, services and anyone already in the room are skipped
//   - only channels the owner has explicitly named
//   - off unless RECRUIT_CHANNELS is set, and killable with !!recruit off

// Owner-set pace: roughly one invitation a minute while there is anyone left
// to invite. That is fast, and it is deliberate — see the note below on why it
// is survivable: `invited` means the pool drains rather than the rate
// sustaining, so this is a short burst that goes quiet on its own.
const MIN_GAP_MS = parseInt(process.env.RECRUIT_MIN_GAP_MIN || '1', 10) * 60000;
const MAX_GAP_MS = parseInt(process.env.RECRUIT_MAX_GAP_MIN || '2', 10) * 60000;
const ANNOUNCE_GAP_MS = parseInt(process.env.RECRUIT_ANNOUNCE_MIN || '240', 10) * 60000;
// The FIRST attempt after startup is deliberately much sooner than the rest.
// The host restarts this bot every six hours, and every restart resets the
// timer — so with a 45-180 minute first gap, a few redeploys in an afternoon
// mean it never fires at all. A short opening interval makes the feature
// survive its own deployment; the long gaps take over from the second firing.
const FIRST_GAP_MS = parseInt(process.env.RECRUIT_FIRST_MIN || '1', 10) * 60000;
// How many people each firing invites. This was fixed at one, which is why
// recruiting felt slow no matter how short the gap got: at one a minute, and
// with most invitations simply ignored, an hour of recruiting reaches sixty
// people and brings perhaps one. The gap controls how OFTEN we ask; this
// controls how MANY, and it was the one that was actually limiting.
//
// Kept modest on purpose. An invite is delivered privately and costs the
// recipient nothing, but a burst of them from one client is what invite-flood
// protection is looking for, and this bot has been banned from a channel
// before. Three a minute across several rooms is brisk without being a flood.
const PER_ROUND = Math.max(1, parseInt(process.env.RECRUIT_PER_ROUND || '3', 10));
// How long before somebody may be invited again. Long enough that a second
// invitation reads as a fresh welcome rather than nagging.
const REASK_AFTER_MS = parseInt(process.env.RECRUIT_REASK_DAYS || '21', 10) * 86400000;

// A guess, and a poor one — nicknames are not gender. It only decides WHICH
// bot extends the invitation, so being wrong costs nothing. Extend with
// FEMININE_HINTS rather than editing this list.
const DEFAULT_HINTS = [
    'aditi', 'ananya', 'anjali', 'anu', 'arpita', 'bella', 'chuza', 'diya',
    'divya', 'gauri', 'gudiya', 'isha', 'jaan', 'kiara', 'kritika', 'lily',
    'luna', 'meena', 'minal', 'misha', 'neha', 'nikki', 'pari', 'payal',
    'pooja', 'priya', 'radha', 'riya', 'rose', 'sakhi', 'sana', 'sara',
    'shweta', 'simran', 'sneha', 'sonia', 'sweety', 'tanu', 'tina', 'zara',
    'angel', 'baby', 'barbie', 'doll', 'gudia', 'queen', 'princess', 'ladki',

    // Widened after a live count: 85 of 100 people in #allindiachat.com were
    // being written off as "not my half", including _Esha18 and _Shruti_ —
    // names simply missing from a list of forty-eight. A recruiter that ignores
    // five sixths of a room is not selective, it is broken.
    'esha', 'shruti', 'kavya', 'ritu', 'meera', 'aarti', 'swati', 'rekha',
    'sunita', 'jyoti', 'preeti', 'preity', 'manisha', 'nikita', 'sakshi',
    'ishita', 'tanya', 'komal', 'kirti', 'bhavna', 'deepa', 'deepika', 'madhu',
    'nidhi', 'pallavi', 'rashmi', 'seema', 'shalini', 'sonal', 'vandana',
    'varsha', 'yamini', 'bhumi', 'gauri', 'heena', 'juhi', 'kajal', 'lata',
    'namrata', 'pinky', 'rani', 'ruchi', 'sapna', 'shilpa', 'smita', 'sonam',
    'suman', 'trisha', 'usha', 'vidya', 'asha', 'anita', 'archana', 'bina',
    'chandni', 'geeta', 'hema', 'indu', 'kanchan', 'kiran', 'kusum', 'mala',
    'mamta', 'mona', 'neelam', 'nisha', 'poonam', 'rachna', 'rekha', 'renu',
    'roshni', 'sadhna', 'sarita', 'savita', 'shanti', 'sheetal', 'shobha',
    'sudha', 'sushma', 'urmila', 'vaishali', 'vinita', 'aisha', 'ayesha',
    'farah', 'fatima', 'nazia', 'rukhsar', 'sadia', 'saira', 'shabnam',
    'zoya', 'noor', 'mehak', 'anushka', 'alia', 'kareena', 'katrina',,
    // Curated, not mined. Auto-learning these from the room produced
    // "teen", "young", "busty" and "camgirlpaid" — a list learned from
    // live traffic poisons itself, so candidates get read by a human.
    'aaliya', 'aanchal', 'aaradhya', 'aashi', 'aastha', 'aayushi',
    'adishi', 'akanksha', 'akshara', 'alisha', 'amrita', 'anisha',
    'anitha', 'ankana', 'ankita', 'anshika', 'anupama', 'aparna',
    'ashwini', 'avani', 'bhavana', 'bhavya', 'bhumika', 'chaitali',
    'chesta', 'chhavi', 'damini', 'deepti', 'devika', 'dhara',
    'dimple', 'disha', 'ekta', 'falguni', 'gayatri', 'gunjan',
    'harleen', 'harshita', 'hina', 'ishani', 'ishika', 'jasmine',
    'jaya', 'jhanvi', 'kalpana', 'kamini', 'kanika', 'karishma',
    'kashish', 'kavita', 'khushbu', 'khushi', 'kriti', 'lavanya',
    'madhuri', 'mahima', 'malti', 'manjot', 'manju', 'manvi',
    'meenakshi', 'megha', 'mitali', 'mohini', 'monika', 'mounika',
    'mrinal', 'muskan', 'nandini', 'nandni', 'natasha', 'navya',
    'neeru', 'niharika', 'nilofar', 'nimisha', 'nishtha', 'nita',
    'nupur', 'parul', 'peehu', 'prachi', 'pragya', 'prerna',
    'prity', 'priyal', 'priyanka', 'purva', 'radhika', 'rakhi',
    'ramya', 'reena', 'rhea', 'richa', 'rima', 'rimjhim',
    'rinku', 'ritika', 'ruhi', 'rupali', 'safia', 'samiksha',
    'sandhya', 'sanjana', 'sarika', 'saumya', 'shefali', 'shikha',
    'shivani', 'shraddha', 'shreya', 'sonali', 'stuti', 'suhana',
    'sujata', 'supriya', 'surbhi', 'tanisha', 'tanushree', 'tanvi',
    'tara', 'tulika', 'uma', 'urvashi', 'vani', 'vishakha',
    'yashika', 'zainab',,
    'anshu', 'anushree', 'anvi', 'arya', 'bhoomi', 'chanchal',
    'charu', 'daksha', 'damayanti', 'darshana', 'eshita', 'gargi',
    'gitanjali', 'ishwari', 'jaanvi', 'janvi', 'jiya', 'kajol',
    'kanak', 'lakshmi', 'leena', 'mahi', 'manvitha', 'meghna',
    'mira', 'namita', 'nandita', 'nayana', 'neelu', 'nidhii',
    'nikhita', 'nutan', 'palak', 'prabha', 'pratibha', 'prisha',
    'priti', 'priyanshee', 'priyanshi', 'puja', 'rachita', 'radhi',
    'rashi', 'riddhi', 'roopa', 'rubi', 'ruby', 'saloni',
    'samruddhi', 'sanya', 'shreeya', 'simmi', 'sneh', 'sonu',
    'sweta', 'tanmayi', 'trupti', 'urja', 'vaidehi', 'vasudha',
    'vidhi', 'vinaya', 'vrinda', 'yamuna',,
    'alishba', 'alka', 'ambika', 'amrit', 'anamika', 'anandi',
    'anaya', 'anisa', 'anju', 'ankeeta', 'annu', 'anshita',
    'apeksha', 'archita', 'arshi', 'arti', 'asfiya', 'asma',
    'avantika', 'ayushi', 'bhagyashree', 'bhairavi', 'bhoomika', 'bindiya',
    'chahat', 'chandrika', 'charulata', 'chetna', 'chhaya', 'darshita',
    'deeksha', 'devanshi', 'dhanashree', 'dhriti', 'dipali', 'dipti',
    'divyanshi', 'ekant', 'falak', 'farheen', 'gauhar', 'geetika',
    'ghazal', 'gitika', 'gulnaz', 'hafsa', 'hansa', 'harsha',
    'haseena', 'hiba', 'himani', 'hiral', 'huma', 'iram',
    'ismat', 'jasleen', 'jasmin', 'jyotsna', 'kainat', 'kalyani',
    'kamna', 'kanchana', 'kashvi', 'khadija', 'khushboo', 'kismat',
    'kumkum', 'lajwanti', 'lalita', 'laxmi', 'madhavi', 'mahek',
    'mahira', 'maitri', 'malaika', 'mallika', 'mandira', 'mansi',
    'maryam', 'mehrunisa', 'mehwish', 'mishka', 'mubina', 'mumtaz',
    'naaz', 'nafisa', 'nagma', 'naina', 'najma', 'namrita',
    'nandana', 'narmada', 'nasreen', 'navjot', 'nayantara', 'neelima',
    'neetu', 'nehal', 'nilofer', 'nimrat', 'nitya', 'noorjahan',
    'nusrat', 'pakhi', 'palakh', 'pallabi', 'pamela', 'parineeta',
    'poornima', 'pranjal', 'prathana', 'purnima', 'rabia', 'raima',
    'rajni', 'rakshita', 'ramandeep', 'rashida', 'rehana', 'renuka',
    'reshma', 'revathi', 'ridhima', 'rimpi', 'rinki', 'roopali',
    'roshan', 'rubina', 'rupinder', 'sabina', 'safiya', 'sahiba',
    'sakina', 'salma', 'samina', 'sanober', 'sarojini', 'sayani',
    'seerat', 'sehrish', 'shabana', 'shagufta', 'shahnaz', 'shaina',
    'shalu', 'shamim', 'shanaya', 'sharmila', 'shashi', 'shazia',
    'sheeba', 'shehnaz', 'shivangi', 'shobhna', 'shrishti', 'shubhi',
    'simrat', 'sitara', 'smriti', 'snehal', 'sonakshi', 'suhani',
    'sukanya', 'sumaiya', 'sumati', 'sunaina', 'sunidhi', 'sushmita',
    'swarna', 'tabassum', 'tahira', 'tamanna', 'tanuja', 'tanushka',
    'tarannum', 'tasneem', 'tejal', 'trishna', 'tulsi', 'urmi',
    'urvi', 'vaishnavi', 'vanshika', 'veena', 'vibha', 'vidhya',
    'yashoda', 'yasmin', 'zahra', 'zarina', 'zeenat', 'zohra',
];

// Self-description, which is how people in these rooms actually signal gender.
//
// Two patterns, because they need different strictness. Words run together in
// nicknames — "IndiangirlUSA" has no separator anywhere — so a word marker has
// to match as a substring or it misses the obvious cases. The AGE-and-letter
// form cannot: bare "f" or two digits appear in half the nicks on the network,
// so those keep their boundaries.
const FEM_WORD = /(female|girl|ladki|bhabhi|behen|aunty|didi|lady|mrs|miss|queen|princess)/i;
// "f25delhi" was rejected because the age had to be followed by a NON-letter,
// so every "f23mumbai" and "24fpune" in the room read as somebody else's half.
// The trailing boundary is gone; the leading one stays, or "wolf25" matches.
// Two forms, and they need DIFFERENT boundaries — one rule for both is what
// made this miss the commonest label in the room.
//
//   <digits>f  — "Aanchal36f", "Priya25f", "Aaliya26f". The age is glued to
//                the END of a name, so demanding a non-letter before it
//                rejects every one of them. Measured against 3023 real nicks
//                from #allindiachat.com: "Aanchal36fTWINSdelhi" MISSED.
//   f<digits>  — "f25delhi", "_f_23". Here the boundary must STAY, or "wolf25"
//                and "Rolf30" read as women.
const FEM_AGE  = /(^|[^a-z0-9])f\s?\d{2}|\d{2}\s?f/i;
// A bare F between separators — "_______F_Delhi", "Riya|F|22", "(f)" — is the
// commonest marker of all in these rooms and was not being read at all.
const FEM_MARK = /(^|[^a-z0-9])f([^a-z0-9]|$)/i;

// Nicks the room's own AKICK list would reject on sight. Mirrors the patterns
// set on ChanServ — keep the two in step, or the recruiter will keep inviting
// people the channel instantly bans.
const UNWELCOME = ['horny', 'slut', 'whore', 'milf', 'incest', 'porn', 'nangi',
    'chudai', 'bhosdi', 'madarchod', 'gaand', 'chudwao', 'bitch', 'cuck', 'randi',
    'lund', 'paid', 'cam4', 'f4m', 'm4f', 'nude', 'escort', 'bull4', 'sexy',
    // Added after the recruiter invited "Varun-Singh-love-teen-girl" into the
    // owner's room. Nothing in the list covered it, so a nick advertising an
    // interest in teenagers was read as an ordinary person and sent an
    // invitation. This is the one category where a false positive costs
    // nothing and a false negative is unforgivable.
    'teen', 'teenage', 'jailbait', 'lolita', 'loli', 'schoolgirl', 'schoolboy',
    'underage', 'minor', 'preteen', 'kiddie', 'childs', 'child', 'yngg',
    'daddysgirl', 'stepdaughter', 'stepson', 'rape', 'molest',
    // Invited into the owner's room on 2026-08-30: "_F_Groped". The list had
    // 'rape' and 'molest' and nothing between them and ordinary words, so a
    // nick advertising sexual assault read as an ordinary person and was sent
    // an invitation. This is the category where a false positive costs nothing
    // and a false negative is not recoverable — somebody sees it in their own
    // room and it was the bot that brought them there.
    'groped', 'grope', 'groping', 'forced', 'nonconsent', 'noconsent',
    'unwilling', 'drugged', 'passedout', 'sleeping', 'blackmail'];

// Solicitation, learned from 95 nicknames actually seen in #allindiachat.com
// on 2026-08-27. The substring list above caught 7 of them; these fourteen
// would have been INVITED into #batcave that day, among them
// "Daddy_Will_Use_U_Deep_Secretly" and "jeerrk_on_wife_pic".
//
// Matched as WHOLE TOKENS, not substrings, because these words are short and
// live inside innocent ones — "host" is in ghost, "dom" is in freedom, "cam"
// is in Camila, "rp" is in Sharp. A nick is split on separators and on
// camelCase, which is how these names are actually built.
const SOLICIT = new Set([
    'bull', 'bulls', 'cam', 'cams', 'camsex', 'host', 'hosting', 'hosts',
    'rp', 'roleplay', 'daddy', 'daddies', 'f2f', 'hw', 'hotwife', 'cock',
    'cocks', 'dick', 'dicks', 'feet', 'dom', 'doms', 'domme', 'kinky', 'kink',
    'sissy', 'cuckold', 'jerk', 'jerkoff', 'wank', 'horny', 'naughty',
    'meetup', 'realmeet', 'sexchat', 'dirtychat', 'onlyfans', 'snap',
    // Abbreviated in the room itself. "shower" alone stays innocent —
    // "Shower_Thoughts" is an ordinary name and must keep working.
    'gshower', 'goldenshower', 'ws',
]);

// Words that give themselves away as a SUFFIX with no separator in front —
// "Muslimbull", "BongHw". Kept to a short list and matched only at the end of
// the nick, so "bullet" and "bulletin" are untouched.
const SOLICIT_SUFFIX = ['bull', 'bulls', 'cam', 'cams', 'hw', 'cock', 'dick'];

// Individually innocent, damning together. "wife" is ordinary and "pic" is
// ordinary; "jeerrk_on_wife_pic" is not. One word from each group is the
// signal — a subject and something to do with it — which leaves names like
// "Priya_Chat_Fun" alone because they carry no subject at all.
const SUBJECT = new Set(['wife', 'wifes', 'bhabhi', 'aunty', 'aunti', 'milf',
    'gf', 'girlfriend', 'girls', 'ladies', 'housewife']);
const OFFER = new Set(['pic', 'pics', 'vid', 'vids', 'video', 'videos', 'cam',
    'show', 'jerk', 'jeerrk', 'fap', 'nude', 'nudes', 'leak', 'leaks', 'sell']);

/** Split a nickname the way it was actually built: separators and camelCase. */
function nickTokens(nick) {
    return String(nick || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z]+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase());
}

// A nick that advertises being under eighteen. Never invited, whatever else it
// says: "f16", "16f", "17yo", "15 y". The feminine-marker patterns match these
// too, which is exactly why this has to be checked FIRST — "f16" reads as a
// woman to the classifier and as a child to anybody else.
// Two patterns, because they need different endings.
//
// The single regex this replaces required a NON-alphanumeric character after
// the age, so "15f_mumbai" was caught and "f16delhi" was not — an age glued
// straight to a word walked through, and that is the commonest form the nick
// actually takes. A live test invited f16delhi.
//
// A teen age binds tightly enough to need no trailing boundary: "f16delhi"
// cannot be read as anything but a sixteen-year-old in Delhi.
const UNDERAGE_TEEN = /(^|[^a-z0-9])((f|m)\s?1[0-7]|1[0-7]\s?(f|m|yo|yrs?|y)|age\s?1[0-7])/i;
// A single digit is genuinely ambiguous — "m4rk" is a name — so that form
// still needs the boundary. The asymmetry is deliberate: a false positive
// here costs one invitation nobody sends, and a false negative invites a
// child into an adult room.
const UNDERAGE_SINGLE = /(^|[^a-z0-9])((f|m)\s?[1-9]|[1-9]\s?(f|m|yo|yrs?|y))([^a-z0-9]|$)/i;
const UNDERAGE = {
    test: (s) => UNDERAGE_TEEN.test(String(s)) || UNDERAGE_SINGLE.test(String(s)),
};

const NEVER = new Set(['chanserv', 'nickserv', 'operserv', 'hostserv', 'memoserv',
    'botserv', 'global', 'chanbot', 'luna1', 'vampire', 'dracula', 'notsobot']);

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (lo, hi) => lo + Math.floor(Math.random() * Math.max(1, hi - lo));

class Recruiter {
    /**
     * @param {{send:Function, say:Function, nick:string}} bot
     * @param {object} deps  membersOf(chan), prefixOf(chan,nick), homeChannel
     */
    constructor(bot, deps) {
        this.bot = bot;
        this.deps = deps;
        this.channels = (process.env.RECRUIT_CHANNELS || '')
            .split(',').map((c) => c.trim()).filter(Boolean)
            .map((c) => (c.startsWith('#') ? c : `#${c}`));
        this.enabled = this.channels.length > 0
            && /^(1|true|yes|on)$/i.test(process.env.RECRUIT_ON || 'on');
        this.hints = DEFAULT_HINTS.concat(
            (process.env.FEMININE_HINTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
        this.target = (process.env.RECRUIT_TARGET || 'feminine').toLowerCase();
        // nick -> when we asked. An expiry rather than a permanent set: a
        // never-forgetting list turns a finite room into an empty pool within
        // days, and someone who ignored an invitation three weeks ago is not
        // being harassed by a second one.
        this.invited = new Map();
        this.recent = [];              // last few invites, so !!recruit can show its work
        this.timers = {};             // name -> the ONE live handle for that job
        this.started = false;
    }

    /**
     * Is this bot the one that should invite this person?
     *
     * The split was thematic — Dracula invites one half, Luna the other, so
     * nobody is singled out. Luna's half was never built, which left ~90% of
     * every source room permanently uninvitable: a live count showed 173 of 189
     * people in one channel rejected purely for "no name match", and the tiny
     * remainder drains for good because nobody is ever asked twice. The result
     * was a recruiter that truthfully reported "nobody eligible" in a room of
     * two hundred.
     *
     * RECRUIT_TARGET picks the half: 'feminine' (the original behaviour),
     * 'other' (the complement, for whichever bot covers it), or 'all' when one
     * bot is doing the whole job alone — which is the honest setting while only
     * one of them recruits.
     */
    mine(nick) {
        if (this.target === 'all') return true;
        const fem = this.looksFeminine(nick);
        return this.target === 'other' ? !fem : fem;
    }

    /**
     * Have we already invited this person under a different name?
     *
     * The deps provide the other nicks seen on the same connection. Absent
     * that (older wiring, or a nick we have never seen speak) this answers
     * false, which is the safe direction: a duplicate invitation is a small
     * cost, and refusing to invite anybody we cannot identify would be a
     * large one.
     */
    alreadyAskedAnAlt(nick) {
        if (typeof this.deps.altsOf !== 'function') return false;
        for (const alt of this.deps.altsOf(nick) || []) {
            if (this.askedRecently(String(alt).toLowerCase())) return true;
        }
        return false;
    }

    /** Nicknames that look feminine enough for Dracula to take this one. */
    looksFeminine(nick) {
        // Explicit self-description first, and it is far more reliable than a
        // name list: people in these rooms label themselves "f29", "21f",
        // "IndianGirlUSA". Guessing from a name's ending does not work — it
        // reads Aakash, Aditya and RajCanada as feminine.
        if (FEM_WORD.test(nick) || FEM_AGE.test(nick) || FEM_MARK.test(nick)) return true;
        // Name hints match at the START of the nick, or as a whole token —
        // never as a bare substring anywhere inside it.
        //
        // Measured: "isha" was matching Krishan, Nishant and Rishabh, so three
        // men were being classified as women and invited by a recruiter aimed
        // at the other half. It is the same mistake the nickname filter
        // already learned once, when it refused `ghost` for containing "host"
        // and `freedom` for containing "dom". Short names inside longer names
        // is exactly where substring matching fails.
        //
        // People put their name at the FRONT of a nick — "Priya25f",
        // "Aanchal_delhi", "riya|22" — so the head of the nick and its
        // separator-delimited tokens are where a name actually lives.
        const raw = nick.toLowerCase();
        // No early return on an empty head: "_Esha18" and "_Shruti_" begin
        // with a separator, so the head is empty and the name lives in the
        // TOKENS. Bailing out here skipped both, which the suite caught.
        const head = (raw.match(/^[a-z]+/) || [''])[0];
        const tokens = raw.split(/[^a-z]+/).filter(Boolean);
        if (!head && !tokens.length) return false;
        // EXACT, not a prefix: "Nisha" is a prefix of "Nishant", so prefix
        // matching still read a man as a woman. A nick's head IS the person's
        // name, so it either is a name we know or it is not — and the recall
        // this gives up is recovered properly by the standbys recruiting the
        // other half, not by guessing harder here.
        // Exact, OR a name with a surname stuck to it.
        //
        // Measured against 1439 real nicks: exact matching found 101. It was
        // missing "aditimishra" and "akanshas" — Aditi and Akansha with a
        // surname or a letter run on, which is how half the room writes a
        // nick. Pure prefix matching is what read Nishant as Nisha, so the
        // leftover decides: a SURNAME is three or more characters, a male
        // name extended is one or two.
        //
        //   aditimishra  ->  aditi  + "mishra" (6)  accepted
        //   nishant      ->  nisha  + "nt"     (2)  refused
        //
        // And only for hints of five characters or more, because a short name
        // inside a longer one is exactly the ghost/host mistake.
        const surnamed = (h) => h.length >= 5 && head.startsWith(h) && head.length - h.length >= 3;
        return this.hints.some((h) => head === h || tokens.includes(h) || surnamed(h));
    }

    /**
     * Would this person be thrown out the moment they arrived?
     *
     * Inviting somebody the channel's own AKICK list bans on sight is worse
     * than pointless: it burns the invitation, it looks like a trap to them,
     * and it is how a recruiter drags the exact population that raided the room
     * back through the front door. The source rooms are full of accounts
     * advertising sex work, and the whole reason recruiting was widened this
     * morning is the reason the room was attacked tonight.
     */
    unwelcome(nick) {
        // Age first. The feminine classifier reads "f16" as a woman; it is a
        // child, and inviting one into an adult room is the single worst thing
        // this code could do.
        if (UNDERAGE.test(String(nick || ''))) return 'underage';
        const tok = nickTokens(nick);
        const hit = tok.find((t) => SOLICIT.has(t));
        if (hit) return `solicitation ("${hit}")`;

        const low = String(nick || '').toLowerCase().replace(/[^a-z]/g, '');
        const tail = SOLICIT_SUFFIX.find((w) => low.endsWith(w));
        if (tail) return `solicitation ("${tail}")`;

        const subject = tok.find((t) => SUBJECT.has(t));
        const offer = tok.find((t) => OFFER.has(t));
        if (subject && offer) return `solicitation ("${subject}" + "${offer}")`;
        const n = nick.toLowerCase().replace(/[^a-z0-9]/g, '');
        return UNWELCOME.some((w) => n.includes(w));
    }

    /** Asked so recently that asking again would be pestering. */
    askedRecently(nickLower) {
        const at = this.invited.get(nickLower);
        return Boolean(at && Date.now() - at < REASK_AFTER_MS);
    }

    eligible(chan) {
        const out = [];
        for (const nick of this.deps.membersOf(chan)) {
            const n = nick.toLowerCase();
            if (NEVER.has(n) || n === this.bot.nick.toLowerCase()) continue;
            if (this.askedRecently(n)) continue;
            if (this.alreadyAskedAnAlt(nick)) continue;
            // Never an operator. Being invited by a bot reads as spam to the
            // people most able to act on it, and that is how a bot gets banned.
            if (/[~&@%]/.test(this.deps.prefixOf(chan, nick))) continue;
            // Already home.
            if (this.deps.membersOf(this.deps.homeChannel).some(
                (m) => m.toLowerCase() === n)) continue;
            if (this.unwelcome(nick)) continue;
            if (!this.mine(nick)) continue;
            out.push(nick);
        }
        return out;
    }

    /**
     * Why nothing happened. "Nobody eligible" is true and useless — it cannot
     * distinguish "I am not in that room", "I cannot see its member list",
     * "everyone there is an operator" and "no nickname matched". Each needs a
     * different fix, so each gets counted.
     */
    explain() {
        const lines = [];
        for (const chan of this.channels) {
            const all = this.deps.membersOf(chan);
            if (!all.length) {
                lines.push(`${chan}: NOT IN THE ROOM — cannot see anyone. `
                    + `Check for a ban: /mode ${chan} +b`);
                continue;
            }
            let ops = 0, bots = 0, already = 0, unmatched = 0, asked = 0, ok = 0, unwelcome = 0;
            const home = this.deps.membersOf(this.deps.homeChannel).map((m) => m.toLowerCase());
            for (const nick of all) {
                const n = nick.toLowerCase();
                if (NEVER.has(n) || n === this.bot.nick.toLowerCase()) { bots++; continue; }
                if (this.askedRecently(n)) { asked++; continue; }
                // Already asked under ANOTHER name on the same connection.
                //
                // Cloaks hash the real address, so nicks sharing one are one
                // person. Without this the recruiter invited "female24",
                // "female33_actress", "actresslustyshag" and
                // "female33_pornstar" as four prospects — they are one man's
                // personas, and four invitations from a bot is how a room
                // acquires a reputation for spamming.
                if (this.alreadyAskedAnAlt(nick)) { asked++; continue; }
                if (/[~&@%]/.test(this.deps.prefixOf(chan, nick))) { ops++; continue; }
                if (home.includes(n)) { already++; continue; }
                if (this.unwelcome(nick)) { unwelcome++; continue; }
                if (!this.mine(nick)) { unmatched++; continue; }
                ok++;
            }
            lines.push(`${chan}: ${all.length} present — ${ok} eligible `
                + `(${ops} ops, ${bots} bots, ${already} already home, ${asked} asked before, `
                + `${unmatched} not my half, ${unwelcome} would be banned on arrival)`);
        }
        if (lines.length) {
            // Say what "not my half" costs and where those people go. "0
            // eligible" beside "864 not my half" reads as the bot being
            // broken, when it is the bot correctly covering a tenth of a room
            // that nobody else is covering. The number is the argument.
            lines.push(this.target === 'all'
                ? 'I invite everyone (RECRUIT_TARGET=all).'
                : `I invite the "${this.target}" half — the rest are nobody's job `
                  + 'right now. RECRUIT_TARGET=all takes them, or a standby runs $$recruit.');
        }
        return lines.length ? lines : ['no channels configured'];
    }

    /**
     * Try the channels in random order and stop at the first with somebody in
     * it. Picking ONE at random and giving up when it was empty meant a room
     * the bot cannot even enter — #allindiachat.com bans it, so it yields zero
     * every time — silently ate a third of all attempts.
     */
    inviteOne() {
        if (!this.enabled) return null;
        const order = this.channels.slice().sort(() => Math.random() - 0.5);
        for (const chan of order) {
            const who = this.eligible(chan);
            if (!who.length) continue;
            const target = pick(who);
            this.invited.set(target.toLowerCase(), Date.now());
            this.bot.send(`INVITE ${target} ${this.deps.homeChannel}`);
            // An INVITE is delivered privately to the person invited, so from
            // inside the home channel a working recruiter and a broken one look
            // exactly alike. Keep the last few so !!recruit can show its work.
            this.recent.unshift({ target, chan, at: Date.now() });
            this.recent.length = Math.min(this.recent.length, 8);
            return { target, chan };
        }
        return null;
    }

    /**
     * One firing's worth of invitations.
     *
     * Drawn one at a time rather than as a batch from a single room, so the
     * picks spread across whichever channels currently have eligible people —
     * eligible() re-runs each time and invited() is updated between draws, so
     * nobody is asked twice in the same round.
     *
     * @param {number} [n] how many to send; defaults to RECRUIT_PER_ROUND
     */
    inviteRound(n = PER_ROUND) {
        const sent = [];
        for (let i = 0; i < n; i++) {
            const r = this.inviteOne();
            if (!r) break;                      // nobody left anywhere
            sent.push(r);
        }
        return sent;
    }

    announce() {
        if (!this.enabled) return null;
        const chan = pick(this.channels);
        this.bot.say(chan, '\x0304🦇\x03 The BatCave stirs at '
            + `\x02${this.deps.homeChannel}\x02 — the door is open, the night is long, `
            + 'and the company is strange. All welcome.');
        return chan;
    }

    /**
     * Random gaps, never a fixed interval: a metronome is what a bot looks like.
     *
     * The loops ALWAYS run, and each firing asks whether recruiting is on. The
     * previous version returned early when it was off, so the timers were never
     * created — and since the bot boots before anyone types !!recruit on, the
     * toggle flipped a boolean with nothing behind it. It looked enabled and
     * could only ever act when someone typed !!recruit now by hand.
     *
     * State that can be switched at runtime must not decide whether the
     * machinery exists. It decides what the machinery does when it fires.
     */
    start(log) {
        if (this.started) return;                // idempotent
        this.started = true;
        this.log = log;
        log(this.enabled ? 'OK' : 'INFO',
            this.enabled
                ? `Recruiting from ${this.channels.join(', ')} into ${this.deps.homeChannel}.`
                : 'Recruiting is idle (no channels set, or turned off) — the timer is running '
                  + 'and will act the moment it is switched on.');
        this.loop('invite', FIRST_GAP_MS);
        this.loop('announce', FIRST_GAP_MS * 3);
    }

    /**
     * One self-rescheduling timer per job, held by NAME.
     *
     * The previous version pushed every rescheduling onto an array that was
     * only ever emptied by stop(), so a timer that had already fired stayed in
     * the list forever — at a gap of a minute that is 1440 dead handles a day.
     * Keying by name means each job has exactly one live timer, and it can be
     * replaced (see soon()) instead of only ever appended to.
     */
    loop(name, first) {
        const lo = name === 'invite' ? MIN_GAP_MS : ANNOUNCE_GAP_MS;
        const hi = name === 'invite' ? MAX_GAP_MS : ANNOUNCE_GAP_MS * 2;
        const delay = first != null ? first : between(lo, hi);
        clearTimeout(this.timers[name]);
        this.timers[name] = setTimeout(() => {
            try {
                if (name === 'invite') {
                    const sent = this.inviteRound();
                    if (sent.length) {
                        this.log('INFO', `Invited ${sent.map((r) => `${r.target}(${r.chan})`).join(', ')}.`);
                    } else {
                        // Silence here used to be indistinguishable from working:
                        // no invite, no log, and the room simply stayed empty.
                        this.log('WARN', 'Nobody eligible in any recruit channel this round.');
                    }
                } else {
                    const c = this.announce();
                    if (c) this.log('INFO', `Announced in ${c}.`);
                }
            } catch (e) { this.log('ERR', `recruit: ${e.message}`); }
            this.loop(name, null);               // settle into the normal gaps
        }, delay);
        if (name === 'invite') this.nextAt = Date.now() + delay;
    }

    /**
     * Bring the next invitation forward. Switching recruiting ON used to leave
     * whatever gap had been rolled while it was OFF still standing, so someone
     * who turned it on could be told the next attempt was two hours away — the
     * toggle appeared to do nothing. Turning a thing on should make it happen.
     */
    soon() {
        if (!this.started) return;
        this.loop('invite', FIRST_GAP_MS);
    }

    /** How many each firing sends, so !!recruit can report it truthfully. */
    get perRound() { return PER_ROUND; }

    /** Roughly how long until the next attempt, for !!recruit to report. */
    dueIn() {
        if (!this.started) return 'not scheduled';
        if (!this.nextAt) return `up to ${Math.round(MAX_GAP_MS / 60000)}m`;
        const mins = Math.max(0, Math.round((this.nextAt - Date.now()) / 60000));
        return mins < 1 ? 'in under a minute' : `in about ${mins}m`;
    }

    stop() {
        Object.values(this.timers).forEach(clearTimeout);
        this.timers = {};
        this.started = false;
    }
}

/**
 * Rooms discovered from the server's own channel list.
 *
 * /LIST answers with every public channel on the network — nearly twenty
 * thousand users' worth here — so the value is finding rooms nobody thought to
 * configure. The danger is equally obvious: joining hundreds of channels and
 * inviting out of all of them is indistinguishable from spam, and gets a bot
 * K-lined rather than popular.
 *
 * So this only ever SUGGESTS. It ranks candidates and hands them back for a
 * person to approve, exactly as the word-list mining does — a rule learned
 * from live traffic and applied automatically poisons itself.
 */
const OFF_LIMITS = /^#+(help|oper|service|staff|admin|abuse|log|security|test|bot)/i;

class Discovery {
    constructor(opts = {}) {
        this.minUsers = Number(opts.minUsers || 15);
        this.max = Number(opts.max || 12);
        this.found = [];
        this.collecting = false;
    }

    /** Begin. The caller sends LIST; we just get ready to read the answer. */
    start() { this.found = []; this.collecting = true; }

    /** One RPL_LIST (322) row. */
    absorb(chan, users, topic, { already = [], home = '' } = {}) {
        if (!this.collecting) return;
        const n = Number(users) || 0;
        const c = String(chan || '');
        if (!c.startsWith('#')) return;
        if (n < this.minUsers) return;                       // a dead room is not a source
        if (OFF_LIMITS.test(c)) return;                      // staff and service rooms
        if (c.toLowerCase() === String(home).toLowerCase()) return;
        if (already.some((a) => a.toLowerCase() === c.toLowerCase())) return;
        this.found.push({ chan: c, users: n, topic: String(topic || '').slice(0, 60) });
    }

    /** RPL_LISTEND (323). Biggest rooms first, capped. */
    finish() {
        this.collecting = false;
        return this.found.sort((a, b) => b.users - a.users).slice(0, this.max);
    }
}

module.exports = { Discovery, Recruiter };

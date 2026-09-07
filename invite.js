#!/usr/bin/env node
'use strict';
/**
 * A local room inviter — using Dracula's ACTUAL recruiter.
 *
 *   node invite.js <nick> <#room> [#source,#source...]
 *
 * recruit.js in this folder is a byte-for-byte copy of the file the live bot
 * runs. It is imported, not reimplemented, so "the same method to find whom to
 * invite" is true by construction rather than by my say-so.
 *
 * The first version of this file did its own thing: invite everyone it sees.
 * That is not what Dracula does, and one of the differences was not a matter
 * of taste — the real recruiter refuses any nick that self-labels as a minor
 * ("f16", "15f", "age 14") BEFORE any other test. A naive inviter sends those
 * an invitation to an adult room.
 *
 * This file is now only the plumbing: connect, track who is in which room,
 * hand that to the recruiter, and obey the server when it says stop.
 */

const tls = require('tls');
const net = require('net');
const { Recruiter } = require('./recruit.js');
// A copy of the live bot's abuse detector, imported rather than rewritten, so
// this agrees with Dracula about what counts. It is deliberately conservative
// — it catches "maa ki chut" and lets a lot through — because in a room full
// of banter a false positive costs a regular their voice and a miss costs
// nothing but a second look.
const { severeAbuse } = require('./abuse.js');

const argv = process.argv.slice(2);
const nick = argv[0];
// let, not const: the target room is changeable from IRC with "into #room",
// so the bot never has to be redeployed to point it somewhere else.
let room = argv[1];
const sources = (argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!nick || !room || !room.startsWith('#')) {
    console.error(`
  Usage:  node invite.js <nick> <#room> [#source,#source...]

    <nick>     what this bot is called on IRC
    <#room>    the room it invites people TO  (you need ops there if it is +i)
    [sources]  rooms to find people IN, comma separated

  Examples:
    node invite.js Doorman "#room1" "#room2,#room3"
    RECRUIT_TARGET=all node invite.js Doorman "#room1" "#room2"

  It uses the live bot's own recruiter (recruit.js), so the choice of who to
  invite is identical: the same name lists, the same self-label reading, the
  same refusal of solicitation nicks, and the same hard skip of anybody whose
  nick reads as underage.

  Environment (all optional):
    RECRUIT_TARGET    feminine (default, same as Dracula) | other | all
    RECRUIT_PER_ROUND how many per round, default 3
    RECRUIT_MIN_GAP_MIN / RECRUIT_MAX_GAP_MIN   minutes between rounds, default 1-2
    RECRUIT_REASK_DAYS  do not re-ask within this many days, default 21
    FEMININE_HINTS    extra names, comma separated
    NICKSERV_PASS     identify on connect
    IRC_SERVER / IRC_PORT / IRC_TLS
`);
    process.exit(1);
}

const SERVER = process.env.IRC_SERVER || 'irc.hybridirc.com';
const PORT = Number(process.env.IRC_PORT || 6697);
const USE_TLS = !/^(0|off|false|no)$/i.test(process.env.IRC_TLS || 'on');

// Where it lands and sits, quietly, until it is told to work.
// let, not const: "land #room" moves it, so the rooms are decided on IRC
// rather than by editing a file and restarting.
let LANDING_ROOM = (process.env.LANDING_ROOM || '#room1').trim();
// Who may tell it. Orders arrive as a private message TO the bot, never in a
// channel: a command typed in a room is read by the room, and "start inviting
// from here" is not a thing to announce to the people about to be invited.
const CONTROLLERS = new Set((process.env.CONTROLLERS || 'Vampire')
    .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));
// It starts IDLE — connected, sitting in the landing room, inviting nobody,
// until the owner says go. A bot that begins working the moment a runner
// starts is a bot that works when nobody meant it to, including on a restart
// six hours later that nobody was watching.
let armed = false;
// Anybody at all may command it. OFF by default: with this on, any person on
// the network can repoint the bot, switch its moderation off, or shut it down.
const OPEN_CONTROL = /^(1|true|yes|on)$/i.test(process.env.OPEN_CONTROL || '');
// Moderation is OFF until switched on, and only ever acts where the bot
// actually holds ops. A bot that tries to moderate a room it has no power in
// produces a stream of "you're not channel operator" and nothing else, which
// reads to everybody watching as the bot being broken.
let modOn = false;
const opped = new Set();               // chanKey -> we hold @ here
const offences = new Map();            // nick(lower) -> how many times

// The recruiter reads its source rooms from the environment, so the CLI
// argument is simply written there before it is constructed.
if (sources.length) process.env.RECRUIT_CHANNELS = sources.join(',');
process.env.RECRUIT_ON = process.env.RECRUIT_ON || 'on';

const log = (lvl, m) => console.log(`[${lvl}] ${m}`);
// Strip IRCv3 tags BEFORE matching. Without this "PING" never matches, no PONG
// is sent, and the connection dies every four minutes for no visible reason.
const strip = (l) => (l.startsWith('@') ? l.slice(l.indexOf(' ') + 1) : l);

let sock = null;
let me = nick;
let pendingNick = '';
let nickTries = 0;
let attempts = 0;              // connections tried this run
let registered = false;        // did we ever get past the server's greeting
let lastError = '';            // the socket's own words, if it had any
// nick(lower) -> services account. A controller's nick alone is not proof:
// these are unregistered-friendly rooms and anybody can wear a name.
const accountOf = new Map();
let stopped = false;
const members = new Map();     // chan(lower) -> Map(nickLower -> {nick, prefix})

function send(line) { try { sock.write(line + '\r\n'); } catch (e) { /* closing */ } }
/**
 * Refuses to speak in a channel. Deliberately.
 *
 * The owner's rule: "it is quiet it remains quiet". This bot's whole value is
 * that a room does not know it is there — it invites people and moderates when
 * asked, and announces nothing about itself. The recruiter it borrows from
 * Dracula has an announce() that posts "The BatCave stirs at…" into the home
 * channel on a timer; this is where that dies, so no future change to the
 * shared recruiter can make this one start talking.
 *
 * Private messages to a PERSON still work — that is how it answers you, and
 * how it tells somebody why they were warned. Only rooms are silent.
 */
function say(chan, text) {
    if (String(chan).startsWith('#') || String(chan).startsWith('&')) {
        log('QUIET', `refused to say in ${chan}: ${String(text).slice(0, 60)}`);
        return;
    }
    send(`PRIVMSG ${chan} :${text}`);
}

function isFatal(line) {
    return /z-?line|k-?line|g-?line|too many times in too short|^ERROR/i.test(line);
}

function stop(why, code = 0) {
    if (stopped) return;
    stopped = true;
    log('STOP', why);
    try { send('QUIT :bye'); sock.end(); } catch (e) { /* gone */ }
    setTimeout(() => process.exit(code), 800);
}

const recruiter = new Recruiter(
    { send: (l) => send(l), say: (c, m) => say(c, m), get nick() { return me; } },
    {
        membersOf: (c) => [...(members.get(String(c).toLowerCase()) || new Map()).values()].map((v) => v.nick),
        prefixOf: (c, n) => {
            const m = members.get(String(c).toLowerCase());
            const e = m && m.get(String(n).toLowerCase());
            return e ? e.prefix : '';
        },
        // A getter, not a snapshot: "into #room" changes where invitations
        // point, and a value copied at construction would keep sending people
        // to the old room while the bot reported the new one.
        get homeChannel() { return room; },
    },
);

// How many go out per round, changeable from IRC.
//
// The recruiter reads RECRUIT_PER_ROUND once, into a module constant, so the
// number cannot be changed after it loads. Its rounds call this.inviteRound()
// with no argument, which means replacing the method on THIS INSTANCE is
// enough — the loop then asks us how many, every time, instead of asking a
// constant frozen at startup.
let perRound = Math.max(1, Number(process.env.RECRUIT_PER_ROUND || 3));
const roundAsBuilt = recruiter.inviteRound.bind(recruiter);
recruiter.inviteRound = (n) => roundAsBuilt(n === undefined ? perRound : n);

function connect() {
    log('INFO', `connecting to ${SERVER}:${PORT} as ${nick}…`);
    const ready = () => {
        send('CAP REQ :multi-prefix');
        send('CAP END');
        send(`NICK ${nick}`);
        send(`USER ${nick.toLowerCase()} 0 * :${nick}`);
    };
    sock = USE_TLS
        ? tls.connect({ host: SERVER, port: PORT, rejectUnauthorized: false }, ready)
        : net.connect({ host: SERVER, port: PORT }, ready);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
        buf += d;
        const lines = buf.split('\r\n');
        buf = lines.pop();
        for (const l of lines) {
            try { handle(strip(l)); } catch (e) { log('ERR', `on "${l.slice(0, 90)}": ${e.message}`); }
        }
    });
    sock.on('error', (e) => { lastError = e.message; log('ERR', `socket: ${e.message}`); });
    // Reconnect, rather than treating one dropped connection as the end.
    //
    // This gave up on the FIRST close and exited, which is wrong for something
    // meant to sit in a room for six hours: any blip ended the run. It also
    // hid the reason — the bot connected, was dropped 0.3s later, said
    // "disconnected" and quit, and there was no second attempt to find out why.
    //
    // Backoff, not a tight loop. A server that just dropped us is the last
    // thing to hammer: reconnecting fast is how this project earned a Z-line
    // on the whole address range today.
    sock.on('close', () => {
        if (stopped) return;
        attempts += 1;
        if (registered) {
            log('WARN', `disconnected after being connected (attempt ${attempts}).`);
        } else {
            log('WARN', `dropped before registering${lastError ? ` — ${lastError}` : ''} `
                + `(attempt ${attempts}). The server refused us without saying why, `
                + 'which usually means the address is throttled or banned.');
        }
        if (attempts >= 6) { stop('six failed connections — giving up this run', 1); return; }
        const wait = Math.min(30000 * attempts, 180000);
        log('INFO', `reconnecting in ${Math.round(wait / 1000)}s…`);
        setTimeout(() => { if (!stopped) connect(); }, wait);
    });
}

function track(chan, raw) {
    const key = String(chan).toLowerCase();
    const m = members.get(key) || new Map();
    const prefix = (String(raw).match(/^[~&@%+]+/) || [''])[0];
    const n = String(raw).replace(/^[~&@%+]+/, '');
    if (n) m.set(n.toLowerCase(), { nick: n, prefix });
    members.set(key, m);
    if (n && n.toLowerCase() === me.toLowerCase()) {
        if (prefix.includes('@')) opped.add(key); else opped.delete(key);
    }
}

/**
 * Moderate one line, in a room where we actually hold ops.
 *
 * Deliberately a ladder and not a hammer: warn, then remove, then keep out.
 * The owner's standing complaint about the main bot was that "every small
 * thing is detected as a threat", and the fix there was the same shape —
 * severe abuse only, and a first offence that costs nothing but a warning.
 *
 * Controllers are never acted on, and neither is anybody the recruiter would
 * have invited: this bot is a guest in most of these rooms.
 */
function moderate(chan, from, text) {
    if (!modOn) return;
    const key = String(chan).toLowerCase();
    if (!opped.has(key)) return;                   // no power here; say nothing
    const k = String(from).toLowerCase();
    if (CONTROLLERS.has(k) || k === me.toLowerCase()) return;
    const verdict = severeAbuse(text);
    if (!verdict || !verdict.severe) return;
    const n = (offences.get(k) || 0) + 1;
    offences.set(k, n);
    log('MOD', `${from} in ${chan}: ${verdict.why} (offence ${n})`);
    if (n === 1) {
        send(`NOTICE ${from} :[MOD] ${verdict.why} — that is your one warning. `
            + 'Say it again here and you are out.');
        return;
    }
    if (n === 2) {
        send(`KICK ${chan} ${from} :${verdict.why} — you were warned`);
        return;
    }
    send(`MODE ${chan} +b ${from}!*@*`);
    send(`KICK ${chan} ${from} :${verdict.why} — third time`);
    for (const cn of CONTROLLERS) {
        send(`PRIVMSG ${cn} :[MOD] banned ${from} from ${chan}: ${verdict.why}`);
    }
}

function handle(line) {
    if (line.startsWith('PING')) { send('PONG' + line.slice(4)); return; }
    if (isFatal(line)) { stop(`the server refused us: ${line.slice(0, 140)}`, 1); return; }

    const p = line.startsWith(':') ? line.split(' ') : ['', ...line.split(' ')];
    const num = /^\d{3}$/.test(p[1]) ? p[1] : '';
    const params = p.slice(2);
    const who = (p[0].match(/^:([^!]+)/) || [])[1] || '';

    if (num === '433') {                       // nick in use
        if (pendingNick) {
            log('WARN', `${pendingNick} is taken — staying as ${me}`);
            pendingNick = '';
            return;
        }
        // hmmm -> hmmm1 -> hmmm2, counting from the ORIGINAL name rather than
        // adding to whatever we tried last. Appending to the last attempt gave
        // hmmm_, hmmm__, hmmm___ — an underscore trail is what an impersonator
        // wears, and it grows until the server rejects the length.
        nickTries += 1;
        if (nickTries > 20) { stop('every variation of that name is taken', 1); return; }
        me = `${nick}${nickTries}`;
        log('WARN', `name taken — trying ${me}`);
        send(`NICK ${me}`);
        return;
    }
    // The server confirms a rename by echoing it back. Until this arrives the
    // old name is still ours, so `me` is only updated here — not when the
    // request is sent. Guessing leaves the recruiter inviting under a name the
    // server never gave us.
    if (p[1] === 'NICK' && who.toLowerCase() === me.toLowerCase()) {
        const now = (params[0] || '').replace(/^:/, '');
        if (now) {
            log('OK', `renamed: ${me} -> ${now}`);
            me = now;
            pendingNick = '';
        }
        return;
    }
    if (num === '376' || num === '422') {
        registered = true;
        attempts = 0;                              // a good connection clears the count
        if (process.env.NICKSERV_PASS) send(`PRIVMSG NickServ :IDENTIFY ${process.env.NICKSERV_PASS}`);
        setTimeout(startUp, 3000);
        return;
    }
    if (num === '353') {
        const chan = params[2] || '';
        for (const raw of (line.split(' :').slice(1).join(' :') || '').trim().split(/\s+/)) track(chan, raw);
        return;
    }
    if (p[1] === 'JOIN') {
        const chan = (params[0] || '').replace(/^:/, '');
        if (who.toLowerCase() === me.toLowerCase()) { log('OK', `joined ${chan}`); return; }
        track(chan, who);
        return;
    }
    // Invited somewhere by one of ours.
    //
    // This is how it gets into rooms now: no room list to maintain, no
    // redeploy — Vampire or Vikram invite it wherever they want it and op it
    // by hand. Only THEIR invitations are followed; anybody on IRC can send an
    // INVITE, and a bot that walks into whatever room it is pointed at is a
    // bot somebody else is steering.
    if (p[1] === 'INVITE') {
        const to = (params[1] || params[0] || '').replace(/^:/, '').trim();
        if (!CONTROLLERS.has(who.toLowerCase())) {
            log('WARN', `ignored an invite to ${to} from ${who} — not one of ours.`);
            return;
        }
        log('OK', `${who} invited me to ${to} — going.`);
        send(`JOIN ${to}`);
        send(`NAMES ${to}`);
        return;
    }
    // Ops given or taken away. Without this the bot never learns it has been
    // opped after joining, so moderation stays silently inert in exactly the
    // room somebody just made it a moderator of.
    if (p[1] === 'MODE' && String(params[0] || '').startsWith('#')) {
        const chan = String(params[0]).toLowerCase();
        const spec = params[1] || '';
        const targets = params.slice(2);
        let adding = true;
        let ti = 0;
        for (const ch of spec) {
            if (ch === '+') { adding = true; continue; }
            if (ch === '-') { adding = false; continue; }
            if ('ovhqab'.includes(ch)) {
                const t = targets[ti++] || '';
                if (ch === 'o' && t.toLowerCase() === me.toLowerCase()) {
                    if (adding) { opped.add(chan); log('OK', `opped in ${params[0]}`); }
                    else { opped.delete(chan); log('WARN', `de-opped in ${params[0]}`); }
                }
            }
        }
        return;
    }
    // Anything said in a room we are sitting in.
    if (p[1] === 'PRIVMSG' && String(params[0] || '').startsWith('#')) {
        moderate(params[0], who, line.slice(line.indexOf(' :') + 2));
        return;
    }
    // An order, sent privately to the bot.
    if (p[1] === 'PRIVMSG' && String(params[0] || '').toLowerCase() === me.toLowerCase()) {
        const text = line.slice(line.indexOf(' :') + 2);
        const from = who.toLowerCase();
        const answer = (m) => send(`PRIVMSG ${who} :${m}`);
        // help is for ANYBODY. It is the one thing a bot should always
        // answer: a bot that ignores "help" is indistinguishable from a bot
        // that is broken, and that is exactly how this looked — the owner
        // typed help, got silence, and reasonably concluded it was not
        // working. Nothing here is secret; the commands only DO anything for
        // a controller.
        if (/^[!.$]*help\b/i.test(text.trim())) {
            command('help', answer);
            return;
        }
        if (!CONTROLLERS.has(from) && !OPEN_CONTROL) {
            // Say so, rather than going quiet. Silence taught the owner
            // nothing and cost an evening of wondering whether the bot was
            // alive.
            answer('I only take orders from the names set in my configuration. '
                + 'Say "help" to see what I can do.');
            log('WARN', `refused a command from ${who} — not a controller.`);
            return;
        }
        // The nick is the claim; the ACCOUNT is the proof. Without this the
        // only thing between this bot and anybody on the network is a name
        // anybody on the network can put on — which is the very attack the
        // main room is defended against.
        // Being named in the config is enough — the owner's call, and the
        // practical one: a controller who is not registered with NickServ
        // could not command their own bot at all, which is how somebody ends
        // up locked out of it in the middle of a raid.
        //
        // The trade is real and worth stating: a nick is not proof, so anybody
        // who takes a controller's name while they are offline can command
        // this bot. Set REQUIRE_IDENTIFIED=on to demand a services account
        // instead, which is the safer setting for a room under attack.
        const acct = (accountOf.get(from) || '').toLowerCase();
        if (!acct && /^(1|true|yes|on)$/i.test(process.env.REQUIRE_IDENTIFIED || '')) {
            answer('You are not identified to services, so I cannot tell you from '
                + 'somebody wearing your name. /msg NickServ IDENTIFY, then try again.');
            log('WARN', `refused ${who}: REQUIRE_IDENTIFIED is on and they have no account.`);
            send(`WHOIS ${who}`);
            return;
        }
        log('CMD', `${who}${acct ? ` (${acct})` : ' (unverified)'}: ${text}`);
        command(text, answer);
        return;
    }
    if (num === '354' || num === '352') {                    // WHO reply: accounts
        // 354 with %cuhnar: <me> <chan> <user> <host> <nick> <account>
        const n2 = num === '354' ? params[4] : params[5];
        const a2 = num === '354' ? params[5] : '';
        if (n2) accountOf.set(String(n2).toLowerCase(), (a2 && a2 !== '0') ? a2 : '');
        return;
    }
    if (num === '330' && params[1] && params[2]) {           // WHOIS "is logged in as"
        accountOf.set(String(params[1]).toLowerCase(), params[2]);
        return;
    }
    if (p[1] === 'ACCOUNT') {                                // account-notify
        const a3 = (params[0] || '').replace(/^:/, '');
        accountOf.set(who.toLowerCase(), a3 === '*' ? '' : a3);
        return;
    }
    if (p[1] === 'PART' || p[1] === 'KICK') {
        const chan = (params[0] || '').replace(/^:/, '');
        const target = p[1] === 'KICK' ? (params[1] || '') : who;
        const m = members.get(chan.toLowerCase());
        if (m) m.delete(String(target).toLowerCase());
        return;
    }
    if (p[1] === 'QUIT') {
        for (const m of members.values()) m.delete(who.toLowerCase());
        return;
    }
    if (/^4\d\d$/.test(num)) {
        const known = {
            401: 'no such nick (they left)',
            403: 'no such channel',
            442: `you are not in ${room}`,
            443: 'already in the room',
            473: `${room} is invite-only and you are not an operator in it`,
            482: `you are not an operator in ${room} — INVITE needs ops there`,
        };
        log('WARN', `${num}: ${known[num] || line.slice(0, 120)}`);
        if (num === '482' || num === '442') {
            stop(`cannot invite to ${room}: ${known[num]}. Op yourself there and rerun.`, 1);
        }
    }
}

function startUp() {
    if (LANDING_ROOM) { send(`JOIN ${LANDING_ROOM}`); send(`WHO ${LANDING_ROOM}`); }
    send(`JOIN ${room}`);
    send(`NAMES ${room}`);
    for (const c of recruiter.channels) { send(`JOIN ${c}`); send(`NAMES ${c}`); }
    if (!recruiter.enabled) {
        stop('no source rooms — pass them as the third argument, e.g. "#lobby,#chat"', 1);
        return;
    }
    log('OK', `target=${recruiter.target}, from ${recruiter.channels.join(', ')} into ${room}`);
    // A dry run proves the whole path — connect, register, join, see people —
    // and stops before anybody is sent anything. Worth having: the alternative
    // way to find out whether a change works is to invite real strangers with
    // it, and that cannot be undone.
    if (/^(1|true|yes|on)$/i.test(process.env.DRY_RUN || '')) {
        setTimeout(() => {
            const seen = [...recruiter.channels].map((ch) => {
                const m = members.get(ch.toLowerCase());
                return `${ch}: ${m ? m.size : 0}`;
            }).join(', ');
            log('OK', `DRY RUN — connected, joined, and can see ${seen}. Nobody invited.`);
            stop('dry run finished');
        }, 12000);
        return;
    }
    // Learn the controllers' accounts up front, so the first order does not
    // have to be refused while we go and ask.
    for (const cn of CONTROLLERS) send(`WHOIS ${cn}`);
    // The host hands this job over roughly every six hours. Without AUTO_START
    // that handover silently turns the bot off — it comes back, sits in the
    // landing room, and waits for a DM that nobody knows is needed, which
    // looks exactly like a bot that is running fine.
    if (/^(1|true|yes|on)$/i.test(process.env.AUTO_START || '')) {
        armed = true;
        recruiter.start(log);
        log('OK', `AUTO_START is on — recruiting straight away, ${recruiter.target}, `
            + `from ${recruiter.channels.join(', ')} into ${room}.`);
    } else {
        log('INFO', process.stdin.isTTY
            ? 'type  start  to begin,  help  for the rest'
            : `idle in ${LANDING_ROOM}. DM me "start" — only ${[...CONTROLLERS].join(', ')} `
              + 'listened to, and only while identified to services. This run ends in '
              + '~6 hours and the next one comes up idle again unless AUTO_START is set.');
    }
    // The member lists go stale as people come and go; refresh them the way
    // the live bot does rather than trusting one NAMES from startup.
    setInterval(() => {
        if (stopped) return;
        for (const c of [room, ...recruiter.channels]) send(`NAMES ${c}`);
    }, 120000);
}

// Type at it while it runs.
//
// The nick is the one thing you actually want to change mid-flight — a room
// starts recognising the bot, or an operator asks it to be less obvious — and
// restarting to do that throws away the recruiter's memory of who it has
// already asked, so everybody gets invited a second time.
function command(line, reply) {
    const out = reply || ((m) => log('INFO', m));
    const [rawCmd, ...rest] = String(line).trim().split(/\s+/);
    // "!help" and "help" are the same thing. People type the prefix out of
    // habit from every other bot in the room, and answering nothing to a
    // one-character difference makes the bot look dead.
    const cmd = String(rawCmd || '').replace(/^[!.$]+/, '');
    const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase()) {
        case '':
            return;
        case 'nick': {
            if (!arg) { out('usage: nick <newname>'); return; }
            if (!/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/.test(arg)) {
                out(`"${arg}" is not a valid IRC nick — letters first, no spaces.`);
                return;
            }
            pendingNick = arg;
            out(`asking the server for ${arg}…`);
            send(`NICK ${arg}`);
            return;
        }
        case 'status':
            out(`${me} | into ${room} | from ${recruiter.channels.join(', ')} `
                + `| target=${recruiter.target} | asked ${recruiter.invited.size} so far`);
            if (recruiter.recent && recruiter.recent.length) {
                out(`recent: ${recruiter.recent.slice(-5).join(', ')}`);
            }
            return;
        case 'who':
            for (const c of recruiter.channels) {
                const m = members.get(c.toLowerCase());
                out(`${c}: ${m ? m.size : 0} people visible`);
            }
            return;
        case 'target': {
            if (!/^(feminine|other|all)$/i.test(arg)) {
                out(`target is ${recruiter.target} — use: target feminine|other|all`);
                return;
            }
            recruiter.target = arg.toLowerCase();
            out(`now inviting: ${recruiter.target}`);
            return;
        }
        case 'start':
        case 'go':
            if (armed) { out('already running.'); return; }
            armed = true;
            recruiter.start(log);
            out(`started — ${recruiter.target}, from ${recruiter.channels.join(', ')} into ${room}`);
            log('OK', 'armed — recruiting now.');
            return;
        case 'pause':
            if (!armed) { out('not running.'); return; }
            armed = false;
            // Cancel the recruiter's own timers. Setting a flag without this
            // leaves the rounds firing on schedule into a bot that believes it
            // has stopped — the difference between paused and pretending.
            for (const t of Object.values(recruiter.timers || {})) {
                try { clearTimeout(t); clearInterval(t); } catch (e) { /* already gone */ }
            }
            out('paused — still here, inviting nobody. Say "start" to resume.');
            log('OK', 'paused.');
            return;
        case 'quit':
        case 'stop':
            out('leaving.');
            stop('told to stop');
            return;
        case 'into': {
            if (!arg.startsWith('#')) { out(`inviting into ${room}. Use: into #room`); return; }
            room = arg.split(/\s+/)[0];
            out(`invitations now point at ${room}. I need ops there if it is +i — `
                + 'invite me and op me, then say start.');
            log('OK', `target room changed to ${room}`);
            return;
        }
        case 'from': {
            if (!arg.includes('#')) {
                out(`finding people in ${recruiter.channels.join(', ') || '(nowhere)'}. `
                    + 'Use: from #room,#room');
                return;
            }
            const list = arg.split(/[,\s]+/).filter((x) => x.startsWith('#'));
            // LEAVE the ones we are dropping. Only joining the new list left
            // the bot sitting in every room it had ever been pointed at,
            // watching rooms nobody asked it to watch and holding connections
            // to them for the rest of the run.
            const keep = new Set([...list, room, LANDING_ROOM].map((c) => c.toLowerCase()));
            for (const old of recruiter.channels) {
                if (!keep.has(old.toLowerCase())) send(`PART ${old} :moving on`);
            }
            recruiter.channels = list;
            for (const ch of list) { send(`JOIN ${ch}`); send(`NAMES ${ch}`); }
            out(`now looking for people in ${list.join(', ')}.`);
            log('OK', `source rooms changed to ${list.join(', ')}`);
            return;
        }
        case 'land': {
            if (!arg.startsWith('#')) {
                out(`sitting in ${LANDING_ROOM || '(nowhere)'}. Use: land #room`);
                return;
            }
            const dest = arg.split(/\s+/)[0];
            const old = LANDING_ROOM;
            LANDING_ROOM = dest;
            send(`JOIN ${dest}`);
            send(`NAMES ${dest}`);
            // Do not leave a room that is still doing a job.
            const stillNeeded = [room, ...recruiter.channels].map((c) => c.toLowerCase());
            if (old && old.toLowerCase() !== dest.toLowerCase()
                && !stillNeeded.includes(old.toLowerCase())) {
                send(`PART ${old} :moving on`);
            }
            out(`now sitting in ${dest}.`);
            log('OK', `landing room changed to ${dest}`);
            return;
        }
        case 'join': {
            if (!arg.startsWith('#')) { out('Use: join #room'); return; }
            const ch = arg.split(/\s+/)[0];
            send(`JOIN ${ch}`);
            send(`NAMES ${ch}`);
            out(`joining ${ch}. It is not a source room unless you say `
                + `"from" — this is just sitting there.`);
            return;
        }
        case 'leave':
        case 'part': {
            if (!arg.startsWith('#')) { out('Use: leave #room'); return; }
            const ch = arg.split(/\s+/)[0];
            send(`PART ${ch} :told to`);
            out(`left ${ch}.`);
            return;
        }
        case 'rooms':
            out(`invites into ${room} | finds people in `
                + `${recruiter.channels.join(', ') || '(nowhere)'} | sits in ${LANDING_ROOM}`);
            return;
        case 'per':
        case 'rate': {
            const n = parseInt(arg, 10);
            if (!Number.isFinite(n) || n < 1 || n > 20) {
                out(`inviting ${perRound} per round. Use: per <1-20>`);
                return;
            }
            perRound = n;
            out(`now inviting ${perRound} per round.`);
            log('OK', `per round set to ${perRound}`);
            return;
        }
        case 'now': {
            if (!armed) { out('not running — say "start" first.'); return; }
            const n = Math.max(1, Math.min(20, parseInt(arg, 10) || perRound));
            const sentNow = recruiter.inviteRound(n);
            out(typeof sentNow === 'number'
                ? `invited ${sentNow} just now.`
                : `sending up to ${n} now.`);
            log('OK', `manual round of ${n}`);
            return;
        }
        case 'mod': {
            if (/^(on|off)$/i.test(arg)) {
                modOn = /^on$/i.test(arg);
                const where = [...opped];
                out(modOn
                    ? `moderation ON. I hold ops in ${where.length ? where.join(', ') : 'NO room yet'} `
                      + '— I can only act where I am an operator.'
                    : 'moderation OFF. Still here, watching nothing.');
                log('OK', `moderation ${modOn ? 'on' : 'off'} (opped in: ${where.join(', ') || 'nowhere'})`);
                return;
            }
            out(`moderation is ${modOn ? 'ON' : 'OFF'}. Use: mod on | mod off. `
                + `Opped in: ${[...opped].join(', ') || 'nowhere yet'}.`);
            return;
        }
        case 'help':
        default:
            // Sent as several lines. IRC silently truncates past ~512 bytes,
            // and a help text that loses its own last third is worse than a
            // short one — the commands you cannot see are the ones you needed.
            out('Send these to me in a private message, one at a time. '
                + 'A "!" in front is fine.');
            out('start — begin inviting | pause — stop inviting but stay here');
            out('mod on | mod off — moderate rooms where I hold ops. Warn, then kick, '
                + 'then ban. Severe abuse only, never you.');
            out('into #room — the room I invite people INTO. Op me there first.');
            out('from #room,#room — the rooms I find people IN');
            out('rooms — show all three: into, from, and where I sit');
            out('per <n> — how many invites per round | now [n] — invite n right away');
            out('land #room — where I sit and wait');
            out('join #room / leave #room — sit in a room without recruiting from it');
            out('target feminine | other | all — who gets invited');
            out('nick <name> — rename me without losing who I have already asked');
            out('status — who I am, where I invite from and to, how many asked');
            out('who — how many people I can see in each source room');
            out('stop (or quit) — shut me down. I return only if the schedule is on.');

    }
}

// Always attached, never assumed. On a GitHub runner stdin is an empty stream
// that simply never delivers a line; in a terminal it is how you rename the
// bot. Gating this on isTTY looked tidier and disabled the whole interface
// under test, where stdin is a pipe — the guard has to be about ERRORS, not
// about guessing what kind of stream it is.
process.stdin.on('error', () => { /* closed on a runner; nothing to read */ });
process.stdin.setEncoding('utf8');
let stdinBuf = '';
process.stdin.on('data', (d) => {
    stdinBuf += d;
    const lines = stdinBuf.split('\n');
    stdinBuf = lines.pop();
    for (const l of lines) {
        try { command(l); } catch (e) { log('ERR', `command failed: ${e.message}`); }
    }
});

process.on('SIGINT', () => stop('you pressed Ctrl+C'));
process.on('SIGTERM', () => stop('terminated'));
connect();

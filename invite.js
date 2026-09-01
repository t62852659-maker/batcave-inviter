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

const argv = process.argv.slice(2);
const nick = argv[0];
const room = argv[1];
const sources = (argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!nick || !room || !room.startsWith('#')) {
    console.error(`
  Usage:  node invite.js <nick> <#room> [#source,#source...]

    <nick>     what this bot is called on IRC
    <#room>    the room it invites people TO  (you need ops there if it is +i)
    [sources]  rooms to find people IN, comma separated

  Examples:
    node invite.js Doorman "#myroom" "#lobby,#chat"
    RECRUIT_TARGET=all node invite.js Doorman "#myroom" "#lobby"

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
const LANDING_ROOM = (process.env.LANDING_ROOM || '#desiadda').trim();
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
// nick(lower) -> services account. A controller's nick alone is not proof:
// these are unregistered-friendly rooms and anybody can wear a name.
const accountOf = new Map();
let stopped = false;
const members = new Map();     // chan(lower) -> Map(nickLower -> {nick, prefix})

function send(line) { try { sock.write(line + '\r\n'); } catch (e) { /* closing */ } }
function say(chan, text) { send(`PRIVMSG ${chan} :${text}`); }

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
        homeChannel: room,
    },
);

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
    sock.on('error', (e) => { log('ERR', `socket: ${e.message}`); stop('connection error', 1); });
    sock.on('close', () => stop('disconnected', 1));
}

function track(chan, raw) {
    const key = String(chan).toLowerCase();
    const m = members.get(key) || new Map();
    const prefix = (String(raw).match(/^[~&@%+]+/) || [''])[0];
    const n = String(raw).replace(/^[~&@%+]+/, '');
    if (n) m.set(n.toLowerCase(), { nick: n, prefix });
    members.set(key, m);
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
        me = `${me}_`;
        log('WARN', `name taken — using ${me}`);
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
    // An order, sent privately to the bot.
    if (p[1] === 'PRIVMSG' && String(params[0] || '').toLowerCase() === me.toLowerCase()) {
        const text = line.slice(line.indexOf(' :') + 2);
        const from = who.toLowerCase();
        const answer = (m) => send(`PRIVMSG ${who} :${m}`);
        if (!CONTROLLERS.has(from)) {
            log('WARN', `ignored a DM from ${who} — not a controller.`);
            return;
        }
        // The nick is the claim; the ACCOUNT is the proof. Without this the
        // only thing between this bot and anybody on the network is a name
        // anybody on the network can put on — which is the very attack the
        // main room is defended against.
        const acct = (accountOf.get(from) || '').toLowerCase();
        if (!acct) {
            answer('You are not identified to services, so I cannot tell you from '
                + 'somebody wearing your name. /msg NickServ IDENTIFY, then try again.');
            log('WARN', `refused ${who}: the nick matches a controller but has no account.`);
            send(`WHOIS ${who}`);                            // in case we simply had not asked yet
            return;
        }
        log('CMD', `${who} (${acct}): ${text}`);
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
    log('INFO', process.stdin.isTTY
        ? 'type  start  to begin,  help  for the rest'
        : `idle in ${LANDING_ROOM}. DM me "start" — only ${[...CONTROLLERS].join(', ')} `
          + 'is listened to, and only while identified to services.');
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
    const [cmd, ...rest] = String(line).trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    switch ((cmd || '').toLowerCase()) {
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
        case 'help':
        default:
            out('commands: start | pause | nick <name> | target feminine|other|all '
                + '| status | who | quit');
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

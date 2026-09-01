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
    log('INFO', process.stdin.isTTY
        ? 'type  nick <name>  to rename it,  status  to see progress,  help  for the rest'
        : 'no terminal here — the nick is fixed for this run; start another to change it.');
    recruiter.start(log);
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
function command(line) {
    const [cmd, ...rest] = String(line).trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    switch ((cmd || '').toLowerCase()) {
        case '':
            return;
        case 'nick': {
            if (!arg) { log('INFO', 'usage: nick <newname>'); return; }
            if (!/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/.test(arg)) {
                log('WARN', `"${arg}" is not a valid IRC nick — letters first, no spaces.`);
                return;
            }
            pendingNick = arg;
            log('INFO', `asking the server for ${arg}…`);
            send(`NICK ${arg}`);
            return;
        }
        case 'status':
            log('INFO', `${me} | into ${room} | from ${recruiter.channels.join(', ')} `
                + `| target=${recruiter.target} | asked ${recruiter.invited.size} so far`);
            if (recruiter.recent && recruiter.recent.length) {
                log('INFO', `recent: ${recruiter.recent.slice(-5).join(', ')}`);
            }
            return;
        case 'who':
            for (const c of recruiter.channels) {
                const m = members.get(c.toLowerCase());
                log('INFO', `${c}: ${m ? m.size : 0} people visible`);
            }
            return;
        case 'target': {
            if (!/^(feminine|other|all)$/i.test(arg)) {
                log('INFO', `target is ${recruiter.target} — use: target feminine|other|all`);
                return;
            }
            recruiter.target = arg.toLowerCase();
            log('OK', `now inviting: ${recruiter.target}`);
            return;
        }
        case 'quit':
        case 'stop':
            stop('you typed quit');
            return;
        case 'help':
        default:
            log('INFO', 'commands: nick <name> | target feminine|other|all | status | who | quit');
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

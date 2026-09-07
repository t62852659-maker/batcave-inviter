// The local inviter, driven the way it runs — and proving it picks people the
// way DRACULA picks them, not the way I would have written it myself.
//
// The first version of invite.js invited everyone it could see. That is not
// what the live bot does, and one difference was not cosmetic: the real
// recruiter refuses any nick that self-labels as a minor BEFORE any other
// test. A naive inviter sends those an invitation to an adult room.
//
// recruit.js here is a copy of the live file, so these assertions are about
// the real selection logic.
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
let fails = 0;
const c = (n, ok, d = '') => { if (!ok) fails++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${!ok && d ? ' — ' + d : ''}`); };

const ROOM = '#myroom';
const SRC = '#lobby';
//                     invited?  why
const CROWD = [
    'priya23',      // yes      a name on the list
    'Sana_k',       // yes      ditto
    'f16delhi',     // NEVER    self-labelled underage
    '15f_mumbai',   // NEVER    ditto, other order
    'rahul_25',     // no       masculine, under the default feminine target
    'horny_bull',   // no       solicitation vocabulary
    'ChanServ',     // no       a service
];

function run(env, done, opts) {
    const sent = [];
    const server = net.createServer((sock) => {
        sock.setEncoding('utf8');
        sock.on('error', () => {});
        const w = (l) => { try { sock.write(l + '\r\n'); } catch (e) { /* gone */ } };
        let buf = '';
        let opened = false;
        let botNick = 'D';
        sock.on('data', (d) => {
            buf += d;
            const lines = buf.split('\r\n');
            buf = lines.pop();
            for (const l of lines) {
                sent.push(l);
                // ONLY the first NICK is registration. Answering a later one
                // with 001/376 fakes a whole reconnect, so startUp ran twice
                // and the bot re-announced itself — a fixture bug that looked
                // exactly like a bot restarting for no reason.
                if (/^NICK/.test(l) && sent.filter((x) => /^NICK /.test(x)).length === 1) {
                    w(':srv 001 D :hi'); w(':srv 376 D :end');
                }
                const j = l.match(/^JOIN (\S+)/);
                if (j) w(`:D!u@h JOIN ${j[1]}`);
                const rn = l.match(/^NICK (\S+)/);
                if (rn && sent.filter((x) => /^NICK /.test(x)).length > 1) {
                    // A real ircd confirms a rename by echoing it. Taken names
                    // answer 433 instead — both are exercised below.
                    if (/taken/i.test(rn[1])) w(`:srv 433 D ${rn[1]} :Nickname is already in use`);
                    else { w(`:${botNick}!u@h NICK :${rn[1]}`); botNick = rn[1]; }
                }
                const nm = l.match(/^NAMES (\S+)/);
                if (nm) {
                    const chan = nm[1];
                    w(chan.toLowerCase() === ROOM.toLowerCase()
                        ? `:srv 353 D = ${chan} :@D`
                        : `:srv 353 D = ${chan} :@D ${CROWD.join(' ')}`);
                    w(`:srv 366 D ${chan} :end`);
                }
                // Vampire is identified; Impostor is not. 330 is how the server
                // says "is logged in as", and it is the only difference between
                // the owner and somebody wearing the owner's name.
                const wi = l.match(/^WHOIS (\S+)/);
                if (wi) {
                    if (/^vampire$/i.test(wi[1])) w(`:srv 330 D ${wi[1]} vampire :is logged in as`);
                    w(`:srv 318 D ${wi[1]} :End of WHOIS`);
                }
                // The bot idles until told. Everything below this line is the
                // activation path, which is now the ONLY way it ever invites.
                if (/^WHOIS Vampire/i.test(l) && !opened) {
                    opened = true;
                    // Addressed to whatever the bot is CALLED right now. It was
                    // hardcoded to "D", so in the rename case the order went to
                    // a nick the bot no longer had and was correctly ignored —
                    // the bot was right and the test was wrong.
                    // Strangers, who never say the phrase and must get silence.
                    setTimeout(() => w(`:nobody!u@h PRIVMSG ${botNick} :start`), 700);
                    setTimeout(() => w(`:Impostor!u@h PRIVMSG ${botNick} :!start`), 1000);
                    // The owner: the phrase first, then commands with a "!".
                    setTimeout(() => w(`:Vampire!u@h PRIVMSG ${botNick} :!hi active`), 1400);
                    setTimeout(() => w(`:Vampire!u@h PRIVMSG ${botNick} :!${(opts && opts.say) || 'start'}`), 1900);
                }
            }
        });
    });
    server.listen(0, '127.0.0.1', () => {
        const bot = spawn(process.execPath, [path.join(__dirname, 'invite.js'), 'D', ROOM, SRC], {
            env: {
                ...process.env,
                // Neutralise the REAL configuration before it leaks in.
                //
                // The workflow runs these tests with the live settings in the
                // environment, so `...process.env` carried DRY_RUN=true into
                // every case — the bot stopped before inviting anyone and
                // three assertions failed on CI while passing locally. Nothing
                // was wrong with the bot; the harness was being configured by
                // the job that ran it.
                DRY_RUN: '', AUTO_START: '', RECRUIT_ON: 'on', RECRUIT_CHANNELS: '',
                RECRUIT_TARGET: 'feminine', FEMININE_HINTS: '', NICKSERV_PASS: '',
                IRC_SERVER: '127.0.0.1', IRC_PORT: String(server.address().port), IRC_TLS: '0',
                RECRUIT_FIRST_MIN: '0', RECRUIT_MIN_GAP_MIN: '0', RECRUIT_MAX_GAP_MIN: '0',
                RECRUIT_PER_ROUND: '9', RECRUIT_ANNOUNCE_MIN: '9999',
                ...env,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        bot.stdout.on('data', (d) => { out += d; });
        bot.stderr.on('data', (d) => { out += d; });
        if (opts && opts.type) {
            // Drive the terminal interface the way a person does.
            setTimeout(() => { try { bot.stdin.write(opts.type); } catch (e) { /* gone */ } }, 3000);
        }
        setTimeout(() => {
            try { bot.kill(); } catch (e) { /* gone */ }
            server.close();
            done({ sent, out, invites: sent.filter((l) => /^INVITE /.test(l)).join(' | ') });
        }, 7000);
    });
}

console.log('— it uses the live recruiter, not a lookalike —');
const fs = require('fs');
const mine = fs.readFileSync(path.join(__dirname, 'recruit.js'), 'utf8');
const live = fs.existsSync(path.join(__dirname, '..', 'batcave-vampire-live', 'recruit.js'))
    ? fs.readFileSync(path.join(__dirname, '..', 'batcave-vampire-live', 'recruit.js'), 'utf8') : null;
c('recruit.js is byte-for-byte the live file', live === null || mine === live,
  'it has drifted from the bot — re-copy it');
c('invite.js imports it rather than reimplementing',
  /require\('\.\/recruit\.js'\)/.test(fs.readFileSync(path.join(__dirname, 'invite.js'), 'utf8')));

console.log('\n— who it picks, with Dracula\'s default target —');
run({}, (r) => {
    c('a name on the list IS invited', /priya23/i.test(r.invites),
      r.invites || '(nobody invited at all)');
    c('an UNDERAGE self-label is never invited',
      !/f16delhi/i.test(r.invites) && !/15f_mumbai/i.test(r.invites),
      r.invites + ' — this is the one that must never regress');
    c('solicitation nicks are skipped', !/horny_bull/i.test(r.invites), r.invites);
    c('services are skipped', !/chanserv/i.test(r.invites), r.invites);
    c('masculine nicks are skipped under target=feminine', !/rahul_25/i.test(r.invites), r.invites);

    console.log('\n— only the owner can switch it on —');
    c('it idles until told, and says so',
      // Not a hardcoded channel. The landing default moved to a neutral
      // #room1 and this pinned the old one, so the assertion failed for a
      // reason that had nothing to do with the property being tested: that it
      // idles, and says where.
      // The wake-up phrase changed from "start" to "!hi active", and the
      // startup line changed with it. Assert the PROPERTY — it idles, and it
      // says how to wake it — not the exact words.
      /idle in #\S+/.test(r.out) && /!hi active/.test(r.out),
      'a bot that starts working when a runner starts is a bot that works when nobody meant it to');
    // SILENT to anybody who has not said the phrase. Deliberately changed
    // back: a refusal that explains what to type is an advertisement, and the
    // owner wants the bot invisible until somebody already knows about it.
    c('a stranger gets silence, not a reply',
      /ignored a DM from nobody/.test(r.out)
        && !r.sent.some((l) => /^PRIVMSG nobody/.test(l)),
      r.sent.filter((l) => /PRIVMSG nobody/.test(l)).join(' | ') || '');
    c('and so does one who guesses the "!" but not the phrase',
      !r.sent.some((l) => /^PRIVMSG Impostor/.test(l)),
      r.sent.filter((l) => /PRIVMSG Impostor/.test(l)).join(' | '));
    c('the phrase wakes it for that person',
      r.sent.some((l) => /^PRIVMSG Vampire :Active\./.test(l)),
      r.sent.filter((l) => /PRIVMSG Vampire/.test(l)).join(' | ') || '(never woke)');
    c('and then obeys them', /armed — recruiting now/.test(r.out),
      r.out.split('\n').filter((l) => /armed|CMD/.test(l)).join(' | ') || '(never started)');
    c('every command needs the "!"',
      /if \(!text\.startsWith\('!'\)\) return;/.test(
          require('fs').readFileSync(path.join(__dirname, 'invite.js'), 'utf8')),
      'an ordinary sentence to the bot must not be read as a command');

    console.log('\n— RECRUIT_TARGET=all, for a room that wants everyone —');
    run({ RECRUIT_TARGET: 'all' }, (a) => {
        c('now the masculine nick IS invited', /rahul_25/i.test(a.invites),
          a.invites || '(nobody invited)');
        c('but UNDERAGE is STILL never invited',
          !/f16delhi/i.test(a.invites) && !/15f_mumbai/i.test(a.invites),
          a.invites + ' — "all" must not mean "including children"');
        c('and solicitation nicks are still skipped', !/horny_bull/i.test(a.invites), a.invites);
        console.log('\n— renaming it while it runs —');
        run({}, (n) => {
            c('typing "nick Newname" renames it', /renamed: D -> Newname/.test(n.out),
              n.out.split('\n').filter((l) => /renam|NICK/i.test(l)).join(' | ') || '(nothing happened)');
            c('and it keeps recruiting afterwards', /INVITE /.test(n.invites),
              'a rename must not stop the job');

            console.log('\n— a name that is already taken —');
            run({}, (t) => {
                c('it says so and keeps the old name', /is taken — staying as D/.test(t.out),
                  t.out.split('\n').filter((l) => /taken|staying/.test(l)).join(' | ') || '(silent)');
                c('rather than appending underscores forever',
                  !/D__/.test(t.sent.join(' ')), t.sent.filter((l) => /^NICK/.test(l)).join(' | '));

                console.log('\n— a nonsense name —');
                run({}, (b) => {
                    c('is refused before it reaches the server',
                      /not a valid IRC nick/.test(b.out)
                        && !b.sent.some((l) => /^NICK .*\s/.test(l.slice(5))),
                      b.out.split('\n').filter((l) => /valid/.test(l)).join(' | ') || '(it sent it anyway)');
                    console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
                    process.exit(fails ? 1 : 0);
                }, { type: 'nick has a space\n' });
            }, { type: 'nick takenname\n' });
        }, { type: 'nick Newname\n' });
    });
});

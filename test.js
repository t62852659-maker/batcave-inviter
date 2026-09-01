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
        sock.on('data', (d) => {
            buf += d;
            const lines = buf.split('\r\n');
            buf = lines.pop();
            for (const l of lines) {
                sent.push(l);
                if (/^NICK/.test(l)) { w(':srv 001 D :hi'); w(':srv 376 D :end'); }
                const j = l.match(/^JOIN (\S+)/);
                if (j) w(`:D!u@h JOIN ${j[1]}`);
                const rn = l.match(/^NICK (\S+)/);
                if (rn && sent.filter((x) => /^NICK /.test(x)).length > 1) {
                    // A real ircd confirms a rename by echoing it. Taken names
                    // answer 433 instead — both are exercised below.
                    if (/taken/i.test(rn[1])) w(`:srv 433 D ${rn[1]} :Nickname is already in use`);
                    else w(`:D!u@h NICK :${rn[1]}`);
                }
                const nm = l.match(/^NAMES (\S+)/);
                if (nm) {
                    const chan = nm[1];
                    w(chan.toLowerCase() === ROOM.toLowerCase()
                        ? `:srv 353 D = ${chan} :@D`
                        : `:srv 353 D = ${chan} :@D ${CROWD.join(' ')}`);
                    w(`:srv 366 D ${chan} :end`);
                }
            }
        });
    });
    server.listen(0, '127.0.0.1', () => {
        const bot = spawn(process.execPath, [path.join(__dirname, 'invite.js'), 'D', ROOM, SRC], {
            env: {
                ...process.env,
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

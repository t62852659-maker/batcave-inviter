# invite.js — a local room inviter

Runs on your machine, no dependencies. It sits in busy rooms and invites
people to your room — choosing them with **Dracula's actual recruiter**.

`recruit.js` here is a byte-for-byte copy of the file the live bot runs, and
`invite.js` imports it rather than reimplementing it, so "the same method to
find whom to invite" is true by construction. The test asserts the copy has
not drifted from the live file.

Same name lists, same reading of self-labels like "23f", same refusal of
solicitation nicks, same 21-day memory so nobody is asked twice, and the same
hard skip of any nick that reads as underage.

## Run it

```
node invite.js <nick> <#room> "#source,#source"
```

```
node invite.js Doorman "#myroom" "#lobby,#chat"
```

Quote the room names — `#` starts a comment in the shell. Source rooms are
required: the recruiter only sees people in rooms it has joined.

Stop it with Ctrl+C. It says how many it invited on the way out.

## You must be able to invite

If your room is invite-only (`+i`), **you need ops in it** or the server
refuses every invite with 482. Op yourself first:

```
/msg ChanServ OP #myroom Doorman
```

The bot stops and tells you in plain words if this is the problem, rather than
inviting into a wall for an hour.

## Settings (all optional)

| variable | default | what it does |
|---|---|---|
| `IRC_SERVER` | `irc.hybridirc.com` | which network |
| `IRC_PORT` | `6697` | TLS port |
| `NICKSERV_PASS` | — | identify on connect, if the nick is registered |
| `RECRUIT_TARGET` | `feminine` | `feminine` (same as Dracula), `other`, or `all` |
| `RECRUIT_PER_ROUND` | `3` | how many per round |
| `RECRUIT_MIN_GAP_MIN` / `RECRUIT_MAX_GAP_MIN` | `1` / `2` | minutes between rounds |
| `RECRUIT_REASK_DAYS` | `21` | do not ask the same person again within this |
| `FEMININE_HINTS` | — | extra names, comma separated |

```
RECRUIT_TARGET=all node invite.js Doorman "#myroom" "#lobby"
```

`feminine` is the default because that is what Dracula uses. For a general
room you probably want `all`.

## Why it is slow on purpose

Mass-inviting strangers is the fastest way to get an address banned from an IRC
network, and this runs from **your** address, not a disposable cloud runner.
The GitHub fleet earned this today doing less than this could:

```
Z-lined: Your IP range has been attempting to connect too many times in too
short a duration.
```

So: one invite every 20 seconds, never the same person twice, and if the server
says anything meaning "stop" it stops and exits instead of arguing. Raising the
rate raises the risk to your own connection, and a Z-line takes you offline
along with the bot.

Some networks treat invite bots as spam regardless of pacing. This one is
conservative, not immune.

## Test it

```
node test.js
```

Spawns the real script against a fake IRC server and checks that the copy of
`recruit.js` matches the live one, that a listed name is invited, that a
masculine nick is skipped under the default target and invited under `all`,
that solicitation nicks and services are skipped, and — in both targets — that
a nick self-labelling as underage is never invited.

That last one found a real bug in the LIVE bot: "f16delhi" was being invited,
because the filter required a non-alphanumeric character after the age, so an
age glued straight to a word walked through while "15f_mumbai" was caught.
Fixed in both.

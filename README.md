# invite.js — a room inviter and light moderator

Runs on GitHub Actions. Nothing to start from a terminal, no password, no
account. It comes up, sits in a room, and waits for you.

## Using it

It joins as **hmmm** (or `hmmm1`, `hmmm2` if that name is taken) and sits in
the landing room doing nothing at all until told.

Everything is a private message to it, and only **Vampire** and **Vikram** are
listened to — and only while you are identified to NickServ. Your nick is a
claim; your account is the proof, and this room has been attacked by people
wearing other people's names.

```
/msg hmmm !help
```

| | |
|---|---|
| `start` / `pause` | begin or stop inviting |
| `into #room` | where invitations point |
| `from #a,#b` | where it looks for people |
| `target feminine\|other\|all` | who gets invited |
| `mod on` / `mod off` | moderate rooms where it holds ops |
| `nick <name>` | rename it, keeping its memory of who it has asked |
| `status` / `who` | what it is doing, who it can see |
| `quit` | end this run |

## Getting it into a room

Invite it and op it by hand — it follows invitations from Vampire and Vikram
and ignores everyone else's:

```
/invite hmmm #yourroom
/msg ChanServ OP #yourroom hmmm
/msg hmmm into #yourroom
/msg hmmm start
```

**Ops matter.** An invite-only room refuses invitations from anybody who is not
an operator, and moderation does nothing at all without them. The bot says so
plainly rather than working silently and achieving nothing.

## Who it invites

`recruit.js` is a byte-for-byte copy of the file the live bot runs, imported
rather than reimplemented, so the choice of who to invite is identical — the
same name lists, the same reading of self-labels, the same refusal of
solicitation nicks, the same 21-day memory, and the same hard skip of any nick
that reads as underage. The test asserts the copy has not drifted.

## Moderation

Off until you say `mod on`, and it only ever acts where it actually holds ops.
Warn, then kick, then ban. It uses a copy of the live bot's abuse detector, so
both agree on what counts, and that detector is deliberately conservative: in
a room full of banter a false positive costs a regular their voice and a miss
costs a second look. Controllers are never acted on.

## Running

It sits on a ten-minute cron: if the previous run has ended, a fresh one
starts. Each run lasts up to ~6 hours, then hands over. There is no push
trigger — editing a comment must never reconnect a live bot.

A new run comes up **idle** and waits to be told again. Set the `AUTO_START`
secret to `on` if you would rather it resume inviting by itself after each
handover.

## Test it

```
node test.js
```

Spawns the real script against a fake IRC server: that the recruiter copy
matches the live one, who gets invited and who never does, that only an
identified controller can command it, renaming, the numbered fallback when the
name is taken, and that it refuses to act in rooms where it has no ops.

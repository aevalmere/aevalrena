# LAN play

Status: playable on a LAN, 2026-09-29. Owner brief: "on each person's computer, still max 4, LAN
lobbies: create lobbies, lobby settings. each person should be P1 on their own screen. it should
feel instantaneous, no lag or issues", then "any people on the same wifi can see all the lobbies
and join any lobby they want". Spec: `docs/WAVE_ARENA_BALANCE.md`, Worker F (phases 1 and 2).

Two modes, picked on the LAN screen:

- **Local agent** (sections 2 to 10): every player runs `npm run lan`. Lobbies are discovered
  over UDP, inputs are relayed over WebSockets, a dropped player can resume.
- **In browser** (section 11, added 2026-09-29): nothing to install. The lobby host's browser tab
  runs the lobby and the relay, and each guest connects to it over WebRTC data channels. Joining
  is by a code the host sends each guest; there is no discovery and no resume.

Both modes run the same lobby code (`src/net/lobbycore.ts`) and the same rollback netcode.

## 1. Research, and what it decided

| Source | What it says | What we took |
|---|---|---|
| GGPO README and Developer Guide, <https://github.com/pond3r/ggpo>, <https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md> | Local inputs go to the game at once. The game supplies `save_game_state`, `load_game_state` and `advance_frame`. `advance_frame` runs many times during a rollback, so effects and audio have to tolerate replays. A frame delay setting trades responsiveness for fewer rollbacks. `ggpo_synchronize_inputs` fails when prediction runs out, and the game stalls that frame. SyncTest rolls back every frame to catch non-determinism. | Save, load and advance map to our pooled snapshot copy, restore and `stepGame`. A prediction limit stalls the tick. Input delay is configurable. `nettest.ts` is our SyncTest. |
| GGPO time sync, <https://github.com/pond3r/ggpo/blob/master/src/lib/ggpo/timesync.cpp> | Each side averages its own frame advantage and the one the peer reports. The side that is ahead sleeps `(local - remote) / 2` frames. | `Advantage` in `src/net/rollback.ts` uses the same formula, one wait frame at a time, at most one every 12 ticks. |
| Tony Cannon, "Fight the Lag!", Game Developer Magazine, Sept 2012 (republished at <https://www.gamedeveloper.com/programming/the-lag-fighting-techniques-behind-ggpo-s-netcode>) | The sim must be decided only by its inputs. On a misprediction GGPO "rewinds the simulation back to the first incorrect frame, repredicts the inputs ... and advances the simulation to the current frame." | We roll back to the earliest frame whose real input differs from the one used. Only `stepGame(state, inputs)` touches the state. |
| Infil, "Netcode explained", <https://words.infil.net/w02-netcode.html> (part 4, rollback) | Predict by repeating the remote player's last input: inputs change on about 8% of frames. Pair rollback with a small fixed delay. Rollback artifacts: remote moves appear a few frames into their startup, and characters jump a little on a correction. Local inputs are always shown at once. | Prediction repeats the last `held` with no edges. The LAN default is 1 delay frame, with Auto available. |
| Slippi (Melee rollback) FAQ, <https://github.com/project-slippi/slippi-launcher/blob/main/FAQ.md>; <https://www.ssbwiki.com/Project_Slippi> | A platform fighter with rollback. Default 2 delay frames online, chosen to feel like a CRT. | On a LAN the round trip is under a frame, so Auto usually picks 1. |
| Skullgirls GGPO writeup, <https://skullgirls.com/2011/09/skullgirls-ggpo-and-you/> (our fetcher got 403; the points come from the Mike Z interview, <https://www.youtube.com/watch?v=7th5hlvX9M4>) and Rivals of Aether | Both designed the sim for cheap save and load: a deterministic fixed step and no pointers into mutable state. | Our sim already is. A 4-player tick (save + step + packet) costs about 50 us. |
| WebSocket vs WebRTC DataChannel: <https://bloggeek.me/webrtc-vs-websockets/>, <https://dasha.ai/blog/webrtc-vs-websocket>, <https://groups.google.com/g/discuss-webrtc/c/P51BNovxr3Q> | WebSocket is TCP, so a lost segment holds up later data (head-of-line blocking). A DataChannel can be unordered, unreliable and peer to peer. | The agent mode uses a WebSocket relay (on a LAN, loss is rare and the relay hop is well under a millisecond). The in-browser mode (section 11) uses an unordered DataChannel with no retransmits for inputs, behind the same `NetTransport`. Packets already repeat unacked inputs. |
| Browser background throttling (Chrome: "Heavy throttling of chained JS timers", <https://developer.chrome.com/blog/timer-throttling-in-chrome-88>) | Hidden tabs stop `requestAnimationFrame` and throttle page timers to 1 Hz or less. Dedicated Worker timers are not throttled that way. | `src/net/bgtick.ts` drives the match from a Worker while the tab is hidden. |
| UDP multicast and broadcast in Node, <https://nodejs.org/api/dgram.html> | `reuseAddr` lets several sockets bind one port, `addMembership` joins a group per interface, and `setBroadcast` enables subnet broadcast. | Discovery (section 3). Browsers cannot use UDP, so the local agent does discovery for its browser. |

## 2. Topology

Every player runs one agent (`npm run lan`) on their own machine. The agent serves the game to
that machine's browser, holds any lobbies created there, relays their match inputs, and takes part
in discovery.

```
   machine A (Alice)                                   machine B (Bob)
 +------------------------------+                    +------------------------------+
 | browser A                    |                    | browser B                    |
 |  agent socket  ------------+ |                    | +------------ agent socket   |
 |  lobby socket  ---------+  | |                    | |  +--------- lobby socket   |
 +-------------------------|--|-+                    +-|--|-------------------------+
                           |  |                        |  |
 +-------------------------v--v-+   UDP 41999 1/s    +-v--|-------------------------+
 | agent A  :5180               | <----------------> | agent B  :5181               |
 |  lobby "ALICE's" + relay     |  multicast group   |  merged lobby list           |
 |  input log (for resumes)     |  + subnet bcast    |  (own + discovered)          |
 +------------------------------+                    +------------------------------+
            ^                                                    |
            |          ws://<A's LAN IP>:5180/lan (Bob joins)    |
            +----------------------------------------------------+
```

- **Agent socket.** From the browser to its own agent (the page's origin). The agent pushes the
  merged lobby list once a second: its own lobbies plus every lobby on every agent it has heard.
- **Lobby socket.** From the browser straight to the agent that holds the lobby: its own agent
  when it created the lobby, another machine's agent when it joined one. Lobby JSON, pings and the
  binary match inputs all travel on it. The holding agent relays each input packet to the other
  members and appends it to the match's input log.
- **Join by address.** For networks that block discovery, the list view takes an agent address.
  The browser opens a listing socket to that agent, and its lobbies are merged into the list.

## 3. Discovery protocol

`server/discovery.ts`. Every agent sends one JSON datagram per second to
`239.255.42.99:41999` (multicast, TTL 1) and to the subnet broadcast address of every IPv4
interface, from one socket bound to each interface. Every agent listens on UDP 41999 with
`SO_REUSEADDR`, joined to the group on every interface, so several agents on one machine hear each
other.

```json
{ "k": "aevalrena-lan", "p": 2, "agentId": "3f9c1a2b7d4e", "hostName": "DARKEL-BOOK",
  "ips": ["192.168.86.250", "172.30.48.1"], "port": 5180, "version": "p2-a844f291",
  "lobbies": [{ "lobbyId": 1, "name": "LAN LOBBY", "hostName": "ALICE", "stageId": "tidegate",
                "players": 1, "state": "open" }] }
```

- **Expiry.** An agent not heard for 4 s drops out of the list. With 1 s announces that is three
  missed datagrams.
- **Address choice (Windows, several adapters).** Use the datagram's source address when it is one
  of the agent's advertised IPs on a subnet we share. Otherwise use the first advertised IP on a
  shared subnet, otherwise the source address. Keep the first choice while it stays advertised, so
  the list does not flip between the Wi-Fi and a virtual adapter.
- **Version guard.** `version` is `p<PROTOCOL_VERSION>-<fnv>`. The hash covers every git-tracked
  file that decides the sim: `src/sim`, `src/core`, character and stage data (art excluded),
  `src/net`, and `balance/`, with line endings ignored (`git ls-files`; without git, a directory
  walk that skips `_*` scratch files and tests). An untracked local file never splits the version.
  Lobbies with a different version show "Different version" and cannot be picked. The holding
  agent also refuses a join or resume from another version.
- **Hostile input.** Every announce is validated field by field before use (strings with length
  caps, integers in range, IPv4 addresses, at most 16 addresses and 32 lobbies, 16 KiB per
  datagram); anything else is counted and dropped (`parseAnnounce`).
- **Test result** (`src/net/discoverytest.ts`, one Windows 11 machine, Wi-Fi + 2 Hyper-V adapters):
  multicast alone, broadcast alone and both together each find the other agent in about 50 ms
  (the second agent within one announce period, about 1.05 s), and expire it about 4.0 s after it
  stops. Loopback multicast was not flaky here; both paths stay on regardless.

### Firewall

Windows shows a firewall prompt the first time Node.js listens. Allow it on **Private networks**.
Without that, other machines cannot reach the agent's TCP port or its UDP 41999, and your lobbies
stay invisible to them (you can still join theirs). Set the Wi-Fi to the Private network profile.
Guest and public Wi-Fi networks often isolate clients from each other, and no LAN game works
there. `npm run lan -- --port 5181` picks another TCP port; the discovery port is fixed.

## 4. Lobbies

`src/net/lobbycore.ts` (lobby rules and relay, shared by both modes), `server/lobbyhost.ts` (the
agent's WebSocket wrapper around it), `src/net/client.ts` (browser), `src/ui/lan.ts` (screen `lan`).

- **Create.** Settings: name, stocks, stage, input delay (Auto or 0-4 frames), CPU fill on/off, CPU
  level, and simulated latency (0/30/60/100 ms added by the relay, for testing rollback).
- **Join** from the list, or through join by address. Refusals are spelled out: "... is full
  (4/4)", "... is in a match. Try again when it ends", "Different game version", "That lobby has
  closed". A duplicate name gets a suffix ("ALICE 2").
- **In the lobby.** Pick a character and a team colour. Non-hosts ready up; the host assigns slots
  (clicking a slot tag moves that player) and starts once everyone is ready. Each card shows that
  player's ping to the holding agent.
- **Leaving.** A guest leaving reopens the slot. The host leaving closes the lobby, and everyone
  returns to the LAN screen with "<host> closed the lobby".
- **Rematch vote.** Rematch on the results screen returns the player to the lobby with a vote. When
  every member has voted, the agent starts the next match with the same settings.
- **Teams.** Automatic, by the frozen rule (two or more slots share a colour). With CPU fill, if
  the humans share a colour, the CPUs share the first free colour, so two humans plus CPU fill is a
  2v2. Otherwise each CPU keeps its slot colour. Final Smash is off.
- **Auto input delay.** `max over member pairs (ping_i / 2 + ping_j / 2) + simulated latency`,
  divided by 16.7 ms, rounded up, clamped to 1..4 (`autoDelay` in `src/net/protocol.ts`). This is
  ceil(rtt / 2 / 16.7) for the worst pair, since a packet crosses both members' legs to the relay.

## 5. Match netcode

- **Lockstep with rollback** (`src/net/rollback.ts`). Every peer runs the whole sim. Each tick:
  1. Read the network. A remote input for an already simulated frame that differs from the one
     used marks the earliest wrong frame.
  2. If one is marked, restore that frame's saved state and re-simulate to the present inside the
     same tick, so there is no visible hitch.
  3. Sample local input for frame `t + delay` and send it, together with every unacked frame (at
     least the last 4, at most 24).
  4. Stall when a remote player is more than 12 frames unconfirmed, or when time sync asks for a
     wait frame.
  5. Save the state for `t` in the 32-slot ring and step.
- **Snapshots.** `src/net/snapshot.ts` is a generic structural deep copy into pool-owned objects.
  It needs no sim field list and allocates nothing after warm-up. An object the pool did not create
  (for example a throw def the sim points at) is never written through.
- **CPU slots** are owned by the lobby host's browser. It runs `cpuInput` once per frame and sends
  the result like a human input, because the AI keeps state that rollback cannot restore.
- **Packets** (`src/net/codec.ts`) are binary, little endian. The header carries peer id, player
  count, frame count, first frame, sender tick, last tick seen from each peer (for time sync), acks
  per peer, and an optional (hash frame, hash). Per input: held, pressed and released (u32) and
  direct (u8).
- **Desync detection.** Every 60 frames, once every input before that frame is confirmed, each peer
  hashes its saved state (`hashGameState`: FNV-1a over frame, RNG, fighter position, velocity,
  percent, stocks, action and projectiles) and sends the hash. A mismatch shows a red "Desync at
  frame N" banner and logs to the console.
- **Rollback visuals: emit on first simulation, add on correction.** The renderer consumes
  `state.events` once per frame change. `RollbackSession.recordEvents` keeps a 64-frame ring of what
  was already emitted, per frame, as a multiset of event signatures (type plus participants, with
  position, damage, knockback and angle left out, since a correction can shift those):
  - the first simulation of a frame emits all of its events, so a hit spark shows on the frame you
    see the hit (GGPO's advice: never delay feedback);
  - a re-simulation emits only events that frame's earlier run did not have, so a hit that exists
    only in the corrected timeline still shows, a resim never repeats a spark, and a phantom hit
    (predicted, then corrected away) has already been shown and is not taken back.

  We chose this over "emit only confirmed frames" because that would delay every spark by the
  confirmation lag (1 to 3 frames on a LAN), trading a rare phantom for a constant delay. nettest
  checks it: every hit of the replay is emitted, and extra hits stay under 25%. Measured: 0 extra
  in every LAN-like scenario, 1 at 6 frames one-way.
- **Everyone is P1** (`src/net/view.ts`). The sim keeps the lobby's slots. The renderer and HUD read
  a view of the state that swaps the local player's colour with P1 blue, names the local fighter
  "P1 (you)" and puts its card first. Local input always comes from Player 1's bindings.
- **Hidden tab** (`src/net/bgtick.ts`). While `document.hidden`, a Worker posts a tick every 8 ms
  and `main.ts` catches the sim up from elapsed time, capped at 8 steps per tick. A backgrounded
  player keeps sending inputs, so nobody stalls.
- **Latency readout.** The top-right corner of the match shows `Ping <ms> · delay <frames> ·
  rollback <max depth>`. The lobby shows each member's ping.

## 6. Disconnects and resume

- **Liveness.** The agent pings every socket (WebSocket ping frames, which browsers answer even in
  background tabs) once a second and drops a socket that misses 4.
- **Dropped vs left.** Only a deliberate close (1000, sent after Leave, or 4001) means the player
  left: the others get `peerGone (left)` at once. Every other close is a drop, including 1001
  ("going away"), because a reload sends 1001 just like a closed tab. The others get
  `peerDropped` and show "Waiting for <name>... (n s)". The match stalls at the prediction limit
  while the seat is held for 10 s. A closed tab therefore ends that player's match after 10 s.
- **Resume.** The dropped browser redials every second with `{ resume, lobbyId, memberId, token }`
  (the token came privately in `joined`). The agent sends `resumed` with the match start and the
  confirmed input history, the contiguous prefix of every player's logged inputs, then adds the
  socket back to the relay (in that order, so no packet falls between). The browser rebuilds its
  session with `RollbackSession.fromHistory`: it silently simulates the history, keeps the last 32
  states, fills its own never-sent frames up to `tick + delay` with a release, and carries on. The
  others see `peerResumed`. `resumed` also carries the lobby, the member id, the token and every
  retirement so far, so a page that kept nothing in memory can rebuild all of it.
- **Reload mid-match.** The browser keeps its seat (lobby agent address, lobby id, member id,
  token) in `sessionStorage` (`aevalrena.lan.seat`, flagged "in match" from the start message
  until it leaves the results). On boot, once the renderer is loaded, `main.ts` calls
  `lanClient.resumeSavedSeat()`, which dials that agent and resumes exactly as after a drop. The
  page lands straight in the match, and the agent log shows `dropped (code 1001)` then `resumed`.
  If the match is over or the seat was given up, the agent answers with an error, the seat is
  cleared, and the LAN screen shows why.
- **Leaving ends that player's match, and the others play it out (Smash rule).** On a leave or a
  timeout the agent works out a `Retirement`: the fighters that member sent input for (its own,
  plus the CPUs when it hosted) and the first frame the relay has no input for (its last logged
  frame + 1). It also attaches the last 48 frames of those inputs (`tail`), because a peer that
  lost a packet can no longer get it re-sent. Every peer calls `RollbackSession.retire`: from that
  frame on, those fighters get empty input, and right before simulating it they are eliminated
  through the sim's own KO path (`src/net/eliminate.ts`: last stock, `koFighter`). A frame already
  simulated is corrected by a rollback. The sim's match end rule then decides: in a 1v1 the
  remaining player wins on the next frame; in teams the leaver's teammates play on. Results show
  the sim's winner as usual, with the leaver tagged "(left)". If the leaver was the lobby host,
  the match still plays out and the lobby closes once everyone leaves results.
- **Losing your own connection** for good: "You lost the connection", then results as this browser
  had them (it cannot keep simulating without the others' inputs).
- **Escape** in a match asks "Leave match?" (Stay / Leave). The match keeps running meanwhile.
  Leave sends `leaveMatch`; the others see "<name> left the match" and play on.

## 7. Verification

| Check | Command | What it proves |
|---|---|---|
| Netcode | `npm run test:net` | 2 peers at 0/2/6 f, 3 peers / 4 players, 4 peers at 4 f with 10% loss, a 90-frame drop and resume, 2 humans + 2 real CPUs, a 5-minute soak with heap samples, and a desync control. Every final hash equals an offline replay of the relay's log, and no hit is lost or duplicated. The same scenarios (less the resume) run again as `rtc:` over fake WebRTC links: the relay in peer 0's tab, loss on both legs of the unordered channel (a packet lost on the way up is never logged or relayed), jitter up to 3 frames so packets arrive out of order, plus a 4 peer run at 20% loss per leg. |
| Discovery | `npm run test:discovery` | Two agents on one machine see each other within 2 s and expire within 5 s, on multicast, on broadcast, and on both. |
| Lobbies | `npm run test:lobby` | A real agent over real sockets: duplicate names, version guard, full and in-match refusals, guest leave, ready gating, input logging and resume with history, the 10 s timeout, and the host closing the lobby. |
| Lobby core, no network | `npm run test:lobbycore` | `LobbyCore` with fake WebRTC-shaped links: version guard, variant defaults and validation, full lobby, slot assignment, ready gating, relay trust, a closed link retiring its player at once, rematch vote, liveness (a link silent for 4 s is dropped), the host closing the lobby, and a 2 player match relayed by the core with 15% loss and reordering on the unordered legs that ends in sync. |
| Join codes and the short-code helper | `npm run test:signal` | SDP to code to SDP for a Chrome offer and a Firefox answer (only UDP host candidates kept, stable when packed again), damaged codes refused with a message; the rendezvous handler in memory through a host and two guests (create, join, offer, answer, close), code alphabet, clash retry, expiry and renewal on a fake clock, and the Node server on a random port with real fetch. |
| Browser | two agents (5180, 5181), two tabs, `?lantest` | The guest sees the host's lobby without typing, joins, plays, sees a confirmed drop and resume; the host closes the tab and the guest gets results and "lobby closed"; a 2v2 with CPU fill finishes and a rematch vote restarts it. Screenshots are `art/ui/ref/lan2_*.png`. |

`?lantest` in the URL enables a DOM-event test hook in `main.ts` (`aevlantest`: returns net stats,
and `drop<ms>` simulates a network drop). Automation runs in an isolated world, so window globals
would not be visible to it.

## 8. Porting checklist (after sim updates)

The netcode reads the game only through `createGameState`, `stepGame`, `MatchConfig` and, in
`main.ts`, `cpuInput` for host-owned CPU slots. After a sim change:

1. `npm run test:net` must print `nettest: PASS`.
2. A new field in `GameState`, `FighterState` or `ProjectileState` needs nothing for rollback (the
   copy is structural). Add it to `hashGameState` only if desync detection should see it.
3. Mutable sim state outside `GameState` (module caches, `Math.random`, `Date.now`) breaks
   rollback. Keep all mutable sim state inside `GameState`.
4. If `InputFrame` gains a field, extend `codec.ts`, `InputRing`, `InputLog` and `inputsEqual`.
5. If `MatchConfig` gains a rule, add it to `LobbySettings`, `sanitizeSettings`, `buildMatchStart`
   and the settings rows in `src/ui/lan.ts`.
6. If a new sim event type carries a field that shifts on a correction (like a position), add it
   to `EVENT_LOOSE_FIELDS` in `rollback.ts`.
7. `src/net/eliminate.ts` reaches into `sim/match.ts` (`koFighter`) to retire a player. If the KO
   path changes, check the two leave scenarios in `npm run test:net`.
8. A wire change bumps `PROTOCOL_VERSION`. Sim changes bump the version hash on their own.

## 9. Hardening (review R7-R18)

- **Agent never dies from one client.** Text frames must parse to an object with a known string
  `t`; anything else gets "Bad message". Every WebSocket, UDP and HTTP handler body is wrapped:
  an exception logs and drops only the offending socket or datagram. `uncaughtException` and
  `unhandledRejection` are logged and the agent keeps serving.
- **Relay trust.** The relay decodes every input packet. It drops a packet that carries a fighter
  the sender does not own, or frames more than `LOG_MAX_AHEAD` (600) past what is confirmed, and
  stamps the peer byte with the sender's real slot before forwarding. The input log applies the
  same 600-frame cap, and browsers ignore input more than 100 frames past what they confirmed
  (the input ring holds 128).
- **Sizes.** WebSocket `maxPayload` is 64 KiB (a larger message closes that socket with 1009).
- **Ids.** Stage and character ids are checked against `STAGE_DEFS` and `CHARACTER_DEFS` by the
  agent (settings, joins, member updates) and again by every browser before it builds the match;
  an unknown id falls back to the first known one with a log line.
- **Static files.** A bad percent escape answers 400. A path must resolve inside the build
  directory (`root + path.sep`), so a sibling directory with a longer name is refused (403).
- **Rollback internals.** `GameState.config` is shared by reference through every snapshot and
  restore, so its identity never changes during a match (the level 10 AI treats a new config
  object as a new match and would re-warm and forget what it learned). Pending effects older
  than 8 frames are dropped, so a hidden tab does not replay minutes of sparks when it returns.
  A retired player's KO event is put back after the step, so every peer shows the KO burst.

## 10. Known limits (agent mode; section 11.8 has the in-browser ones)

- **Use the same browser engine on every machine.** The sim uses `Math.sin` and `**` with
  fractional exponents (the charge curves), whose last bits are not specified by JavaScript and
  can differ between Chrome, Firefox and Safari. Chrome against Edge (both Chromium) is safe; a
  Chrome against Firefox match may desync. The desync banner will say so if it happens.

- Every machine needs the repo, Node.js and `npm install`. The agent builds the game at start,
  which takes about 10 s.
- The relay is the lobby host's agent. If that machine sleeps or quits, the lobby ends. There is no
  host migration.
- TCP relay: a lossy Wi-Fi link shows head-of-line stalls that a DataChannel would avoid.
- A closed tab looks like a reload to the agent (both send 1001), so the others wait the full
  10 s before the leaver is retired.
- A retired player's results show one fall and one SD (the elimination goes through the normal
  KO path).
- A phantom hit spark (predicted, then corrected away) can still flash for a frame under heavy
  delay; the simulated-latency setting shows it.
- Discovery uses one fixed UDP port (41999), so another program on that port turns discovery off
  (the agent says so and join by address still works).

## 11. In-browser mode (WebRTC, no agent)

Owner brief: "make LAN super easy to use and self explanatory: one host code, one join code. no
mobile qr or whatever. also it can be a short code, no one is stealing this. everyone is on same
wifi and only have browser, nothing downloaded."

Two to four players on one network play from the deployed site with nothing installed. The site
is HTTPS, so `ws://` to a LAN address is blocked; WebRTC data channels are the browser's only
peer to peer path. A small online helper (the rendezvous, 11.2) passes the WebRTC offer and
answer between the tabs so nobody copies them by hand. It only carries those few hundred bytes
while players join; the game itself runs directly between the machines on the Wi-Fi. No STUN
or TURN.

### 11.1 Topology

A star, as in the agent mode. The host's tab replaces the host's agent: it runs `LobbyCore` (lobby
state, ready gating, slot assignment, the relay trust checks, the input log, retirements, variant
defaults) and relays match inputs. Each guest has one RTCPeerConnection, to the host.

```
   guest tab B ----RTCPeerConnection----+
                                        |
   guest tab C ----RTCPeerConnection----+--> host tab A: LobbyCore + relay (src/net/browserhost.ts)
                                        |       ^
   guest tab D ----RTCPeerConnection----+       | loopback (in page)
                                                +-- host A's own LanClient and RollbackSession
```

- **Two data channels per guest**, pre-negotiated on both sides (`negotiated: true`), so neither
  side waits for `ondatachannel`:
  - id 0 `lobby`, reliable and ordered: lobby JSON, pings, start, leave and retirement messages
    (the same `ClientMsg` and `ServerMsg` as the agent's text frames);
  - id 1 `inputs`, `ordered: false`, `maxRetransmits: 0`: binary input packets (`codec.ts`).
    Packets repeat every unacked input, so a lost or late packet costs nothing. A packet is
    skipped when more than 64 KiB is still queued on the channel.
- **The host's own client** talks to its LobbyCore through a loopback link (`LoopbackLink`):
  JSON goes through a microtask so neither side re-enters the other, and input packets are handed
  to the relay at once.
- **CPU fill** is unchanged: CPUs belong to the host's peer, so the host's tab runs the AI.
- **Transport seam.** `LanClient.createMatchTransport()` returns the WebSocket transport or
  `createLinkTransport(link)`; `main.ts` does not know which. The sim, `RollbackSession`, the
  snapshot, the codec and the hash are untouched.

### 11.2 Joining with a short code

**What the players see.** Mode select > LAN shows two things: **Host game**, and four code boxes
with **Join**. (Local agent and long codes sit under a small **Advanced** link.)

1. The host presses Host game. The lobby opens at once with the host in slot 1, and a box at the
   top shows the game code in large type, for example `HPP3`, with "Tell your friends this code".
2. A guest types the code (keyboard: type it, paste works too; pad: Left and Right change the
   letter in a box, Up and Down move between boxes) and presses Join. The screen reads "Waiting
   for host", then "Connecting", then the lobby appears with the guest in it. Measured in two
   tabs: 2.3 s from Join to the lobby.
3. More guests do the same with the same code, up to 3 guests (4 players).

From here the lobby works exactly as before: settings, characters, teams, ready, start, rematch.

**Under the hood.**

```
 host tab                        rendezvous                       guest tab
 POST /api/room  ------------->  room HPP3
                                                    <-----------  POST /api/room/HPP3/join -> guest id
 GET  .../host?since= (700 ms) -> guest id
 RTCPeerConnection + offer, ICE gathering (at most 3 s)
 PUT  .../offer/{guest} ------>  offer code
                                                    <-----------  GET .../guest/{guest} (400 ms) -> offer
                                                                  answer, ICE gathering (at most 3 s)
                                 answer code  <-------------------  PUT .../answer/{guest}
 GET  .../host (300 ms while an offer waits) -> answer
 setRemoteDescription; both data channels open; the lobby protocol runs on the reliable channel
```

- The offer and answer are the same compressed codes as the long-code mode (11.3), so they carry
  the invite number and the version hash. A guest on another build stops with "Different version:
  the host runs another build of the game. Reload both pages".
- The host tab runs `RoomHost` (`src/net/signal/roomhost.ts`): one `BrowserHost` invite per
  guest, tagged with the guest id. It polls every 700 ms, every 300 ms while an offer waits for
  its answer, and not at all while all 4 slots are taken and nothing is pending (it starts again
  when someone leaves). A guest arriving while the lobby is full gets "That game is full"; during
  a match, "That game has started. Try again when it ends".
- Leaving the lobby, Back, or closing the tab (a `pagehide` DELETE with `keepalive`) removes the
  room. Guests still waiting then see "The host closed that game".

**States and failures.**

| Side | Shown | When |
|---|---|---|
| host | Getting a code... | until POST /api/room answers |
| host | A player is connecting... | an invite for a guest is being made or opened |
| host | A player could not connect. They can press Retry. + Wi-Fi hint | that connection failed (shown 12 s) |
| host | Could not reach the online helper + Retry | the room could not be made |
| guest | Waiting for host | registered, no offer yet |
| guest | Connecting | answering and opening the channels |
| guest | Connected | channels open; the lobby appears right after |
| guest | No game with that code. Check it with the host | unknown or expired code |
| guest | The host did not answer. Check the code, and that the host is still in the lobby | no offer within 10 s |
| guest | Could not connect within 10 seconds + Wi-Fi hint + Retry | the channels did not open within 10 s of the offer |

The Wi-Fi hint is one line: "Both devices must be on the same Wi-Fi. Guest and public networks
often block this." Retry makes a fresh join (a used offer cannot be reused).

**Rendezvous routes** (`server/rendezvous/handler.ts`, JSON, CORS open, no auth, no rate limit):

| Route | Body | Answer |
|---|---|---|
| `GET /api/health` | | `{ok: true}` |
| `POST /api/room` | `{}` or `{code}` | `{code}`: a new room, or with `code` the same room renewed (or taken back after expiry) |
| `POST /api/room/{code}/join` | `{}` or `{guest}` | `{guest}`: a new guest id, or the same one registered again |
| `GET /api/room/{code}/host?since=n` | | `{guests: [{id, n}], answers: {id: code}}` for guests from index n |
| `PUT /api/room/{code}/offer/{guest}` | `{code}` or `{error}` | `{ok}` |
| `GET /api/room/{code}/guest/{guest}` | | `{offer, error}` (`offer` null until the host put it) |
| `PUT /api/room/{code}/answer/{guest}` | `{code}` | `{ok}` |
| `DELETE /api/room/{code}` | | 204 |

Unknown room or guest: 404. A new code is tried up to 8 times against existing rooms, then 503.

**Codes.** Game codes are 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 characters:
no 0 or O, no 1, I or L), so 923,521 codes. Typing is not case sensitive and anything outside
the alphabet is ignored. Guest ids are 8 characters from the same alphabet.

**Storage and expiry.** Keys `room:{code}` (the guest id list), `offer:{code}:{guest}` and
`answer:{code}:{guest}`. Every write sets a 10 minute expiry. The host writes its room again every
4 minutes while it polls, and if the room is gone (expired) it takes the same code back, so a
lobby that stays open keeps its code; that write re-reads the room afterward and folds in any
guest who joined during the write, so a renew racing a join cannot drop that guest. Only three
storage calls are used (get, put with TTL, delete), so there is no list operation. Two guests
joining at the same instant can race on the room's guest list, and the loser's guest can vanish
from it (or land at an index the host has already polled past); a guest whose id is no longer the
list's last entry, such as one that gets "no such guest" or has no offer 3 s after registering,
registers again with the same id, which appends it past the host's cursor and repairs that.

### 11.3 Long codes (fallback, no helper)

When the page opens the LAN screen it asks `GET /api/health` (2.5 s timeout). If the helper does
not answer, the screen says "Short codes need the online helper; this site copy has none" and
shows the long-code flow instead. Advanced > Long codes picks it on purpose.

1. The host presses Create lobby, then **Invite a player**: after ICE gathering (at most 3 s) a
   join code appears with a Copy button. One code per guest.
2. The guest pastes it into Join with code and presses Join; an answer code appears with Copy.
3. The host pastes the answer into Answer code and presses Connect. Answers can come back in any
   order: each names its invite.

On the host, a connection that is not open 10 s after the answer is entered fails with Retry and
the Wi-Fi hint. On the guest, the answer waits up to 2 minutes for the host. Wrong input is
refused with a message (an answer pasted as a join code or the reverse, a code cut short, extra
characters, a different build). The QR codes and the `#join=` link of the first version are gone.

**Code format** (used by both flows):

`src/net/sdpcode.ts`. The SDP after gathering is about 1 KB. The code keeps only what a
data-channel-only connection with host candidates needs, packs it into bytes and writes it as
base64url (no padding). A Chrome offer with an mDNS, an IPv4 and an IPv6 candidate is 163
characters; a Firefox answer with one mDNS candidate is 144.

| Bytes | Field | SDP line rebuilt |
|---|---|---|
| 1 | magic `0xAE` | |
| 1 | format (high 4 bits, now 1) and kind (low 4 bits: 0 offer, 1 answer) | |
| 1 | invite number (the host invite the offer, or the answer to it, belongs to) | |
| 4 | FNV-1a of the game version string (the version guard, 11.5) | |
| 1 | setup: 0 actpass, 1 active, 2 passive | `a=setup:` |
| 2 | SCTP port | `a=sctp-port:` |
| 1 + n | mid | `a=mid:`, `a=group:BUNDLE` |
| 1 + n | ICE ufrag | `a=ice-ufrag:` |
| 1 + n | ICE password | `a=ice-pwd:` |
| 1 + 1 + n | fingerprint hash (1 sha-1 to 5 sha-512), digest length, digest | `a=fingerprint:` |
| 1 | candidate count (at most 8), then per candidate: | |
| 1 + 4/16/16/n + 2 | kind (4 IPv4, 6 IPv6, 1 mDNS `<uuid>.local`, 2 other name), address, port | `a=candidate:<i> 1 udp <priority> <address> <port> typ host` |

Numbers are little endian except IPv6 groups. Only UDP host candidates for component 1 are kept:
TCP candidates, component 2 and anything but `typ host` are dropped (with no STUN or TURN there is
nothing else), and an IPv6 zone (`%12`) is dropped. Foundation and priority are rebuilt. The
rebuilt SDP is `v=0`, `o=`, `s=-`, `t=0 0`, the BUNDLE group, `a=msid-semantic: WMS`,
`m=application 9 UDP/DTLS/SCTP webrtc-datachannel`, `c=IN IP4 0.0.0.0`, the candidates,
`a=end-of-candidates`, then the lines in the table. `a=max-message-size` is left out (the 64 KiB
default is far above any lobby message). A change to this layout bumps `CODE_FORMAT`; an old code
is then refused as coming from another build.

### 11.4 Liveness, leaving, hidden tabs

- **Pings on the reliable channel.** WebSocket ping frames are gone. Each client sends `ping`
  once a second and the host answers `pong` (the messages the agent mode already uses for the
  round trip). The host's LobbyCore counts a missed second for every link that sent nothing and
  drops it after 4 (`MAX_MISSED`), as the agent does. A guest drops the link when the host has
  been silent for 4.5 s.
- **Worker timers.** The pings, the guest's silence check and the host's once a second LobbyCore
  tick run on a Worker timer (`startWorkerInterval` in `bgtick.ts`), so a hidden tab keeps its
  1 s cadence. The match keeps the existing `bgtick` Worker path on the host and the guests.
- **No resume.** A reload, a closed tab or a failed connection counts as leaving: every close of
  a guest link reaches LobbyCore with the leave code, so the existing retirement path runs at once
  (no 10 s hold). The retirement goes on the reliable channel while the last input packets may
  still be on the unordered one; its 48 frame `tail` covers that. No seat is written to
  `sessionStorage` in this mode.
- **The host's tab is the relay.** If the host leaves a match with Escape, the tab keeps relaying
  for the others until they leave results, as the agent does. If the host's tab closes or
  reloads, every guest loses the connection: during a match they see "You lost the connection",
  then results. The host cannot start another lobby while an old one still has a match running.

### 11.5 Version guard

`vite.config.ts` computes `gameVersion()` from `server/version.ts` at build time and injects it
as `__AEV_GAME_VERSION__`, read by `src/net/buildversion.ts`. It is the same string the agent
computes at run time (checked: a build and the agent both gave `p4-abda18c3` on the same tree).
Every offer and answer code carries its FNV-1a, so the guest refuses an offer from another build
before it connects ("Different version: the host runs another build of the game. Reload both pages") and
the host refuses such an answer. LobbyCore still compares the full string on `join` and answers
with the existing "Different game version" message.

### 11.6 What changed from the agent path

| Agent mode | In-browser mode |
|---|---|
| `npm run lan` on every machine | nothing to install; the deployed page |
| Lobby list from UDP discovery, plus Join by address | Host game gives a 4 letter code; guests type it |
| Lobby host = the agent that holds the lobby | Lobby host = the host's tab (`BrowserHost`) |
| WebSocket text frames (JSON) and binary frames (inputs), over TCP | reliable channel (JSON), unordered channel with no retransmits (inputs) |
| Liveness by WebSocket ping frames | `ping` and `pong` on the reliable channel, from Worker timers |
| A drop holds the seat 10 s and a reload resumes | any close is a leave, no resume |
| The match survives the host's browser closing | the match ends for everyone when the host's tab closes |

Unchanged: `LobbyCore` (the agent now runs it too, through `server/lobbyhost.ts`), every lobby
setting, character, colour variant and team pick, ready-up, slot assignment, rematch vote, Teams,
CPU fill, auto input delay, the rollback session and the packet format. `PROTOCOL_VERSION` stays
4: no message changed.

### 11.7 Files

| File | What |
|---|---|
| `src/net/lobbycore.ts` | Lobby rules and relay, no Node imports. Used by the agent and the host tab. |
| `server/lobbyhost.ts` | The agent's WebSocket wrapper around LobbyCore. |
| `src/net/browserhost.ts` | The host tab: LobbyCore, the loopback link, invites (tagged with a guest id for short codes). |
| `src/net/rtc.ts` | `RtcLink` (one RTCPeerConnection, two channels), the gathering wait, the link transport. |
| `src/net/sdpcode.ts` | Offer and answer codes (both flows). |
| `src/net/signal/codes.ts` | Game code alphabet, checks and normalizing (page and helper). |
| `src/net/signal/api.ts` | The page's fetch calls to the helper; where the helper lives. |
| `src/net/signal/roomhost.ts` | The host tab's room: polling, invites per guest, offers and answers. |
| `server/rendezvous/handler.ts` | The helper: a pure fetch handler on a get/put/delete store, plus the memory store. |
| `server/rendezvous/node.ts` | The helper as a Node server (`npm run rendezvous`, port 8788). |
| `server/rendezvous/kv.ts`, `worker.ts`, `wrangler.worker.toml` | KV store adapter; the helper as a standalone Worker. |
| `functions/api/[[route]].ts`, `wrangler.toml` | The helper as a Cloudflare Pages Function on KV `LOBBY`. |
| `src/net/buildversion.ts` | The build's game version. |
| `src/net/client.ts`, `src/ui/lan.ts` | Host game, Join (short codes), long codes, Advanced, match transport. |
| `src/net/signaltest.ts` | `npm run test:signal` (with `sdpcodetest.ts`): the helper in memory and over HTTP. |

### 11.8 Known limits

- **mDNS host names.** Chrome, Edge and Firefox hide a page's local IP address behind a random
  `<uuid>.local` name unless the page has camera or microphone permission, and the other device
  must resolve that name over multicast DNS. Most home Wi-Fi does; networks that block multicast
  (many guest, school and office networks) make the connection fail with the Wi-Fi hint.
- **Client isolation.** Guest and public Wi-Fi often stop devices from reaching each other at all.
- **The helper needs the internet** while players join (not during play). Without it, long codes.
- **Cloudflare KV is eventually consistent.** A write is normally visible at once to readers
  served by the same Cloudflare location, which players on one Wi-Fi are. Reads from other
  locations can lag up to about 60 s. Not measured on the live KV yet (11.10 B).
- **KV free tier.** 100,000 reads and 1,000 writes a day. A host polls about 86 times a minute
  while slots are open; one join costs 3 or 4 writes. Enough for evenings of play, not for a public
  lobby service.
- **No auth.** Anyone who knows or guesses a live code can join that lobby; the host sees them
  and can leave. The owner accepted this.
- **No resume and no host migration.** A reload leaves the match; the host's tab closing ends it
  for everyone.
- **Same browser engine**, as in section 10: Chrome against Firefox may desync.
- A code holds at most 8 ICE candidates.

### 11.9 Deployment

The page finds the helper through `VITE_RENDEZVOUS_URL`, read at build time (`vite.config.ts`
turns it into `__AEV_RENDEZVOUS_URL__`):

| Value | Helper at |
|---|---|
| unset in `npm run build` | this page's own origin, `/api/...` (Cloudflare Pages) |
| unset in `npm run dev` | port 8788 on the page's host (`npm run rendezvous`) |
| `:PORT` | that port on the page's host |
| a URL | that URL, for example `https://aevalrena-rendezvous.<account>.workers.dev` |

**Cloudflare Pages (simplest).** `functions/api/[[route]].ts` serves the routes next to the site.

1. `npx wrangler kv namespace create LOBBY` and note the id.
2. In `wrangler.toml`, uncomment the `[[kv_namespaces]]` block and paste the id (binding name
   `LOBBY`). With that file present, Pages takes bindings from it, not from the dashboard.
3. Build command `npm run build`, output `dist`, as before. Leave `VITE_RENDEZVOUS_URL` unset.
4. Check: `https://<site>/api/health` returns `{"ok":true}`. Without the binding it returns 503
   and the game falls back to long codes.

**GitHub Pages plus a Worker.** GitHub Pages cannot run code, so the helper runs as a Worker.

1. `npx wrangler kv namespace create LOBBY`, paste the id into
   `server/rendezvous/wrangler.worker.toml`, then
   `npx wrangler deploy -c server/rendezvous/wrangler.worker.toml`. Note the Worker URL.
2. In the GitHub repo, Settings > Secrets and variables > Actions > Variables, add
   `RENDEZVOUS_URL` with that URL. `.github/workflows/deploy.yml` passes it to the build as
   `VITE_RENDEZVOUS_URL`.
3. Push to `main`. Without the variable the build points at its own origin, finds no helper and
   uses long codes.

### 11.10 Owner checklist

Use Chrome or Edge on every device. Note any failure with its step.

**A. Two tabs on one machine**

1. Terminal 1: `npm run rendezvous`. Terminal 2: `npm run dev`. Open the address Vite prints in
   two tabs.
2. Tab 1: Mode select > LAN. Only Host game, the code boxes with Join, and Advanced show. Press
   Host game: the lobby opens with you in slot 1 and a 4 letter code in large type.
3. Tab 2: LAN, type the code, press Join. "Waiting for host", then "Connecting", then within about
   2 s the lobby with both players. Tab 1 shows the guest in slot 2 with a ping.
4. Tab 2: Ready. Tab 1: Start. Play: no red "Desync at frame" banner. Results, Rematch in both.
5. Tab 2: back to LAN, type a wrong code (for example `ZZZZ`) and Join: "No game with that code".
6. Stop `npm run rendezvous`, reload tab 2, open LAN: "Short codes need the online helper; this
   site copy has none" and the long-code screen.
7. Controller: on the LAN screen, Down to the code boxes, Left and Right change a letter, Down
   moves to the next box, then Join.

**B. Two machines on one Wi-Fi**

1. Deploy (11.9) and check `/api/health`, or run A1 on one machine and open
   `http://<that machine's LAN address>:5173` on the other (the page then finds the helper on
   port 8788 of the same address; allow Node through the Windows firewall on Private networks).
2. Repeat A2 to A4 across the machines. Expect a ping under 10 ms.
3. During a match, close the host's tab: the guest sees "You lost the connection", then results.
4. If joining fails on one network but works on another, note the network type: that is the
   multicast DNS or client isolation limit above, not a bug in the game.

**C. Four players**: three guests join with the same code; play a 4-player free for all and a
2v2. A fifth tab trying the code gets "That game is full".

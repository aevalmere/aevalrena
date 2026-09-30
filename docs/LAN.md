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
| Join codes and QR | `npm run test:signal` | SDP to code to SDP for a Chrome offer and a Firefox answer (only UDP host candidates kept, stable when packed again), damaged codes refused with a message, QR finder, timing and format bits, and two golden QR matrices. |
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

Owner brief: two to four players on one network play from the deployed site, with no Node agent
and no install. The deployed site is HTTPS, so `ws://` to a LAN address is blocked; WebRTC data
channels are the browser's only peer to peer path. No signaling server, no STUN or TURN.

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

### 11.2 Signaling flow

1. The host picks In browser, then **Create lobby**. The tab starts a LobbyCore and joins it
   through the loopback.
2. The host presses **Invite a player**. The tab makes an RTCPeerConnection with no iceServers,
   creates both channels and an offer, sets it, waits until `iceGatheringState` is `complete`
   (at most 3 s, then it uses what it has), and shows the **join code**: text, a QR code and a
   Copy button. One code per guest; each invite has its own connection.
3. The guest picks In browser and pastes the code into **Join with code**, or scans the QR code
   with the device camera: it holds `https://<site>/#join=<code>`, which opens the game with the
   code filled in. The guest's tab checks the version, sets the offer, answers, waits for
   gathering the same way, and shows its **answer code** (text, QR code, Copy).
4. The host pastes the answer into **Answer code** and presses Connect. The answer names its
   invite, so answers can come back in any order.
5. When both channels are open, the host's tab attaches the link to LobbyCore; the guest sends
   `hello`, gets the lobby list (always one lobby) and joins it. From here the lobby works as in
   the agent mode.
6. Repeat 2 to 5 for each further guest (at most 3 guests, 4 players).

**Failure states.** On the host, a connection that is not open 10 s after the answer is entered
fails its invite with a Retry (a new code; a used offer cannot be reused) and the hint "Both
devices must be on the same Wi-Fi. Guest and public networks often block this." On the guest, the
answer waits up to 2 minutes for the host (the guest cannot tell when the host pastes it), and
fails at once if the connection itself fails, with the same hint and a Retry. Wrong input is
refused with a message: an answer code pasted as a join code (or the reverse), a code cut short,
extra characters, a different build.

**Scanning.** A camera scan inside the page would need a library (or `BarcodeDetector`, which
desktop Chrome on Windows does not have), so the page itself supports paste only. The join
code's QR code is for phone and tablet camera apps: it opens the page with the code filled in.
The answer code's QR code holds the bare code, for copying on a phone.

### 11.3 Code format

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

The QR codes come from `src/ui/qr.ts`, a small encoder written for this (byte mode, level L,
versions 1 to 40, mask by the standard penalty score). A join link is about 200 characters, QR
version 9 (53 x 53 modules). Every output of the encoder tried while writing it (versions 1 to
13, levels L and M, all 8 masks, 80 symbols) was read back correctly by zbar.

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
Every code carries its FNV-1a, so the guest refuses a join code from another build before it
connects ("Different version: the host runs another build of the game. Reload both pages") and
the host refuses such an answer. LobbyCore still compares the full string on `join` and answers
with the existing "Different game version" message.

### 11.6 What changed from the agent path

| Agent mode | In-browser mode |
|---|---|
| `npm run lan` on every machine | nothing to install; the deployed page |
| Lobby list from UDP discovery, plus Join by address | Create lobby and Join with code; the screen says discovery is not available |
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
| `src/net/browserhost.ts` | The host tab: LobbyCore, the loopback link, invites. |
| `src/net/rtc.ts` | `RtcLink` (one RTCPeerConnection, two channels), the gathering wait, the link transport. |
| `src/net/sdpcode.ts` | Join and answer codes. |
| `src/net/buildversion.ts` | The build's game version. |
| `src/ui/qr.ts` | QR encoder. |
| `src/net/client.ts`, `src/ui/lan.ts`, `src/main.ts` | Mode choice, browser views, match transport, `#join=` links. |

### 11.8 Known limits

- **mDNS host names.** Chrome, Edge and Firefox hide a page's local IP address behind a random
  `<uuid>.local` name unless the page has camera or microphone permission, and the other device
  must resolve that name over multicast DNS. Most home Wi-Fi does; networks that block multicast
  (many guest, school and office networks) make the connection fail with the hint above.
- **Client isolation.** Guest and public Wi-Fi often stop devices from reaching each other at all.
- **Moving the answer code.** The answer has to get back to the host by hand (a chat message, or
  reading it off the screen). The page cannot scan it.
- **No resume and no host migration.** A reload leaves the match; the host's tab closing ends it
  for everyone.
- **Same browser engine**, as in section 10: Chrome against Firefox may desync.
- A code holds at most 8 candidates. A machine with more UDP host candidates (many virtual
  adapters) sends the first 8 the browser gathered.

### 11.9 Manual check for the owner

No browser was available when this mode was written, so the WebRTC path itself has not been run.
Please run these and note any failure with its step number. Use Chrome or Edge on every device.

**A. Two tabs on one machine**

1. `npm run build`, then `npx vite preview` (or open the deployed site). Open two tabs.
2. Tab 1: Mode select > LAN > In browser. Set a name. Create lobby. The lobby shows you as Host.
3. Tab 1: Invite a player. Within 3 s a code, a QR code and Copy appear. Press Copy.
4. Tab 2: LAN > In browser. Paste the code into Join with code, press Join. Within 3 s an answer
   code appears with "Waiting for the host".
5. Tab 2: Copy the answer. Tab 1: paste it into Answer code, press Connect. Within a few seconds
   tab 2 shows the lobby with both players, and tab 1 shows the guest in slot 2 with a ping.
6. Change character, colour and team in each tab and see it in the other. The host moves the
   guest to slot 3 and back. Start stays disabled until the guest presses Ready.
7. Set Input delay to Auto and Stocks to 1. Ready, Start, play to the end. No red "Desync at
   frame" banner. Both tabs show results; press Rematch in both and the next match starts by
   itself.
8. During a match, switch tab 1 to another tab for 10 s and back. Tab 2 must not freeze for
   more than a moment.
9. Close tab 2 during a match. Tab 1 shows "<name> left the match" and wins at once.
10. Failure path: paste garbage, or the join code, into Answer code: a message explains it. Make
    an invite, paste the answer from tab 2 after closing tab 2: after 10 s the invite shows
    Failed with the Wi-Fi hint and Retry.

**B. Two machines on one Wi-Fi**

1. Both on the same home Wi-Fi (not a guest network). Open the deployed site on both.
2. Repeat A2 to A7 across the machines, moving the codes by chat, or by scanning the join QR code
   with the guest's phone camera for a phone guest. Expect a ping under 10 ms and Auto delay 1.
3. Play a full 1v1 to the end with no desync banner. Then, in a new match, close the host's tab:
   the guest sees "You lost the connection", then results.

**C. Four players**

1. Four devices, or four tabs across two machines. The host makes three invites; answer them in
   a different order than they were made.
2. Play a 4-player free for all to the end, then a 2v2 (two pairs of matching team colours). No
   desync banner, every card shows a ping, and the results agree on every screen.
3. Two players plus CPU fill: the CPUs move on every screen and the match ends normally.
4. If a step fails on one network but works on another, note the network type: that is the
   multicast DNS limit above, not a bug in the game.

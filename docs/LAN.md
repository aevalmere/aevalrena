# LAN play

Status: playable on a LAN, 2026-09-29. Owner brief: "on each person's computer, still max 4, LAN
lobbies: create lobbies, lobby settings. each person should be P1 on their own screen. it should
feel instantaneous, no lag or issues", then "any people on the same wifi can see all the lobbies
and join any lobby they want". Spec: `docs/WAVE_ARENA_BALANCE.md`, Worker F (phases 1 and 2).

## 1. Research, and what it decided

| Source | What it says | What we took |
|---|---|---|
| GGPO README and Developer Guide, <https://github.com/pond3r/ggpo>, <https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md> | Local inputs go to the game at once. The game supplies `save_game_state`, `load_game_state` and `advance_frame`. `advance_frame` runs many times during a rollback, so effects and audio have to tolerate replays. A frame delay setting trades responsiveness for fewer rollbacks. `ggpo_synchronize_inputs` fails when prediction runs out, and the game stalls that frame. SyncTest rolls back every frame to catch non-determinism. | Save, load and advance map to our pooled snapshot copy, restore and `stepGame`. A prediction limit stalls the tick. Input delay is configurable. `nettest.ts` is our SyncTest. |
| GGPO time sync, <https://github.com/pond3r/ggpo/blob/master/src/lib/ggpo/timesync.cpp> | Each side averages its own frame advantage and the one the peer reports. The side that is ahead sleeps `(local - remote) / 2` frames. | `Advantage` in `src/net/rollback.ts` uses the same formula, one wait frame at a time, at most one every 12 ticks. |
| Tony Cannon, "Fight the Lag!", Game Developer Magazine, Sept 2012 (republished at <https://www.gamedeveloper.com/programming/the-lag-fighting-techniques-behind-ggpo-s-netcode>) | The sim must be decided only by its inputs. On a misprediction GGPO "rewinds the simulation back to the first incorrect frame, repredicts the inputs ... and advances the simulation to the current frame." | We roll back to the earliest frame whose real input differs from the one used. Only `stepGame(state, inputs)` touches the state. |
| Infil, "Netcode explained", <https://words.infil.net/w02-netcode.html> (part 4, rollback) | Predict by repeating the remote player's last input: inputs change on about 8% of frames. Pair rollback with a small fixed delay. Rollback artifacts: remote moves appear a few frames into their startup, and characters jump a little on a correction. Local inputs are always shown at once. | Prediction repeats the last `held` with no edges. The LAN default is 1 delay frame, with Auto available. |
| Slippi (Melee rollback) FAQ, <https://github.com/project-slippi/slippi-launcher/blob/main/FAQ.md>; <https://www.ssbwiki.com/Project_Slippi> | A platform fighter with rollback. Default 2 delay frames online, chosen to feel like a CRT. | On a LAN the round trip is under a frame, so Auto usually picks 1. |
| Skullgirls GGPO writeup, <https://skullgirls.com/2011/09/skullgirls-ggpo-and-you/> (our fetcher got 403; the points come from the Mike Z interview, <https://www.youtube.com/watch?v=7th5hlvX9M4>) and Rivals of Aether | Both designed the sim for cheap save and load: a deterministic fixed step and no pointers into mutable state. | Our sim already is. A 4-player tick (save + step + packet) costs about 50 us. |
| WebSocket vs WebRTC DataChannel: <https://bloggeek.me/webrtc-vs-websockets/>, <https://dasha.ai/blog/webrtc-vs-websocket>, <https://groups.google.com/g/discuss-webrtc/c/P51BNovxr3Q> | WebSocket is TCP, so a lost segment holds up later data (head-of-line blocking). A DataChannel can be unordered, unreliable and peer to peer. | On a LAN, loss is rare and the relay hop is well under a millisecond, so we use a WebSocket relay. It sits behind `NetTransport` so a DataChannel can replace it. Packets already repeat unacked inputs. |
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
- **Version guard.** `version` is `p<PROTOCOL_VERSION>-<fnv>`. The hash covers every file that
  decides the sim: `src/sim`, `src/core`, character and stage data (art excluded), `src/net`, and
  `balance/`, with line endings ignored. Lobbies with a different version show "Different version"
  and cannot be picked. The holding agent also refuses a join or resume from another version.
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

`server/lobbyhost.ts` (agent), `src/net/client.ts` (browser), `src/ui/lan.ts` (screen `lan`).

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
| Netcode | `npm run test:net` | 2 peers at 0/2/6 f, 3 peers / 4 players, 4 peers at 4 f with 10% loss, a 90-frame drop and resume, 2 humans + 2 real CPUs, a 5-minute soak with heap samples, and a desync control. Every final hash equals an offline replay of the relay's log, and no hit is lost or duplicated. |
| Discovery | `npm run test:discovery` | Two agents on one machine see each other within 2 s and expire within 5 s, on multicast, on broadcast, and on both. |
| Lobbies | `npm run test:lobby` | A real agent over real sockets: duplicate names, version guard, full and in-match refusals, guest leave, ready gating, input logging and resume with history, the 10 s timeout, and the host closing the lobby. |
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

## 9. Known limits

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

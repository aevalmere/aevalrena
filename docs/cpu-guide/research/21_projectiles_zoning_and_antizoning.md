# Projectiles, zoning and anti-zoning in Smash Ultimate: theory, counterplay, stalling rules and CPU procedures

## Conventions

- Frames are 60 Hz. "Tail" means frames from a projectile's spawn frame to the thrower's first actionable frame. "Total" means frames from the button press to the first actionable frame, charge excluded unless stated. `unverified:` marks anything I did not read on a fetched page.
- SSBWiki pages were read as raw wikitext through the MediaWiki endpoint. Character "Attributes" sections are community prose, not developer documentation. ultimateframedata.com values came through a summarising fetch tool, not raw HTML, so treat them as spot-check material.
- Aevalrena facts come from the local repo copy of https://github.com/aevalmere/aevalrena (docs/SPEC.md, docs/CPU_AEVALMERE.md, src/characters/aeval/moves.ts, src/sim/hits.ts, src/sim/projectiles.ts, src/ai/index.ts, src/ai/aevalmere.ts). "(my arithmetic)" marks numbers I derived from those values with the SPEC formulas. They have not been run in the sim.

## What a projectile buys

1. Tempo without exposure. A projectile that is not attached to the thrower freezes only the target on hit, and the thrower's animation is not interrupted (https://www.ssbwiki.com/Hitlag). SSBWiki lists this as the reason projectiles give a few free frames (https://www.ssbwiki.com/Projectile). The gain exists at range only. Point-blank shield advantage on ultimateframedata is about -12 for a full Charge Shot (https://ultimateframedata.com/samus), -12 for Robin's Thunder (https://ultimateframedata.com/robin), -21 for Link's uncharged arrow (https://ultimateframedata.com/link) and -22 for Hero's Frizz (https://ultimateframedata.com/hero). A point-blank projectile on shield loses tempo for the shooter. It pays back when the target cannot reach the shooter during the tail.
2. Forced approach. Against a projectile the opponent must shield, dodge a specific way, or take the hit, and each carries risk (https://www.ssbwiki.com/Projectile). The same page counts 13 characters without a projectile and calls that a disadvantage, because they cannot approach a camper. Projectile camping is the one form of camping that stays practical when the score is even or behind, since chip damage accrues while the opponent declines to approach (https://www.ssbwiki.com/Camping).
3. Little shield pressure. Since update 3.0.0 most Ultimate projectiles have negative shield damage (https://www.ssbwiki.com/Shield_damage). Samus's Charge Shot ranges from -2.5 to -7 shield damage across charge (https://www.ssbwiki.com/Samus_(SSBU)/Neutral_special). The value of zoning is tempo, stage control and chip. The documented exception is Samus's Missile or Bomb into a well-charged Charge Shot, which can guarantee a shield break (https://www.ssbwiki.com/Samus_(SSBU)).
4. Stage control. Snake's C4 makes parts of the stage effectively off-limits and pushes the opponent to where Snake can keep pressuring (https://www.ssbwiki.com/Snake_(SSBU)). Isabelle's Lloid trap and Duck Hunt's steerable Trick Shot can serve the same role (https://www.ssbwiki.com/Isabelle_(SSBU), https://www.ssbwiki.com/Duck_Hunt_(SSBU)).

Aevalrena: shield damage equals the shot's damage, shield stun is floor(0.6 x damage) + 2, and only the target takes hitlag (src/sim/hits.ts). With the orb's move data (tap spawns on frame 11 of 40, full charge on frame 27 of 56, so the tail is 29 frames at every charge) the point-blank numbers are:

| Hold (frames) | Damage | Range (px) | Victim acts after, on shield | Our advantage on shield | On hit at 0% | On hit at 60% |
|---|---|---|---|---|---|---|
| 0 (tap) | 4.0 | 186 | 10 | -18 | -15 | -11 |
| 30 | 8.6 | 266 | 15 | -13 | -8 | -2 |
| 45 | 11.9 | 307 | 18 | -10 | -3 | +6 |
| 60 (full) | 16.0 | 341 | 23 | -5 | +5 | +17 |

(my arithmetic: victim weight 88, orb lands one frame after spawn so our tail is 28, "acts after" is hitlag + shield stun or hitlag + hitstun, damage/knockback/range use the exponential charge lerp in src/characters/aeval/moves.ts.) Consequences: the orb never gives advantage on shield at any charge, the tap orb never gives a point-blank hit advantage, and only a near-full orb that connects does. The full orb launches at knockback 54 to 83 (tumble from about 60%), so the victim leaves reach, and any "orb into grab" claim has to be confirmed by rollout rather than assumed. An orb that hits from far away is a different case: the target is frozen while we are already free.

## Zoner archetypes in Ultimate and their documented plans

SSBWiki defines a zoner as a fighter who keeps the opponent away with long-range or disjointed moves and projectiles, and who typically lacks reliable close-range defense once the barrier is crossed (https://www.ssbwiki.com/SmashWiki:Glossary).

- Samus. Floaty heavyweight with slightly below-average ground speed. Her kit uses projectiles to space, rack damage from a distance and pressure shields, with a typical zoner style and solid close-range combo tools; Charge Shot is her most consistent KO special, Missile is for spacing, Bomb adds mix-ups, and Screw Attack is the out-of-shield option (https://www.ssbwiki.com/Samus_(SSBU)). Documented weaknesses: poor ground mobility, slow and linear recovery, easy to juggle (same page). SSBWiki names Yaura as the only Samus player to win a major (https://www.ssbwiki.com/Template:Samus_and_Dark_Samus_in_competitive_play_(SSBU)).
- Min Min. Hybrid of zoning and aggressive long-range punching. ARMS cannot be reflected, the up smash carries a reflector, and the character is weak against fast, aerial-oriented opponents and against several fast or transcendent projectiles that the reflector cannot cover (https://www.ssbwiki.com/Min_Min_(SSBU)). Her fist-only hitboxes leave blind spots, so an opponent who closes past the fist can punish (same page). Ultimate frame data lists the up smash reflector on frames 6 to 15 with startup 8 (https://ultimateframedata.com/minmin). Doramigi, the top-ranked player of 2025 on UltRank per SSBWiki, plays her more aggressively than most Min Min players, rushing in and boxing opponents toward the edge instead of keeping away (https://www.ssbwiki.com/Smasher:Doramigi). This is a documented case of an aggressive zoner.
- Snake. Poor mobility and heavy reliance on projectiles in neutral. Hand Grenade starts on frame 1 and can be held while shielding, Remote Missile is an edgeguard tool, C4 is a trap and stage-control tool (https://www.ssbwiki.com/Snake_(SSBU)). Ultimate frame data lists the grenade's pin-pull as 21 frames before a throw or shield and detonation at about frame 150 (https://ultimateframedata.com/snake). Documented weaknesses: energy absorbers (Ness, Lucas, Mr. Game & Watch) and characters who can use his explosives (Villager, Isabelle), plus a poor disadvantage state (https://www.ssbwiki.com/Snake_(SSBU)). SSBWiki says the metagame's drift toward campier, more patient play helped Snake rise to 4th on the second tier list (same page). Hurt sets up two to three grenades at a time, varies their trajectories, answers players who cross the minefield with up tilt or dash attack, and is described as hard to face without a grenade-stopping tool such as Mr. Game & Watch's down special (https://www.ssbwiki.com/Smasher:Hurt).
- Duck Hunt. Three projectiles (steerable Trick Shot can, detonated Clay Shooting pigeon, delayed Wild Gunman) drive zoning, setups and stage control, while the non-projectile kit is weak (https://www.ssbwiki.com/Duck_Hunt_(SSBU)).
- Pac-Man. Bonus Fruit and Fire Hydrant control neutral, but only one fruit can exist at a time and an opponent who grabs it removes the option; the hydrant can be reflected or knocked back at him; low base knockback makes him depend on traps and damage racking (https://www.ssbwiki.com/Pac-Man_(SSBU)).
- Link. Bow (chargeable, arrows stick in the ground for about 3 seconds and can be picked up to fire two), Boomerang (angleable up and down) and Remote Bomb, plus a shield that blocks projectiles while he stands, walks or crouches. He plays defensively for much of a match, then closes with strong out-of-shield options and KO power (https://www.ssbwiki.com/Link_(SSBU), https://ultimateframedata.com/link).
- Villager. Strong camping game: forward and back aerial slingshots, Lloid Rocket, Pocket, and a tree that blocks projectiles. Launching Lloid Rocket and running behind it is a documented approach. Fast characters such as Fox and Sonic outrun him and shut the camping down, and reflectors turn his high-power projectiles against him (https://www.ssbwiki.com/Villager_(SSBU)). Isabelle lacks Lloid Rocket and Timber, so her zoning is weaker and her value is in punish and ledge trapping (https://www.ssbwiki.com/Isabelle_(SSBU)). SSBWiki notes she can stall some slow characters on specific stages by combining projectile, air and circle camping (https://www.ssbwiki.com/Stalling).
- Robin. Thunder spells pepper at mid-range, Arcthunder covers more distance and traps, Arcfire disrupts approaches; losing the Thunder tome removes one of his few zoning options (https://www.ssbwiki.com/Robin_(SSBU)). The Thunder tome has 20 durability and a 12 second recharge (same page).
- Hero. Frizz is fast and far and disrupts approaches; charging turns it into Frizzle, which can beat other projectiles, or Kafrizz. The MP gauge (maximum 100) limits how often he can cast (https://www.ssbwiki.com/Hero_(SSBU)). Frame data lists MP costs of 6, 16 and 36 for the three spells (https://ultimateframedata.com/hero).
- Steve. No conventional projectile. Placed blocks build walls, block projectiles and stall, and TNT and Minecart control the stage; planking under the stage is banned at Supernova 2025 (https://www.ssbwiki.com/Steve_(SSBU), https://www.ssbwiki.com/Tournament_rulesets_(SSBU)).

Design signal for Aevalrena: three of these characters bound their zoning with a resource (Robin durability, Hero MP, Steve materials) and one with a one-at-a-time object (Pac-Man). That is a game-design lever against degenerate camping, and it means a per-character projectile profile needs a `cost` and a `cap` field.

## Charge mechanics

- Samus's Charge Shot in Ultimate: 112 charge frames after 13 frames to enter the charge state (ultimateframedata's 125 total agrees). Damage is 5 + 23 x frames/112, base knockback 14 + 32 x frames/112, growth 42 + 8 x frames/112, radius 1.9 + 6.1 x frames/112, all linear in charge frames (https://www.ssbwiki.com/Samus_(SSBU)/Neutral_special, https://ultimateframedata.com/samus). The shot appears on frame 16 and the hitbox lasts 60 frames. An uncharged shot is actionable on frame 45 grounded (32 frames after release) and a full charge on frame 61 after release (same SSBWiki page).
- Ultimate allows charging in the air. The charge can be cancelled with shield, grab, jump or spot dodge, at a cost of 4 frames of lag, and a brief tap lets Samus act without entering a shield (charge storage cancelling). Getting hit while charging drops all stored charge (https://www.ssbwiki.com/Charge_Shot, https://www.ssbwiki.com/Charge-cancel). Hero stores charge in discrete stages only, and Bayonetta, Byleth, Little Mac and Sephiroth cannot store it (https://www.ssbwiki.com/Charge-cancel).
- Other charge timings from frame data: Robin takes 7 frames to enter Thunder's charge and 4 to cancel with shield (https://ultimateframedata.com/robin); Link's bow reaches full charge on frame 52 and full-charge total is 80 frames (https://ultimateframedata.com/link); Hero's Frizzle takes 25 frames to charge (https://ultimateframedata.com/hero).
- What charge-holding means in play: the zoner keeps a partial charge in reserve and shows a different threat at the same distance. Cancelling is the escape hatch that makes charging while the opponent is far a reversible decision.
- Charging is only free while nothing can reach the zoner. SSBWiki's account of Wii U CPUs says characters with chargeable specials could charge freely against CPU projectile users (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). The lesson for a CPU is that a human punishes a rooted charge as soon as it is predictable.

Aevalrena: the orb's charge fraction is t = held frames / 60 on the exponential curve c = (0.6 x 2.5^t - 0.6) / 0.9, and each `charged` field is base + (full - base) x c (src/sim/projectiles.ts). Stats at hold 0, 21, 30, 45, 60: damage 4, 7.0, 8.6, 11.9, 16; speed 3.5, 5.0, 5.8, 7.5, 9.5 px/frame; clash strength 2, 4, 5.1, 7.3, 10 (my arithmetic on the def in src/characters/aeval/moves.ts). The last quarter of the hold is worth the most. Cast delay after release is round(16 x t), so total is 40 + round(16 x held/60). The sim has no charge cancel: releasing fires, so a charge that becomes unsafe can only be fired early. `unverified:` I did not check whether an early release is punished more than a cancel would be. A sim option to cancel a charge with shield or jump, at a fixed lag (Ultimate uses 4 frames), would let the brain start charges it can abort. That is a sim change, not a brain change.

## Spacing, walls and coverage

- Fire from a range where the tail is safe. Characters that turtle well tend to have projectiles whose recovery leaves them able to answer the opponent's follow-up, plus quick, long-reach attacks and good air speed (https://www.ssbwiki.com/Turtling). Fixed ranges are a habit that gets baited: SSBWiki's Melee example is a Falco who fires from one distance and gets powershielded (https://www.ssbwiki.com/Mindgame).
- A wall is several threats at different heights and speeds. Link's arrows fly straight while the Boomerang can be angled up or down, and SSBWiki says his projectiles cut off several angles of attack (https://www.ssbwiki.com/Neutral_game, https://www.ssbwiki.com/Link_(SSBU)). Snake's and Link's explosives can hit opponents standing below platforms, which is what makes platform camping combined with projectiles hard to counter (https://www.ssbwiki.com/Camping). Villager's slingshot aerials add air coverage to Lloid Rocket (https://www.ssbwiki.com/Villager_(SSBU)).
- Platforms change the wall. Flat stages without platforms are the preferred turtling stages, while platform camping is easy on Battlefield-style layouts and "up-air fall-through" is a documented Doramigi habit (https://www.ssbwiki.com/Turtling, https://www.ssbwiki.com/Camping, https://www.ssbwiki.com/Smasher:Doramigi). Stages that allow circle camping are usually banned in tournaments (https://www.ssbwiki.com/Camping).
- Zoning is spacing plus purpose. At the highest level players know their threat bubbles and move around attacks at precise distances, and pressure without purpose loses damage (https://www.ssbwiki.com/Spacing).

Aevalrena: both stages are Battlefield-style, so every zoning plan needs a platform variant. The orb spawns 20 px above the feet and the crescent 18 px, and both fly flat (vy 0, gravity 0), so they cover the ground lane and the low air lane and hit a standing target. An opponent whose feet are above roughly 40 px is covered by Aeval's aerials and up special, not by a projectile. A future character with an angled or arcing shot needs the wall logic to carry a lane height as well as a distance. Jump clearance (my arithmetic with gravity 0.15, jump squat 3): a short hop (velocity 3.5) peaks at about 42 px and clears a tap orb (center 20 px up, radius about 5) from frame 12 after the press for about 30 frames, but clears a full orb (radius 18) only from frame 19 and for about 16 frames. A full hop (velocity 5.4) clears either by frame 11. The crescent (spawn frame 10, total 42, tail 32) reaches about 202 px out at age 57, turns, crosses its launch point at age 121 and dies about 82 px behind it, so one throw guards both sides, and it pierces (SPEC section 5 move table). The level 10 horizon for the crescent is 72 frames (docs/CPU_AEVALMERE.md), so the return pass is outside every rollout. `unverified:` whether extending it changes any decision.

## Clash and priority rules

- Damage priority: when two attack hitboxes collide they clank. If the stronger deals more than 9% (the priority range) more than the weaker, the stronger continues and the weaker ends; within 9%, both end and both fighters rebound. In Ultimate the comparison happens after most damage multipliers and before the 1v1 multiplier (https://www.ssbwiki.com/Priority). The page's worked examples use Brawl numbers. `unverified:` whether charged projectile damage is read at its charged value.
- Projectile against a ground attack: a ground move more than 9% stronger destroys the projectile and continues; within 9%, the projectile dies and the ground move cancels into rebound; a projectile at least 9% stronger cancels the ground move and hits (https://www.ssbwiki.com/Priority). Two projectiles: the weaker is destroyed, and the stronger either continues or dies as well depending on whether it exceeds the other by 9% (same page). Aerials can clank with projectiles but not with ground attacks or other aerials (same page).
- Rebound: in Ultimate both fighters' rebound lasts floor((d + 4) x 15 / 8) frames for the stronger hitbox's damage d, capped at 58, so both are actionable on the same frame, and neither can be hit on the clank frame (https://www.ssbwiki.com/Priority).
- Transcendent priority: the hitbox cannot clank. Transcendent projectiles pass through other projectiles and cannot clank with aerials or ground moves, so an opponent who tries to trade with one generally gets hit (https://www.ssbwiki.com/Priority). SSBWiki names Wolf's Blaster as transcendent in Ultimate (https://www.ssbwiki.com/Neutral_game). Some projectiles behave as items, such as Snake's Remote Missile, and take damage instead of clashing (https://www.ssbwiki.com/Priority).
- Reflection changes ownership, usually raises damage, speed and lifespan, and stops at 7 reflections in Smash 4 and Ultimate (https://www.ssbwiki.com/Reflection). Villager and Isabelle's Pocket returns a stolen projectile at 1.9x damage (same page). Absorption multipliers in Ultimate are 2 for PSI Magnet up to 30 damage and 1.4 for Mii Gunner's vortex; Oil Panic stores up to three projectiles (https://www.ssbwiki.com/Absorption).
- Perfect shield in Ultimate uses shield release with a 5-frame window. A perfect-shielded ordinary projectile leaves the defender 1 frame less hitlag and the attacker unaffected, so it is a modest gain (https://www.ssbwiki.com/Perfect_shield).

Aevalrena: clashes read `strength` only, and damage, power and knockback play no part. The strictly stronger shot destroys the weaker and flies on untouched; equal strength destroys both; a destroyed shot still bursts (src/sim/hits.ts, docs/SPEC.md section 4.4). This differs from Ultimate's 9% damage rule, so nothing in the SSBWiki priority section should be ported to the brain. Tiers: jab drop 1, orb 2 + 8c, crescent 4. The orb passes the crescent at c = 0.25 (about 21 held frames, my arithmetic). Two tap orbs destroy each other, a crescent kills a tap orb and flies on, and a full orb beats everything. Defect to fix: the level 1 to 9 counter-shot code in src/ai/index.ts (CLASH_TOLERANCE 0.1, lines around 715 to 720, 881 and 910) predicts clashes from raw def damage with a 10% tolerance and shrinks the winner's power. It never reads `strength` or the charge, so its predicted winner and survivor state are wrong for charged orbs. Replace it with the same strength comparison the sim uses.

## How players close distance on zoners

Options, with the documented reasons each works and the price.

1. Wait out or punish the charge. A rooted charge has no hitbox, an interrupting hit drops the stored charge (https://www.ssbwiki.com/Charge-cancel), and Ultimate's charge cancel costs 4 frames (https://www.ssbwiki.com/Charge_Shot). Closing fast enough to force a cancel is a tempo win.
2. Jump over. Every fighter has a 3-frame jump squat in Ultimate except Kazuya (https://www.ssbwiki.com/Jump), so the option is quick. Approach by air gives access to aerials, but many aerials are unsafe on shield if spaced badly, and air defense is inferior to ground defense in Ultimate (https://www.ssbwiki.com/Approach).
3. Air dodge through. Ultimate allows one air dodge per airborne period and staleness shortens its intangibility, with a neutral air dodge's ending lag averaging 49 to 50 frames but landing lag about 10 (https://www.ssbwiki.com/Air_dodge). Air dodges are one of the documented tools that break turtling, along with air speed, ground speed and cross-up attacks (https://www.ssbwiki.com/Turtling).
4. Shield, then punish. Shield grabbing is the common counter to reckless approaches (https://www.ssbwiki.com/Approach). Most Ultimate projectiles now do negative shield damage (see above), so shielding them is cheap in shield health, but the shielder is still frozen for the hitlag and stun. Shield drop through platforms was removed in Ultimate (https://www.ssbwiki.com/Shield_drop). Perfect shield exists but the window is 5 frames on release (https://www.ssbwiki.com/Perfect_shield).
5. Roll or spot dodge. Both are subject to staleness in Ultimate (https://www.ssbwiki.com/Air_dodge).
6. Reflect, absorb or steal. Reflectors and absorbers beat projectile camping and are why characters like Ness, Lucas and Mr. Game & Watch are named as Snake counters (https://www.ssbwiki.com/Reflection, https://www.ssbwiki.com/Snake_(SSBU)). Hurt's grenade minefield is called hard to face without such a tool (https://www.ssbwiki.com/Smasher:Hurt).
7. Out-trade or out-shoot. A faster or higher-priority projectile wins the clash, and a transcendent one cannot be traded with (see clash rules). Min Min's ARMS can beat weaker projectiles, and multiple fast ones or transcendent ones cause her trouble (https://www.ssbwiki.com/Min_Min_(SSBU)).
8. Punish the endlag from the right range. Dabuz's Rosalina stuffs approaches by whiff-punishing with up smash or neutral air out of shield, and his Olimar plays bait and punish, camping to gain a lead (https://www.ssbwiki.com/Smasher:Dabuz). The whiff punish only exists when the zoner shot from inside the punish range (see shootSafe below).
9. Mobility and cross-ups. Min Min's dash attack and down tilt are used as approach and cross-up tools (https://www.ssbwiki.com/Min_Min_(SSBU)); fast characters shut down Villager's camping (https://www.ssbwiki.com/Villager_(SSBU)); cross-up attacks are on SSBWiki's list of turtle breakers (https://www.ssbwiki.com/Turtling).
10. Conditioning. Repeated exposure to one shot at one range teaches the player to answer it, and SSBWiki describes gradually encroaching, then switching to immediate aggression after conditioning (https://www.ssbwiki.com/Neutral_game, https://www.ssbwiki.com/Mindgame).

Specific analyses I could read. A TeamLiquid piece on Dabuz reports that at Kagaribi 10 he chose to zone, whittle and camp opponents through losers bracket, burning time against Riddles's Kazuya because accumulating projectile damage made a longer game worse for Kazuya. It also reports Dabuz saying that losing with Min Min means the opponent found the tempo to get in (https://www.teamliquid.com/news/2023/10/27/Dabuzs-odyssey-a-kings-journey-home; the fetch tool summarised the page). SSBWiki says players learned to play around Snake's strengths and exploit his weak disadvantage state after early hype (https://www.ssbwiki.com/Snake_(SSBU)). I found no frame-level pro analysis of an approach, and video analysis was out of reach. Everything above is community documentation, not measured data.

Aevalrena: the sim has no perfect shield or parry, no shield drop (shield plus down is a spot dodge), and no reflectors. That leaves jump over, air dodge (34 frames, invulnerable frames 2 to 31, once per airborne period), roll (24 frames, non-low hits dodged on frames 3 to 16), spot dodge (22 frames, invulnerable 3 to 17), shield, clash, and simply out-running the shot's range. `unverified:` roll distance: docs/SPEC.md says 60 px, but `ROLL.distance` in src/core/constants.ts is 80.

## Stalling rules and in-game limits

Definitions. SSBWiki separates camping (intends to fight from range) from stalling (deliberately wastes time to win by timeout or make the game unplayable) (https://www.ssbwiki.com/Stalling, https://www.ssbwiki.com/Camping). It notes there is no universal rule against camping, because enforcement would be subjective (https://www.ssbwiki.com/Camping).

Tournament rules I could read:

- Match: 3 stock, 7 minutes at CEO 2026 and in the Smash World Tour 2022 rulebook; SSBWiki gives 6 to 8 minutes as the common range (https://ceogaming.org/trending-games/ssbu/, https://smashworldtour.com/wp-content/uploads/2022/03/SWT-2022-Rulebook.pdf, https://www.ssbwiki.com/Tournament_rulesets_(SSBU)). The last two were summarised by the fetch tool.
- Timeout: more stocks wins, then lower percent. If both are equal, a 1 stock, 3 minute tiebreaker is played per SSBWiki and The Big House rules, and the SWT 2022 summary describes a one-stock tiebreaker with proportionally adjusted time (https://www.ssbwiki.com/Tournament_rulesets_(SSBU), https://www.umsmash.com/rules/). CEO says the built-in Sudden Death result does not count (https://ceogaming.org/trending-games/ssbu/). The game's own Sudden Death tends to become a projectile-camping and planking contest (https://www.ssbwiki.com/Sudden_Death).
- Stalling clauses: SWT 2022 allows a forfeit for stalling or excessively delaying at the organizer's discretion (https://smashworldtour.com/wp-content/uploads/2022/03/SWT-2022-Rulebook.pdf). The Big House prohibits intentionally making the game unplayable, with forfeiture (https://www.umsmash.com/rules/). Panda and Evo rulesets were not readable: the Evo 2019 archive was blocked and the one Panda URL I tried returned nothing. `unverified:` their stalling wording.
- Supernova 2025 added a specific rule: using the same special move more than five times without returning to the stage (ledge does not count as stage) is stalling and may cost a game. It covers only actions beneath or outside the stage, is enforced by replay review, and exempts repeated recovery moves with clear intent to return and moves that engage the opponent, such as edgeguarding. Steve's offstage planking is banned outright (https://www.ssbwiki.com/Tournament_rulesets_(SSBU)).
- SSBWiki notes "excessive stalling" is subjective and that Melee majors allowed up to 60 planking attempts, applied only if a game reaches timeout (https://www.ssbwiki.com/Stalling).

In-game mechanisms that limit degenerate play in Ultimate:

- Ledge: at most 6 grabs without landing or taking hitstun, and each regrab reduces ledge option intangibility to none from the fourth grab (https://www.ssbwiki.com/Edge, https://www.ssbwiki.com/Planking).
- Stale-move queue: the last nine connected moves reduce a repeated move's damage. Ultimate's per-slot reductions are 0.09, 0.08545, 0.07635, 0.0679, 0.05945, 0.05035, 0.04255, 0.03345 and 0.025, totalling 0.5305, so a move that fills the queue does about 47% of base damage, while a move absent from the queue gets a 1.05 freshness bonus. Ultimate is the game where hitting a shield also stales, at 0.85 of the slot value (https://www.ssbwiki.com/Stale_Moves).
- Dodge staleness: rolls, spot dodges and air dodges lose intangibility when repeated, and rolls and spot dodges also gain ending lag (https://www.ssbwiki.com/Air_dodge).
- The final five-second countdown appears on the match timer (https://www.ssbwiki.com/Match_timer).

Aevalrena: there is no stale queue, no dodge staleness, and a ledge hang that never times out, with ledge invulnerability lost after 3 regrabs (docs/SPEC.md section 4.5). A `timeLeft` timeout awards most stocks, then lowest percent (section 4.6). Nothing in the game punishes a projectile loop, so the CPU has to. Sim change, if the game owner wants it: a 9-slot queue per fighter with the table above would make repeated shots weaker for everyone, human or CPU, and would let the brain read staleness from state instead of keeping its own counter.

Rules a CPU should respect on its own: never repeat the same special more than five times in a row while off the stage without an attempt to return, and never ledge-hang past the point where its own invulnerability outlasts the opponent's time to reach the ledge (already in docs/CPU_AEVALMERE.md).

## Projectile-aware search

State. `state.projectiles` already holds id, owner, defId, position, velocity, age, hitSlots and alive, plus charge, power, scale and returned in the sim (src/sim/projectiles.ts). The rollout uses the real step, so flight, clash order (clashes resolve before hits within a frame), bursts and hit-slot bookkeeping are exact. The brain needs no separate projectile model for rollouts. It needs derived data for the cheap gates in front of the rollouts.

Derived per-character profile (compute once from the defs, read charged stats through `chargedStat`):

```
ShotProfile {
  moveId, defId
  castFrames(h)      // spawnFrame + round(chargeCastFrames * h / holdMax)
  totalFrames(h)     // move total + the same cast term
  tail(h)            // totalFrames(h) - castFrames(h)
  speed(h), lifetime(h), range(h)   // spawnOffset + speed * lifetime, burst radius extra
  radius(h), height   // hit circle and spawn height above feet
  damage(h), strength(h), frozenOnHit(h, pct), frozenOnShield(h)
  pierces, returns(returnFrame), low, burstId
  cost, cap           // resource fields for characters that need them
}
```

Predicting a hit. For a straight shot, with dx the horizontal gap from the shot to the target's nearest hurtbox edge and closing speed = shot speed + target speed toward it, tHit = dx / closing, valid only when the circle's vertical span overlaps the hurtbox (check height first, using the crouch hurtbox when relevant). Use the closed form to gate, and use the real step when the shot has gravity, turns (crescent) or bursts. The existing level 1 to 9 code already flies shots ahead exactly this way (`shotHitIn`, src/ai/index.ts). Reuse it.

Opponent reply models to add for projectile situations (small set, same weighted-mix mechanism as docs/CPU_AEVALMERE.md): approach through the shot, hold ground and shield, jump over, air dodge through, roll in, counter-shot. Weights come from the habit table keyed by (distance bucket, shot in flight, our state), because the same opponent shields the orb at one range and jumps it at another. The opponent's reaction should start from the visible charge state (a charging fighter is visibly about to fire a fast shot), not from the projectile's spawn.

Scoring a wall. A defensive shot that hits nothing and is safe scores about zero over a 56-frame horizon, but its value is what it does to the next 60 frames of the opponent's options. Add a zone term for shots in flight covering the lane between the fighters, capped, switched off when the stall clock is high. Without it a search brain drops walls in favor of pokes, and with it alone the brain will spam. The staleness cost balances it.

Vetoes to keep (already present): a shot that connects in no reply and is punished by the attack reply is dropped, and a shot that connects in no reply but leaves nothing for a rushing reply to punish is allowed (src/ai/aevalmere.ts, "No whiffs" block). That second clause is what permits max-range walls, so keep it and pair it with the staleness cost below.

Aevalrena: staleness decays per decision, not per frame (`mem.used[i] *= STALE_DECAY` on each decision, 0.9 per decision, cost 1.2 per recent use and doubled for projectiles). Decisions come every 3 to 6 frames on interruptible plans and once per commitment otherwise, so the half-life in frames depends on how the plan mix is being executed. Decay by elapsed frames instead (for example 0.9 per 12 frames) so stale cost means the same thing in a mirror of two orb throwers and against a stationary dummy. The level 10 brain already stales projectiles at twice the other moves' rate and vetoes shots that hit in no reply and get punished, which is the right shape. What it lacks are charge levels between tap and full (only `orbTap` and `orbFull` exist), a zone term, a cycle detector, and a clock that counts closeness as well as damage.

## Making the four archetypes work on a zoner

Levers, all derived from the profile and the character's data rather than from a character name. Values are proposals, not measurements.

| Lever | Aggressive | Defensive | Countering | Balanced |
|---|---|---|---|---|
| Shot band as a share of `range(h)` | 0.15 to 0.6 | 0.55 to 1.0 | 0.4 to 0.85 | 0.3 to 0.9 |
| Safety margin required by shootSafe (frames) | -6 (accepts trades) | +12 | +4, or 0 when a punish plan is ready | +6 |
| Share of chargeDecision's room used | 0.4 | 1.0 | 0.6 | 0.8 |
| Shots that never intend to hit (bait) | 0.05 | 0.10 | 0.30 | 0.10 |
| Stall clock base (frames without engagement) | 210 | 720 | 540 | 420 |
| Retreat after a shot (frames of backing off at spacing) | 0 | 20 to 30 | 10 | 10 |
| Zone term weight | 0.3 | 1.0 | 0.6 | 0.6 |

- Aggressive zoner: fire to gain ground, then move in behind the shot. The documented model is Villager launching Lloid Rocket and running behind it, and Doramigi's Min Min rushing in with range (https://www.ssbwiki.com/Villager_(SSBU), https://www.ssbwiki.com/Smasher:Doramigi). "Orb into grab" has to respect the table above: on shield the orb never leaves advantage, and a tap orb never gives a point-blank hit advantage. A near-full orb that hits is +5 at 0% and +17 at 60% (my arithmetic), which is enough to start a grab or an up smash before the victim recovers. The brain should therefore favor half to full charges at short range when the opponent is not shielding or not looking, and use taps only as cover at range. Aggressive plans also include the crescent as a two-sided cover for a run-in, since it sweeps back through the thrower.
- Defensive zoner: max-range walls with the safest tail. Shoot at 0.55 to 1.0 of range, alternate orb and crescent so the opponent cannot hold one answer, back off after each shot, and prefer platforms and air positions that lengthen the opponent's approach. This archetype is where the stall clock matters most: give it the longest base but never infinite, and let cornering by the opponent switch it to counter play (shield, spot dodge, punish) instead of more shots.
- Countering zoner: shots as bait. Fire from the band where the opponent's natural answer (shield, jump, run through) is one the zoner punishes, then run that punish. Dabuz's Rosalina and Olimar are the documented pattern: whiff-punish approaches out of shield, bait and punish, camp for a lead (https://www.ssbwiki.com/Smasher:Dabuz). The archetype learns the opponent's answer distribution to the shot and picks the counter (anti-air after jumps, grab after shield, punish landing after air dodge). It can take a safe-margin of zero because it wants the approach.
- Balanced: the three above blended by state (percent lead, stocks, stage position, opponent habits). At level 5 (god), no lever is fixed: the rollouts decide, the levers only prune candidates and set veto thresholds, and the God CPU keeps a lower lambda against a read opponent as the level 10 brain does.

Level scaling inside an archetype should change execution and information, not the plan list: reaction frames, how precisely shootSafe uses the opponent's real run speed instead of a default, whether charges are timed by arithmetic or fixed, prediction quality for the opponent's answer, and how quickly cycle detection reacts. Level 1 to 3 can use a fixed band and fixed hold and will be baited; level 4 to 5 use the arithmetic in the procedures below.

## Stall clock and anti-repetition

Current behavior in Aevalrena: level 10 sets `base.stall` when `frame - lastDamageFrame > 420 x (1 - 0.8 x passivity)`, which adds a pull toward the opponent of 0.04 per px of real distance minus half the damage dealt in the rollout, and passivity also lowers lambda and speeds the clock up to five times (src/ai/aevalmere.ts, docs/CPU_AEVALMERE.md). That fixed a stationary-dummy stall and a crescent war in mirrors.

Gaps to close:

1. Chip damage resets the clock. Two projectile campers trading 4% chips every few seconds never let it expire. Track one engagement clock instead of a damage clock: it resets when either fighter is within a close radius (for example 90 px) with neither in hitstun, or when a hit of at least about 8% lands (a design choice, not a measured value). A projectile chip landed from beyond the close radius does not reset it. Also add a rate check: damage per second over the last 20 s below a floor (the doc measured about 6% per second against a standing target) counts as a stall.
2. The pull should ramp, not switch. Use pressure p = clamp((clock - T0) / T0, 0, 1) with T0 from the archetype table, then scale approach terms by (1 + 3p), lower lambda by up to 0.2 p, multiply the projectile staleness cost by (1 + p), and shrink shot bands toward close range. This avoids a cliff at 420 frames.
3. Cycle detection. Keep a ring of the last 12 (plan class, distance bucket, outcome) tuples. If a period-k pattern for k = 1 to 4 has repeated three times with no damage and no distance change, add a penalty to the plans in it for 120 frames, scaled by repeat count. Outcome memory helps: if the last three orbs were shielded, the plan class "orb at this range" loses weight and a different answer to shield (grab approach, crescent, wait for shield decay) gains weight. This is operant conditioning by the CPU on itself, which SSBWiki names as the way players stop repeating a losing choice (https://www.ssbwiki.com/Mindgame).
4. Mirror deadlock. When both fighters hold a safe distance, the fighter with the higher pressure closes; the other's retreat ends at the stage edge. Add a cornered rule: when the retreat path is under about 60 px of stage behind us, drop retreat plans and take the counter plans.
5. Legitimate camping is allowed. If a finite `timeLeft` exists and the CPU leads on stocks, defensive and countering archetypes may raise T0 by a factor tied to time left. This is the ordinary timeout strategy SSBWiki describes for turtling with a small lead (https://www.ssbwiki.com/Turtling). Balanced level 5 should not use it, since the owner wants a CPU that finishes.
6. Never repeat a special more than five times off-stage without returning, following the Supernova rule.

## Procedures

Notation: `frames` are integers at 60 Hz; distances are px; `oppSpeed` is the opponent's signed closing speed toward us in px/frame, floored at their walk speed when they stand still, and at their run speed when the habit table says an approach is likely.

### shootSafe(range, oppSpeed, ourTotalFrames)

```
function shootSafe(range, oppSpeed, ourTotalFrames, o):
    // o: oppReach   px their best punish reaches (from move data; level 1-9 code uses THREAT_RANGE 46)
    //    oppStartup frames until that punish is active once in range (dash attack, dash grab, jab)
    //    oppReact   frames before they start moving (0 = worst case, 4 to 20 by level)
    //    shot       ShotProfile at the chosen hold h
    //    margin     required frames, from the archetype table
    v     = max(oppSpeed, o.walkSpeed)
    gap   = max(0, range - o.oppReach)
    tHit  = o.oppReact + gap / v + o.oppStartup          // earliest frame they can hit us, ignoring the shot
    // The shot can slow the approach. Credit the cheap answer (shield) only, not a hit:
    tShot = shot.castFrames + (range - shot.spawnOffset - shot.radius - o.halfWidth) / (shot.speed + max(oppSpeed, 0))
    inRange = shot.range >= range - o.halfWidth
    credit  = (inRange and tShot < tHit) ? shot.frozenOnShield : 0
    m0 = tHit - ourTotalFrames                              // margin with no credit
    m1 = tHit + credit - ourTotalFrames                     // margin if they answer by shielding or eating it
    return { safe: m0 >= margin, safeIfAnswered: m1 >= margin, m0, m1, inRange }
```

Use `safe` for walls that may hit nothing. Use `safeIfAnswered` only for shots that the search says connect or that the archetype intends as pressure. For Aeval's tap orb against a runner at 3.1 px/frame with reach 34, startup 5 and no reaction time, total 40 gives safe at about 142 px or more (my arithmetic: (40 - 5) x 3.1 + 34). The current level 1 to 9 code uses the tail from spawn and the opponent's default run speed (`orbSafeRange = tail x runSpeed + MY_REACH`, src/ai/index.ts), which assumes they start moving only when the shot appears. That is right against a level with reaction frames and optimistic against a level 5. Level 10 does not need the formula, because rollouts against the attack reply model already test it. It is still the right pruning gate before rollouts and the fallback for levels 1 to 9.

### chargeDecision(distance, oppApproachSpeed)

```
function chargeDecision(distance, oppApproachSpeed, o, shot, margin, shareUsed):
    // hold h frames rooted, then release: total(h) = shot.base + round(castMax * h / holdMax)
    if not chargeIsFree(): return 0     // inbound shot, opponent airborne over us, opponent mid-startup near us,
                                        // opponent in a move that ends near us, ledge or KO risk from a stray hit
    v     = max(oppApproachSpeed, o.walkSpeed if standing else o.runSpeed * P(approach))
    tHit  = o.oppReact + max(0, distance - o.oppReach) / v + o.oppStartup
    hMax  = largest h with  h + shot.total(h) + margin <= tHit
    hReach = smallest h with shot.range(h) >= distance - o.halfWidth
    if hMax < 0: return NO_SHOT                     // even a tap is unsafe here
    if hReach > hMax: return NO_CHARGE_SHOT         // cannot reach without being caught: use crescent or close in
    h = clamp(round(shareUsed * hMax), hReach, hMax)
    return h       // then, every frame while holding, re-run with the live distance and speed and
                   // fire early (release) when hMax falls below the frames already held
```

Worked values (my arithmetic, Aeval's own move data, reach 34, startup 5, margin 8, no reaction): against a runner at 3.1 px/frame, at 200 px the safe hold is at most 8 frames with 6 needed to reach; at 250 px at most 20 with 25 needed, so the orb cannot be both safe and in range; at 300 px at most 33 with 43 needed; at 340 px 43 with 60 needed. Against a 2.6 px/frame opponent the numbers are 16 (need 6), 31 (need 25), 46 (need 43) and 58 (need 60). The upshot: near the edge of a fast runner's reach, full charges are only safe when the opponent is not closing, and the brain should offer intermediate holds (15, 30, 45) as candidate plans instead of only tap and full. `unverified:` these figures assume the punish starts at run speed with no acceleration and that the release fires at the computed frame.

### answerProjectile(incoming, options)

Frame math per option (Aevalrena values). `tHit` is the frames until the shot overlaps us, from the flight prediction. `rf` is the level's reaction frames after the shot or the visible charge. `start` is the frame we press.

```
function answerProjectile(incoming, options, rf, level):
    tHit = flightHit(incoming, me)              // -1 if it never reaches us
    if tHit < 0 or incoming.rangeLeft < gapToMe - margin: return DO_NOTHING     // out of range: free
    best = null
    for each option in options:
        // ready: earliest frame the option protects us; window: frames it covers; locked: frames we cannot act after
        //   shield      ready 1                  window while held           locked = hitlag + shieldstun on hit
        //   spot dodge  ready 3                  window 3..17   (22 total)   locked 22 - start-of-window
        //   roll        ready 3                  window 3..16   (24 total)   moves 60..80 px, non-low only
        //   air dodge   ready 2                  window 2..31   (34 total)   once per airborne period
        //   jump over   ready 3 + rise(h)        window until we fall back   needs shot height + radius below our feet
        //   counter     spawn frame of our shot  wins if strength(ours) > strength(theirs)
        //   walk in     0                         eat the hit                 locked = hitlag + hitstun
        start_min = rf
        feasible = tHit - start_min >= option.ready                 // can we be protected by the time it arrives
        if not feasible: continue
        // choose start so that tHit lands inside the window, with slack for the perception delay
        cost = wDmg * dmgTaken(option) + wShield * shieldLoss(option)
             + wTempo * option.locked + wRisk * P(punished during option.locked)
             - wProgress * pxTowardShooter(option)
        if option is COUNTER and strength(ours) <= strength(theirs): cost += LARGE   // it dies or ties
        if cost < best.cost: best = option
    return best or EAT
```

Cost ordering that falls out of the numbers:

1. Out of range: do nothing. A tap orb dies after about 186 px; a full one after about 341 px.
2. Roll in for a non-low shot when the shooter's tail is over: invulnerable 3 to 16, moves 60 to 80 px toward them, 8 frames of ending lag after invulnerability (24 - 16). It gains ground, and it stales in the CPU (flag `F_STALE`).
3. Air dodge when already airborne with the dodge unused and no landing risk: window 2 to 31 is the widest, but 34 frames long and one per airborne period.
4. Short hop over slow shots with at least 12 frames of warning (tap orb, crescent). It fails against a full orb at close range: a full orb from 100 px arrives in about 9 frames, before a short hop clears it (frame 19 after the press).
5. Shield a tap orb: 4 shield health of 60 and a 10 frame freeze. Shielding a full orb costs 16 health (27% of the bar) and a 23 frame freeze, which is a bad trade if the shooter can follow up. Shielding a crescent covers both passes because the shield covers all sides, but holds decay 0.12 per frame.
6. Counter-shot only when our strength beats theirs (a full orb beats everything; nothing else beats a crescent except a charge past c = 0.25).
7. Eat it when the damage is small and progress is large (a tap orb costs 4% and 13 to 20 frames of freeze).

Reaction gating by level: a level with `rf` frames of reaction cannot answer a shot with `tHit` below `rf + option.ready`. A full orb travels 9.5 px/frame and reaches a target 200 px away in about 19 frames (my arithmetic), so a human-like level with 12 to 15 frames of reaction cannot answer it in time and has to react to the charge instead. That is the intended weakness of mid levels. Level 5 (rf about 4, ready 2 to 3) can answer any shot that spawns farther than about 66 px away for a full orb or 25 px for a tap orb (my arithmetic: 7 frames x speed).

### stallClock

```
state: lastEngageFrame, ring[12], pressure
each frame:
    if hitLandedThisFrame and hit.damage >= CHIP_MAX:   lastEngageFrame = frame   // CHIP_MAX about 8
    if dist <= CLOSE_R and not anyHitstun:              lastEngageFrame = frame   // CLOSE_R about 90
    T0      = archetypeBase * (1 - 0.8 * passivity)          // existing form; base from the table above
    clock   = frame - lastEngageFrame                        // a chip hit from beyond CLOSE_R does not reset it
    rateLow = damagePerSecond(last 20 s) < FLOOR
    pressure = clamp((clock - T0) / T0, 0, 1)
    if rateLow: pressure = max(pressure, 0.5)
    // effects (all continuous in pressure)
    approachWeight *= 1 + 3 * pressure
    lambda         -= 0.2 * pressure
    projectileStaleCost *= 1 + pressure
    shotBand.hi    -= pressure * (shotBand.hi - shotBand.lo)
    // cycle penalty
    push (planClass, distBucket, outcome) into ring
    for k in 1..4: if ring repeats with period k three times and no damage: penalty[planClasses] += 1.5 * repeats, decaying over 120 frames
```

Note the clock ignores small hits landed from range on purpose: they are the chip that the existing damage-based clock lets reset it. Close-range contact or a hit of CHIP_MAX or more still counts as engagement, and the rate check catches a long run of small hits that add up to too little damage per second.

## Open questions

- Whether Ultimate's 9% priority rule applies to charged projectile damage or base damage, and whether the tolerance is exactly 9 or slightly different. SSBWiki does not say and the examples come from Brawl.
- Whether releasing an orb early is more punishable in Aevalrena than a cancel would be, and whether a charge cancel should be added to the sim.
- Whether roll distance is 60 px (SPEC) or 80 px (`ROLL.distance` in src/core/constants.ts), which changes the roll-in row in answerProjectile.
- Whether extending the crescent's rollout horizon beyond 72 frames changes any decision, given the return pass at age 57 to 121.
- Whether the game owner wants a sim-level stale-move queue and dodge staleness, or resource caps on projectiles for future characters, instead of brain-only stall handling.
- Panda Cup and Evo stalling wording, and the Supernova 2025 rulebook text itself (Google Drive would not load), so the five-special rule comes from SSBWiki's summary only.
- Human reaction time by level: I did not obtain a fetchable source, so the 4 to 20 frame range for `rf` is a design choice, not a measurement. The existing brain uses 4 frames of perception delay at level 10.

## Sources

Fetched (read in full or by section):

- https://www.ssbwiki.com/Projectile : definition, purpose, 13 characters without projectiles, competitive note.
- https://www.ssbwiki.com/Priority : 9% priority range, projectile clash rules, aerials, rebound formula, transcendent priority.
- https://www.ssbwiki.com/Camping : camping types, projectile camping, planking, circle camping, competitive stance.
- https://www.ssbwiki.com/Approach : approach types, disrupting approaches, projectile cover.
- https://www.ssbwiki.com/Neutral_game : neutral theory, notable projectile users, encroaching and conditioning.
- https://www.ssbwiki.com/Stalling : definition, Ultimate examples, Supernova 2025 anti-stalling rule, Melee planking cap.
- https://www.ssbwiki.com/Turtling : turtling traits, characters, tools that break it.
- https://www.ssbwiki.com/Charge_Shot : Charge Shot history and Ultimate changes.
- https://www.ssbwiki.com/Samus_(SSBU)/Neutral_special : charge formulas, timing, 112 charge frames.
- https://www.ssbwiki.com/Charge-cancel : charge cancel and storage rules, list of charge moves.
- https://www.ssbwiki.com/Reflection : reflector rules, 7-reflection cap, Pocket multiplier.
- https://www.ssbwiki.com/Absorption : absorber multipliers.
- https://www.ssbwiki.com/Hitlag : projectiles do not freeze the thrower.
- https://www.ssbwiki.com/Shield_damage : negative shield damage for projectiles since 3.0.0.
- https://www.ssbwiki.com/Perfect_shield : Ultimate 5-frame release window and projectile hitlag effects.
- https://www.ssbwiki.com/Shield_drop : shield drop removed in Ultimate.
- https://www.ssbwiki.com/Mindgame : baiting, pressuring, conditioning.
- https://www.ssbwiki.com/Spacing : threat bubbles and purposeful spacing.
- https://www.ssbwiki.com/Air_dodge : Ultimate air dodge lag, staleness, one per airborne period.
- https://www.ssbwiki.com/Jump : 3-frame jump squat in Ultimate.
- https://www.ssbwiki.com/Stale_Moves : Ultimate queue values and shield staling.
- https://www.ssbwiki.com/Edge and https://www.ssbwiki.com/Planking : 6-grab ledge limit and reduced intangibility.
- https://www.ssbwiki.com/Sudden_Death : Sudden Death becoming a camping contest.
- https://www.ssbwiki.com/Match_timer : final countdown timer.
- https://www.ssbwiki.com/Tournament_rulesets_(SSBU) : 6 to 8 minute range, timeout order, tiebreaker, Supernova 2025 rules.
- https://www.ssbwiki.com/Flaws_in_artificial_intelligence : Wii U CPU projectile and charge flaws (Melee to Wii U notes).
- https://www.ssbwiki.com/SmashWiki:Glossary : zoner definition.
- Character pages (fetched): https://www.ssbwiki.com/Samus_(SSBU), https://www.ssbwiki.com/Min_Min_(SSBU), https://www.ssbwiki.com/Snake_(SSBU), https://www.ssbwiki.com/Duck_Hunt_(SSBU), https://www.ssbwiki.com/Pac-Man_(SSBU), https://www.ssbwiki.com/Link_(SSBU), https://www.ssbwiki.com/Villager_(SSBU), https://www.ssbwiki.com/Isabelle_(SSBU), https://www.ssbwiki.com/Robin_(SSBU), https://www.ssbwiki.com/Hero_(SSBU), https://www.ssbwiki.com/Steve_(SSBU) : attributes and competitive notes.
- https://www.ssbwiki.com/Template:Samus_and_Dark_Samus_in_competitive_play_(SSBU) : Yaura major win.
- https://www.ssbwiki.com/Smasher:Doramigi, https://www.ssbwiki.com/Smasher:Hurt, https://www.ssbwiki.com/Smasher:Dabuz : player playstyle sections.
- https://ultimateframedata.com/samus : Charge Shot shield advantage, 125-frame full charge (fetched, summarised by the tool).
- https://ultimateframedata.com/snake : grenade pin-pull 21 frames, detonation near frame 150 (fetched, summarised).
- https://ultimateframedata.com/robin : Thunder startup, charge entry and cancel frames, shield advantage (fetched, summarised).
- https://ultimateframedata.com/hero : Frizz, Frizzle, Kafrizz shield advantage, charge time and MP cost (fetched, summarised).
- https://ultimateframedata.com/link : bow charge and total frames, shield advantage, arrow lifetime (fetched, summarised).
- https://ultimateframedata.com/minmin : up smash reflector frames (fetched, summarised).
- https://ceogaming.org/trending-games/ssbu/ : 3 stock 7 minutes, Sudden Death does not count (summarised).
- https://www.umsmash.com/rules/ : Big House stalling prohibition and timeout order (summarised).
- https://smashworldtour.com/wp-content/uploads/2022/03/SWT-2022-Rulebook.pdf : 7 minutes, stalling forfeit clause (summarised).
- https://www.teamliquid.com/news/2023/10/27/Dabuzs-odyssey-a-kings-journey-home : Dabuz's zoning and camping at Kagaribi 10 (summarised).
- https://github.com/aevalmere/aevalrena : local repo read-only (docs/SPEC.md, docs/CPU_AEVALMERE.md, src/core/constants.ts, src/characters/aeval/moves.ts, src/sim/hits.ts, src/sim/projectiles.ts, src/sim/actions.ts, src/ai/index.ts, src/ai/aevalmere.ts).

Not readable: the Evo 2019 ruleset archive (blocked), the Supernova 2025 rulebook on Google Drive (did not render), Panda Cup rules (the one URL I tried returned nothing), Reddit (blocked). The web search budget was exhausted after one failed query, so no search snippets and no forum sources are used. Every source above was fetched.

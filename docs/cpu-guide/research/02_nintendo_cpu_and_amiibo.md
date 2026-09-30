# Official Smash CPUs, amiibo Figure Players, and CPUs in other platform fighters

## Corrections to common assumptions

- CPUs do not read inputs. In 2013 Toomai checked Brawl CPU GIFs frame by frame and concluded that the CPU reacts within one frame of the opponent entering an attacking state, which is frame-perfect but not button-reading (https://www.ssbwiki.com/Talk:Artificial_intelligence). SmashWiki's AI article repeats this and lists the Brawl "CPUs learn from you" rumour as disproven by save-file and code disassembly (https://www.ssbwiki.com/Artificial_intelligence).
- Level 9 does not "always tech" in Ultimate. SmashWiki says CPUs never try to tech unless the player hits them before they land, which makes them buffer a tech, and in another paragraph says stage spikes and jab resets usually end in a successful tech because the CPU was already dodging (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). The two statements pull apart and no frame test exists on the page. Model tech as a side effect of a proximity-triggered defensive input. unverified: the exact trigger.
- Level 9 does not mash perfectly in Smash 4 and Ultimate. The AI article says it does, the button mashing article gives a 2nd to 3rd frame cadence, and a February 2026 talk-page test found a human stick-spinner escaping shield-break stun nearly 120 frames sooner (https://www.ssbwiki.com/Button_mashing , https://www.ssbwiki.com/Talk:Button_mashing).
- No source I could reach ties the 25 personalities to update 13.0.0. Exion Vault documents 25 personalities in a 2021 guide (https://exionvault.com/ssbu-amiibo-personality/), and the game's label list contains personal_0 to personal_24 (https://github.com/ultimate-research/param-labels). SmashWiki's Ultimate AI flaw list is current to 13.0.1 (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)). unverified: any version that introduced personalities.
- Ultimate's CPU data does not use Brawl-style `aiscript` or `ai_data` files as far as any public listing shows. The cracked archive path list has only `.prc` parameter files under `ai/param/` directories (section "Ultimate CPU data files"). Where the decision logic lives is unverified.
- The goozamiibo training article is unreliable. It describes "stat food" and attack cubes, which SmashWiki says did not return in Ultimate (https://www.ssbwiki.com/Figure_Player). It is used for nothing below (https://goozamiibo.com/blog/training-smash-amiibo-figure-players/).

## Level scale

Levels run 1 to 9. The default is level 1 in Melee and level 3 in every other game, and Ultimate rules can set the default (https://www.ssbwiki.com/Artificial_intelligence). From Brawl on, each level maps to an internal value: 0, 15, 21, 31, 42, 48, 60, 75, 100 for levels 1 to 9, the same in Brawl, Smash 4 and Ultimate (https://www.ssbwiki.com/Artificial_intelligence). The steps are 15, 6, 10, 11, 6, 12, 15 and 25. The table is hand-tuned and uneven, and the largest jump is into level 9.

What SmashWiki documents a level changing:

- Follow-through and speed. The level sets how likely the CPU is to act on a decision and how fast it reacts. A level 1 and a level 9 both "decide" to attack, but level 1 almost never does and waits a long time, while level 9 almost always does, instantly (https://www.ssbwiki.com/Artificial_intelligence).
- Defense. Low levels rarely shield or dodge and use rolls to reposition. High levels almost always defend when not in lag. From Brawl on, level 9 defends against almost any attack with one-frame reactions (https://www.ssbwiki.com/Artificial_intelligence).
- Mashing. Melee CPUs try an input every third frame, with about 15% of attempts succeeding at level 1 and about 90% at level 9. In Brawl, level 3 mashes every 10th frame and level 9 every 3rd. In Smash 4 and Ultimate, levels 1 and 2 do not mash, level 3 mashes every 12th to 13th frame and level 9 every 2nd to 3rd (https://www.ssbwiki.com/Button_mashing).
- Option choice. Low levels stand near the opponent and use jab or tilts. High levels use aerials, smash attacks and grabs (https://www.ssbwiki.com/Artificial_intelligence).
- Recovery. Low levels recover with one predictable up special. High levels in Brawl, Smash 4 and Ultimate alternate routes. Smash 4 Luigi uses only Super Jump Punch at levels 1 to 5 and adds Green Missile and Luigi Cyclone at 6 to 9 (https://www.ssbwiki.com/Artificial_intelligence).
- Ultimate specifically. Aggression and reaction were raised at every level, starting at level 2. Higher levels perform advanced techniques for the first time in the series: dash dances as an approach, fast short-hop aerials to pressure shields and start combos, B-reverses and reverse aerial rushes. At level 9 these become the CPU's main tactic (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Training-mode dummies. Stand, Walk, Jump, Evade and Attack modes exist, with internal names CPTP_STAY, CPTP_WALK, CPTP_JUMP, CPTP_ESCAPE and CPTP_NORMAL. A Stand CPU still recovers offstage, does a floor recovery after a knockdown, ledge-jumps and leaves revival platforms (https://www.ssbwiki.com/List_of_CPU_modes).

Level-scaled parameter names exist in the game data. The community label list for Ultimate's `.prc` files contains `attack_interval_min_level_min`, `attack_interval_min_level_max`, `attack_interval_max_level_min`, `attack_interval_max_level_max`, matching `attack_interval_random_add_*_level_*` and `attack_interval_0_probability_level_*` names, and the same family with `move_interval_` (https://github.com/ultimate-research/param-labels). unverified: my reading is that each bound of the frame gap between decisions has a value at the lowest and highest level and is interpolated by the 0 to 100 level value, with a probability of a zero gap (decide immediately). The label list gives names only, not values or file membership.

Aevalrena:
- The existing `CPU_PROFILES` table already has the same two skill knobs: `period` (decision cadence, 14 down to 1 frame) and `reactMs` (250 down to 17 ms, one frame at level 9). Keep them separate: cadence controls how often the CPU thinks, reaction controls how old the state it reads is.
- Nintendo's level table is irregular by hand. For "levels must be fair and easy to derive", compute every skill knob from one scalar per level with a stated curve, so a designer can recompute the whole table.
- The level 8 to 9 jump in Nintendo's table (25 of 100) is where the "cheating" perception sits. In Aevalrena the intended big step is level 5 balanced (the god CPU), so the level just below it must stay human-plausible in reaction and follow-through.
- Nintendo's mash cadences give a ready mapping for Aevalrena's mash-out: no mashing at the bottom, roughly one input per 12 to 13 frames at a low-mid level, one per 2 to 3 frames at the top human-like level. The god CPU already mashes the maximum the sim counts.

## Reaction and information

- Reaction is state-based. Toomai's Brawl result: the CPU sees the opponent's attacking state one frame before the hitbox and inputs a dodge, which is frame-perfect but sees no buttons (https://www.ssbwiki.com/Talk:Artificial_intelligence).
- Ultimate CPUs trigger on proximity plus attack state. SmashWiki says higher-level CPUs air dodge almost frame-perfectly, but only when a player or CPU inputs an attack near them or a projectile gets close enough (https://www.ssbwiki.com/Artificial_intelligence). They put up a shield when a player approaches from about two character lengths away (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). They shield or spot dodge when a player runs at them and wait out counterattacks to punish end lag (same page).
- CPUs are slower against other CPUs. SmashWiki says Ultimate CPUs do not have the quick reactions against other CPUs that they have against humans, except while edgeguarding, and that in 2v2 the enemy CPU is ignored while the human is targeted (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Perception delay bugs matter. Fraymakers early access v0.6.8 (9 March 2024) fixed a bug where the CPU had a 5 to 15 frame delay before receiving foe position updates (https://steamdb.info/patchnotes/13691308).

Aevalrena:
- Use one explicit perception delay per level, deterministic and drawn from the level table, never an accidental pipeline lag as in the Fraymakers bug. Aevalmere's 4-frame delay is the pattern.
- Feasibility rule for a defensive reaction, proposal (not from a source): the CPU acts on a snapshot `delay` frames old. An option with first protected frame `f` (spot dodge 3, roll 3, air dodge 2 in Aevalrena) can beat a hit only if `firstActiveFrameOfHit - framesSinceVisible >= delay + f`. Moves whose startup is at or below `delay + f` are unreactable at that level. This makes reaction limits fall out of move data instead of a shield chance.
- CPU vs CPU matches must run identical reaction logic. Ultimate's CPU-vs-CPU sluggishness would invalidate any ladder calibration.

## Documented behaviours by situation

### Defense

- Level 9 perfect shields and dodges very often in Brawl to Ultimate. Ultimate's perfect shield changes did not reduce this (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). Melee level 9 reflects almost any projectile with a power shield and rarely shields physical moves (same page).
- Shield handling flaws: Smash 4 CPUs hold shield against strong attacks until it nearly breaks and, after shielding or rolling, nearly always roll then grab or forward smash (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)). Ultimate CPUs shield-grab after a shielded hit and always try a shield grab when hit on shield by a neutral attack, so a flurry attack that keeps going hits them once pushback ends (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Multi-hit blindness: Ultimate CPUs shield only the first hit of a multi-hit attack and do not dodge lingering hitboxes such as PK Thunder (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)).
- Air dodge habits: Smash 4 CPUs at high levels always try to air dodge incoming attacks while airborne, air dodge after hitstun ends when launched far, and repeat it into landing lag (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)). Ultimate levels 7 to 9 air dodge near frame-perfectly, hold jump in the air even with no jumps left, and "phantom footstool" the player, which makes aerial combo practice awkward; approaching an airborne CPU with an aerial baits a wasted air dodge, which can no longer be spammed (https://www.ssbwiki.com/Artificial_intelligence , https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Ultimate CPUs always use an air dodge as soon as actionable after a meteor bounce, never use directional air dodge for distance, and do not SDI or DI well (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)). Brawl CPUs mostly did not DI (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Melee CPUs never tech on walls or ceilings unless launched very close (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBM)).

### Offense and neutral

- Approach is simple. Melee CPUs walk at the player, throw projectiles periodically, then spam dash grab and jab; Smash 4 CPUs dash grab from a safe distance even if the target jumps away (https://www.ssbwiki.com/Flaws_in_artificial_intelligence , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)).
- Close range is predictable. Smash 4 CPUs almost always grab when they land, roll or finish an attack next to a foe, always pummel at least once, favour down throw to combo and back throw to KO whatever the character (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)). Ultimate KO throws still lean on back throw (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Hard-coded follow-ups: from Smash 4 for Wii U, most high-level CPU characters always follow a down throw with a set aerial or special, even when it no longer works at higher percent (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Projectile logic: CPUs fire projectiles only in certain ranges, jump before shooting even when the shot goes straight, and fail to reposition between shots (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU) , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)).
- Precision without judgment: Ultimate CPUs land hard-to-sweetspot moves "to an inhuman degree" (three example characters named on the page) yet fail to recognize when the opponent is helpless in landing or end lag and instead retreat or roll (https://www.ssbwiki.com/Flaws_in_artificial_intelligence , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)).
- Vertical chase: Ultimate CPUs stand under an airborne opponent and up smash, and jump constantly (using the 3-frame jumpsquat to leave the ground under attacks, then landing with an aerial), which can be beaten by burning their jumps or perfect shielding (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Invulnerability is misread: Ultimate CPUs challenge super armor and invincible attacks, and Smash 4 CPUs roll in lockstep with a player who has roll intangibility or respawn invincibility (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU) , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)).

### Ledge, recovery and edgeguarding

- Ultimate CPUs edgeguard hard: they leave the stage to attack quickly, attack back with aerials while recovering, and so make it dangerous to edgeguard them; they react to neutral-infinite tricks at the ledge with ledge attacks or rolls (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- The same behaviour is a flaw: every CPU heads for an edge to edgeguard the moment anyone is offstage, so several CPUs pile toward one ledge, even when their own recovery is weak (https://www.ssbwiki.com/Flaws_in_artificial_intelligence , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)).
- Recovery always targets the ledge, never high onto the stage, and damaging recoveries always swing at an opponent on the ledge (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)). Several characters never use certain recovery moves or never mix routes (same page).
- Ledge options: Smash 4 CPUs frequently ledge jump, so a cover of ledge jump punishes them (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)).
- Project M CPUs air dodge off stage when trying to wavedash to the ledge and never fight off edgeguarders (https://www.ssbwiki.com/User:Ultimate_Toad/List_of_flaws_in_artificial_intelligence_(PM)).

### Knockdown, tech and getup

- Ultimate CPUs always get up after a fixed time and try getup attacks when others are near (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). Brawl CPUs floored by Snake-style Flame Choke lingered before inputting a getup option (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBB)).

### Known exploitable patterns to avoid copying

From Ultimate: shield at two character lengths, constant jumping into aerials, air dodge that can be baited, always shield grab after a neutral attack on shield, ledge and getup timing fixed, projectiles only at set ranges, tether recoveries only used near an opponent, reflectors that reflect whenever a projectile is in front even while recovering (https://www.ssbwiki.com/Flaws_in_artificial_intelligence , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)). SmashWiki also notes that CPUs cannot learn from mistakes or mind-game (https://www.ssbwiki.com/Artificial_intelligence). The wiki's own inclusion rule is useful: a flaw counts only when the behaviour is repeated nearly every time the situation recurs (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)).

## Figure Players (amiibo) in Ultimate

### Architecture

- A Figure Player (FP) is the base CPU of its character with a per-amiibo training file layered over it. Exion Vault states the FP has a visible level 1 to 50 and a hidden base CPU level that rises with it; at visible level 43 the base switches to a level 9 CPU, and an FP raised to 50 with Learning off ends up nearly identical to a level 9 CPU (https://exionvault.com/2021/04/30/ssbu-amiibo-general/ , https://exionvault.com/amiibo-wiki-level/). Exion Vault's amiibo wiki is community documentation, not official.
- The two levels are separate counters in the save data. Visible level comes from `Level Experience` and only scales stats. Hidden CPU level comes from `CPU Experience` (thresholds 0, 63, 210, 434, 749, 1141, 1603, 2065, 2765 for levels 1 to 9). Visible level 43 needs 2459 level experience and level 50 needs 3912 (https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit). unverified: how the two counters relate, since 2765 CPU experience for level 9 does not equal 2459 level experience for visible 43.
- Damage scaling by visible level: a multiplier of 0.9 at level 1 rising linearly to 1.3 at level 50, applied as damage dealt times the multiplier, damage received divided by it (10% less dealt and 11% more received at level 1; 30% more dealt and 23% less received at level 50). This cannot be turned off (https://www.ssbwiki.com/Figure_Player). Tournament rules ban FPs in doubles because of these buffs (same page).
- Learning toggle: a single bit in the save data (https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit). With Learning off the FP keeps leveling but its training data does not change between matches; it is the only way to change personality without spirits when on, and most tournament FPs compete with it off to preserve their style (https://exionvault.com/amiibo-wiki-learn-button/). Training Mode FPs do not gain experience (https://www.ssbwiki.com/Figure_Player).
- Data are stored as fixed-width bit fields read as a percentage of the field's maximum. The widths are 4 to 7 bits for behaviour values (for example near 7, offensive 7, grounded 7, attack-out-cliff 6, dash 7, return-to-cliff 6, air-offensive 6, cliffer 6, feint values 7 each, grab 7, smash-holder 7, shield-master 7, perfect-shield 6, shield-grab 6), and 9 to 10 bits for move weights (https://gist.github.com/xSke/979dabd395c39eff36bcaccf87d66a3e , https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit). The gist's author comments that the game itself works with values out of 100.

### Behaviour values

Names below follow the community research document and Exion Vault's editing page (https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit , https://exionvault.com/amiibo-wiki-editing/).

- Spacing and stance: Near (preferred closeness to the target), Offensive (attack versus defend), Grounded (stay on the ground), Dash (initiate dashes), Air Offensive (attack while landing from height; Exion's page describes it as air offensive decisions in general, and the two descriptions differ).
- Ledge: Attack Out Cliff (leave the stage to edgeguard), Return To Cliff (recover to the ledge rather than the stage top), Cliffer (hang on the ledge while edgeguarding), Meteor Smasher (prefer spikes offstage).
- Anticipation (three feint values): Feint Master (bait, dash dance, fox trot), Feint Counter (counterattack after block or dodge; low values mean the FP dodges more), Feint Shooter (use projectiles at range and counter projectiles). Exion Vault groups these as "anticipation", and says Feint Master and Counter internals are only partly understood (https://exionvault.com/amiibo-wiki-feint-values/). Real behaviour example: the best Ness amiibo have high Feint Shooter and low PK Fire and PK Thunder move weights, so projectiles are used from range and close-range moves are used up close (same page).
- Defense: Shield Master (hold shield, includes multi-hit defense), Just Shield Master (perfect shield rate, separate from shield use), Shield Catch Master (grab out of shield), plus air dodge direction weights (forward, backward, neutral as remainder).
- Offense: Catcher (grab), Smash Holder (charge smashes), Dash Attacker, 100 Attacker and 100 Keeper (start and continue rapid jab), Attack Cancel (stop jabs early), Critical Hitter (moves with the zoom effect), Charger, Taunt with up, down and side weights.
- Move weights: grounded moves fTilt, uTilt, dTilt, fSmash, uSmash, dSmash and four grounded specials sum to 100 with jab as the implicit remainder; aerials fair, bair, uair, dair and four aerial specials sum to 100 with neutral air as the remainder (same research document). Exion Vault notes an FP with all grounded weights at 0 only jabs and one with all aerial weights at 0 only neutral airs.
- Item and target values: item collectors, throw and swing values, and three targeting values (Advantageous Fighter, Weaken Fighter, Revenge; the stage enemy share is the remainder).
- Five character slots, `Fighter_1` to `Fighter_5`, hold character-specific choices: for example Incineroar's Revenge-buffed move split, Shulk's Monado Art split, Ryu and Ken light-tilt use, Bayonetta's Bullet Arts, Hero's menu choices, and Kazuya's back tilt and crouch attack. Slots for one character add up to 100 where a split is described (same document).

### How learning behaves

All of this is community observation, not developer documentation (Exion Vault states that the developers say almost nothing about how amiibo learn: https://exionvault.com/2021/04/30/ssbu-amiibo-general/).

- FPs learn the same way at every level, and learn more from their own attacks that connect than from the opponent's. A KO by the FP's forward smash raises the forward smash value noticeably, and being KO'd by the opponent's forward smash raises it only slightly (https://exionvault.com/amiibo-wiki-level/).
- Moves that do not connect get used less in the next match. Letting the FP hit you is the way to raise a move's weight (https://exionvault.com/2021/04/30/ssbu-amiibo-general/).
- Player actions move specific values: holding or flicking shield raises Shield Master and Just Shield Master, attacking often raises Offensive, dashing raises Dash, charging smashes raises Smash Holder, shooting an FP with a projectile item raises Feint Shooter (https://exionvault.com/2021/04/30/ssbu-amiibo-general/ , https://exionvault.com/amiibo-wiki-editing/).
- Early on the FP copies the trainer instead of countering: training a Zero Suit Samus against Ganondorf's down smash pushes her toward down smash even though hers hits one side only (https://exionvault.com/amiibo-wiki-learn-button/).
- There is no per-matchup memory. FPs cannot learn to change style for the character they face; they only gain slightly more experience from characters they have not met, tracked with 89 bits, one per fighter (https://exionvault.com/2021/04/30/ssbu-amiibo-general/ , research document above).
- Quitting a match discards what happened in it (https://exionvault.com/2021/04/30/ssbu-amiibo-general/). unverified: this implies updates are applied at match end.
- Feeding spirits resets or reshuffles training values to defaults based on spirit type (research document; Exion Vault says each spirit shuffles training data).
- Never train an FP against other AI: amiibo trained by other amiibo or CPUs "always turn out bad" (https://exionvault.com/2021/04/30/ssbu-amiibo-general/).
- Level 1 FPs mostly stand still with a few random attacks (https://exionvault.com/amiibo-wiki-level/).
- In Smash 4, SmashWiki says FPs adapt during a match, for example adding spot dodges and rolls against a rushdown opponent (https://www.ssbwiki.com/Figure_Player).

### Personalities

- The personality is not stored. It is recomputed when the amiibo is scanned from the behaviour values (research document). Exion Vault credits datamining by Ske and MiDe: eight groups of three plus Normal, ordered mild, mid, extreme (https://exionvault.com/ssbu-amiibo-personality/). Groups: def (Cautious, Realistic, Unflappable), agl (Light, Quick, Lightning Fast), ofn (Enthusiastic, Aggressive, Offensive), rsk (Reckless, Thrill Seeker, Daredevil), gen (Versatile, Tricky, Technician), ent (Show-Off, Flashy, Entertainer), cau (Cool, Logical, Sly), dyn (Laid Back, Wild, Lively).
- Scoring procedure (reconstructed in a public script): for each group, skip it if its required value is under threshold; scale each contributing value to 0..1 as `(value - 50) / 50`, or `(50 - value) / 50` for inverted terms, clamped so anything under the midpoint counts as 0; add points for each threshold the scaled value reaches; the group with the highest score wins, ties broken by group index; the tier within the group comes from score thresholds; no eligible group means Normal (https://gist.github.com/xSke/979dabd395c39eff36bcaccf87d66a3e). unverified: the threshold and point tables, which the gist reads from a JSON file not included there.
- Exion Vault's stance is "personalities don't matter": the label is a summary, the values are what act (https://exionvault.com/ssbu-amiibo-personality/).
- What each label does, community summary (https://www.ssbwiki.com/Figure_Player, citing Amiibo Dojo; Exion notes it is hard to tell a label from watching play):
  - Normal: balanced default; most FPs lose it after leveling. Laid Back: like Normal, slower movement.
  - Cautious: defensive, avoids gimps. Realistic: more so, hesitates to edgeguard. Unflappable: extremely defensive, strong shielding and parries, prefers grounded and smash attacks.
  - Cool: reluctant to attack, uses rolls and dodges, waits out approaches and counters misses. Logical: projectile-heavy, prefers recovering to gimping. Sly: like Logical with more projectiles and dash dances and fox trots.
  - Light: airborne short combos. Quick: longer ground combos, dash dances and fox trots. Lightning Fast: approaches with dash dances and fox trots before combos.
  - Enthusiastic: offensive, takes risks, many smashes. Aggressive: combos ending in a strong attack, sometimes dash dance approaches. Offensive: like Aggressive, gimps more, kills sooner. Reckless: rarely defends. Thrill Seeker: gimps offstage as a main option and often self-destructs. Daredevil: very risky, sometimes sacrificial KOs.
  - Versatile: balanced and adaptive (little known). Tricky: punishes, moves around, spaces projectiles. Technician: like Tricky with more short-hop specials and projectiles.
  - Show-Off: goes offstage for spikes. Flashy: gimps, aerials, mid-match taunts. Entertainer: risk-taking (little known). Wild: aggressive Light, gimps, may taunt. Lively: rarely still, may gimp, taunt or dash dance.

### Spirits and stats

- A primary spirit gives stats of `min(Team Power x 0.61, 5000)` times the attack or defense share; the multiplier from a stat is about `1 + stat x 3.077 / 10000`, so about 2.54 at 5000 (https://www.ssbwiki.com/Figure_Player).
- Three support-spirit slots add effects and lower stats, alter the personality and are active even when spirits are off in the rules (same page). The spirit list in the research document shows unused effects such as "No Perfect Shield", "Explosive Perfect Shield" and "Endless Smash Holding" (research document).
- FPs can go on journeys and enter online Battle Arenas since 3.1.0 (https://www.nintendo.com/en-gb/Support/Nintendo-Switch/Game-Updates/Super-Smash-Bros-Ultimate-Update-History-1549104.html).

### What FPs and the base AI cannot handle

- Training cannot add a combo the base AI lacks, cannot fix recoveries, and cannot teach dodging super armor, command grabs (Alolan Whip) or repeated shield-break kills (https://exionvault.com/amiibo-wiki-hard-coded/ , https://exionvault.com/2021/04/30/ssbu-amiibo-general/).
- Metagame: moving hitboxes (Falcon Kick, Power Thrust, Rollout, Flare Blitz), multi-hit moves (FPs perfect shield the first hit and then drop guard), and heavy super-armor characters dominated tournaments (https://exionvault.com/amiibo-wiki-ssbu-metagame/). Optimal FPs walk instead of run, because running FPs dash into attacks (https://exionvault.com/amiibo-wiki-movement/), spam one strong attack plus a second faster move (the "Musket Method"), and keep rolls and air dodges rare (metagame page).
- Amiibots is a site where trainers upload FPs for automated matchmaking, rated by results; the metagame page says it has run more than 10,000 matches (https://exionvault.com/amiibo-wiki-ssbu-metagame/ ; the site itself is a script-rendered app and its rating method is unverified: https://www.amiibots.com/).

Aevalrena:
- Nintendo separates skill from style. Level is skill (reaction, follow-through, mash rate, option vocabulary), and the amiibo values plus personality are style. Aevalrena's four archetypes by five levels map directly onto that: a skill scalar from the level, a style vector from the archetype. Do not let an archetype change reaction delay, and do not let a level change style weights except through the skill-gated option vocabulary.
- Suggested style vector, mapped from Nintendo's values to Aevalrena's mechanics: Near (approach distance), Offensive (attack versus wait), Grounded, Attack Out Cliff (edgeguard trips), Return To Cliff (ledge versus stage-top recovery), Cliffer, three anticipation values (bait, counter, projectile), Catcher (grab rate), Smash Holder (charge smashes), Shield Master, Shield Catch, Meteor Smasher (spike use; Aeval has a spike down air).
- Archetype labels from Nintendo's personalities: aggressive is Enthusiastic to Offensive, defensive is Cautious to Unflappable plus Logical and Sly for a zoner, countering is Cool (wait out approaches, counter misses) plus a high Feint Counter, balanced is Versatile (mid values). Compute a display label from the vector like the game does; do not store it.
- Make the "noticeable traits" claim testable: run archetype-vs-archetype CPU matches and assert measurable gaps in shield-time fraction, average distance, grabs per minute, offstage trips per stock and counter-attack rate after opponent whiffs. These metric names are a proposal, not a source.
- Encode move choice the Nintendo way for any new character: weights over grounded and aerial move classes with an implicit remainder move, separate ground and air specials, and up to five per-character slots for special choices (a second character's charge or stance moves). The brain reads weights, not character names.
- Learning of the CPU itself is not required by the design goals. If a "sparring partner" that adapts is wanted, the observed rule set is: update only from human-controlled opponents, learn more from moves that connect and kill than from moves that hit you, commit at match end, provide a toggle, and never train against CPUs. Proposal update rule: `w[m] += a_hit` on connect, `+= a_kill` on a kill, `-= a_miss` on whiff, `+= a_hurt` (small) when the opponent kills with `m`, then renormalize so grounded weights sum to 1 with jab as the remainder.

## Ultimate CPU data files

- The cracked path list from the archive-hashes repository has, under `fighter/common/ai/param/`: `attack_data_param.prc`, `attack_list_param.prc`, `common_param.prc`, `fighter_param.prc`, `nfp_learning_param.prc`, `nfp_param.prc`, `personality_param.prc` and `stage_param.prc`. Each of 94 fighter directories also has `fighter/<name>/ai/param/attack_data_param.prc` and `attack_list_param.prc` (https://github.com/ultimate-research/archive-hashes). I searched the full 591,276-line path list (`Hashes_FullPath`) for `ai` directories, `aiact`, `aipd`, `aiscript` and `ai_data`; the only AI hits were these `.prc` files. The list only holds paths that have been cracked, so absence is not proof.
- `.prc` is the parameter format read by the community tools (https://github.com/benhall-7/paracobNET), and names for its hashed fields are in `ParamLabels.csv` (https://github.com/ultimate-research/param-labels). The CSV maps hashes to names only, without file membership.
- File names suggest the split: common tuning (`common_param`, `fighter_param`, `stage_param`), amiibo-specific data (`nfp_param`, `nfp_learning_param`, `personality_param`), and per-character attack lists and per-attack data. unverified: the contents of each file.
- Label names in the CSV that look like AI tuning, for orientation only:
  - Level and interval: the `attack_interval_*_level_*` and `move_interval_*_level_*` families listed above; `cpu_lv_1`, `cpu_lv_3`, `cpu_lv_5`; `cp_personality`; `personal_0` to `personal_24`; `personal_type`.
  - Decision ratios: 69 `base_ratio_*` names covering weak, strong, smash, special and aerial attacks by direction, `catch`, `near_catch`, throws (`throw_upper`, `throw_lower`, `throw_horizontal`), `shield`, `escape_n/f/b`, `escape_air_n/f/b`, `appeal_hi/lw/s`, `approach_run`, `move_dash`, `cliff_out`, `cliff_near`, `return_hi` and `weak_combo_stop`. Names of the form `base_ratio_<x>_need_count` exist for cliff-out, defense, attacks, throws, return, item throw and weak combos (unverified: I read them as minimum-sample thresholds before a learned ratio applies).
  - Character-specific ratios: `base_ratio_gaogaen_revenge_*`, `base_ratio_shulk_monad_*`, `base_ratio_ryu_*`, `base_ratio_bayonetta_shoot*`, `base_ratio_brave_*`, `base_ratio_rosetta_tico_free`, `base_ratio_kamui_special_n_range_s`. These line up with the `Fighter_1` to `Fighter_5` slot descriptions in the amiibo research, which supports reading the amiibo behaviour fields as the per-amiibo copy of the same ratios (inference).
  - Feints: `feint_master`, `feint_counter`, `feint_shooter`, `feint_master_attack_num`, `feint_master_shield_frame`, `feint_shooter_no_shoot_frame`, `feint_shooter_shoot_interval_frame`, `attack_ground_feint`, `attack_air_feint`, `move_feint_mul_min`, `move_feint_mul_max`.
  - Targeting and stage: `target_search_nearest_mul`, `target_search_most_damaged_mul`, `target_search_selected_mul`, `danger_zone_*`, `ai_danger_list`, `ai_type`, `ai_pri`, `kumite_ai_normal`, `kumite_ai_strong_zako1` and related Multi-Man Smash entries.
- I found no documentation by jam1garner or Smashline on CPU internals. archive-hashes credits jam1garner among its contributors (https://github.com/ultimate-research/archive-hashes), and the org's public repositories are file-format and hooking libraries (https://github.com/ultimate-research). unverified: a Reddit post by williamatherton on how CPUs and amiibo work, which the amiibo research document recommends (https://www.reddit.com/r/SmashBrosUltimate/comments/1hdk89a/explanation_of_how_cpus_amiibos_work_in_smash/); the site blocked every fetch.
- For Brawl, the community "AI Handbook" documents its script system, but the thread was behind a Cloudflare check and I could not read it (https://smashboards.com/threads/ai-handbook-2-0x-readable-syntax-stable.300461/). unverified: anything about Brawl AI scripts.

Aevalrena:
- Copy the structure, not the values. Per character: an attack list (which moves the brain may use, tagged by role such as poke, punish, kill, edgeguard, anti-air, projectile) and per-move data (range, startup, active window, end lag, knockback), both derivable from the move tables. A small set of common tuning values applies to every character, and a handful of named slots per character carry special choices.
- Keep amiibo-style hard-coded combo lists as data (down throw into a chosen aerial), but gate them by percent and knockback, since Smash 4 and Ultimate CPUs keep attempting them when they no longer work (https://www.ssbwiki.com/Flaws_in_artificial_intelligence).
- Rivals of Aether's default AI is the simplest version of the same idea (next section): per-character arrays of moves by distance zone.

## Player complaints and design rules

Complaint sources: SmashWiki's AI articles and per-game flaw lists, Exion Vault, a Rivals 2 feedback thread. Rules are the conclusions; the sources are for the observation.

| Complaint | Observed cause | Rule for a human-like CPU |
|---|---|---|
| "Level 9 cheats" (perfect shields, dodges on the first frame) | One-frame reaction and near-100% follow-through (https://www.ssbwiki.com/Artificial_intelligence) | R1: react from a delayed snapshot, gated by move startup versus delay plus first protected frame. R2: follow-through probability is a separate knob from delay. Only the god CPU may go near one frame. |
| "It perfect shields everything" | Ultimate perfect shield changes did not reduce CPU use (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R3: cap defensive commits. A CPU that never gets hit by single hits still loses to multi-hit, lingering hitboxes and baits; keep those weaknesses at every human-like level. Aevalrena has no perfect shield, so the analogue is spot dodge, roll and shield timing. |
| "Dumb in neutral, perfect reactions" | Simple approach (walk, dash grab, projectile at set range) next to frame-perfect defense (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R4: derive reaction, spacing, approach variety and execution error from one skill scalar so they rise together. Archetype changes style only. |
| Air dodges every aerial | Level 7 to 9 air dodge near frame-perfectly, constantly, then eat landing lag (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)) | R5: treat air dodge as a scarce resource. Use it when the alternative is a combo or kill, not on every visible attack. Aevalrena allows one per airborne period, which forces this. |
| Rolls and grabs after every shield | Fixed after-shield chain (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)) | R6: after a shield hit pick among grab, up smash, up special, roll, spot dodge, jump and hold, weighted by frame advantage and the opponent's recent habits. Aevalrena limits out-of-shield options, so use exactly that set. |
| Holds shield until it breaks | Shield hold without HP awareness (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)) | R7: read shield HP (60 in Aevalrena, 0.12 decay per frame held) and drop or roll before a floor that scales with level. |
| Shields at two character lengths | Proximity trigger with no threat check (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R8: allow a guard stance at low levels only, with a duration cap; at higher levels require a visible attack. |
| Same option every time | Back throw for every KO, down throw combo at any percent, one projectile range (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)) | R9: choose options from move data (knockback at the current percent, range, end lag), not character identity, and add a repeat penalty so a used option loses weight for a while. |
| Recovery always aims the ledge | Single route (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU)) | R10: enumerate reachable routes (ledge, stage top, platform), choose among valid ones at random, with a last-ditch attempt when none is valid. Attack back at an edgeguarder only when the swing is safe. |
| CPUs flock to edgeguard | Edgeguard trigger fires on any offstage target (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R11: gate an offstage trip on the CPU's own recovery feasibility and the opponent's remaining jumps, and on level. |
| Fixed getup and ledge timing | Predictable wakeup (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R12: sample getup, tech and ledge choices and their timing (with frame jitter) from level-dependent distributions. |
| Inhuman precision on hard moves | Sweetspots and hard inputs landed every time (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R13: add per-move execution error that scales down with level, larger for moves with small windows. |
| Cannot handle multi-hit, moving hitboxes, command grabs, armor | Recognition gaps in the AI (https://exionvault.com/amiibo-wiki-ssbu-metagame/) | R14: give each level a recognition score for unusual move classes. Humans learn these, so it rises with level and reaches 1 only for the god CPU. |
| Sluggish against other CPUs | CPU-vs-CPU reaction differs (https://www.ssbwiki.com/Flaws_in_artificial_intelligence) | R15: identical logic whether the target is human or CPU. |
| Lockstep rolling against intangible frames | CPU treats an opponent's intangibility as a threat (https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4)) | R16: read invulnerable flags and wait out the window unless the level is deliberately baitable. |

Aevalrena:
- R1 to R4 together are the core of "levels must be fair". A CPU that fails R4 will read as cheating in one situation and dumb in another, which is the exact Nintendo complaint.
- Keep an explicit bait weakness parameter per level (probability of committing to a punish on an empty hop, a shield poke or an intangible roll). SmashWiki records that CPUs can be baited into laggy moves and dodges because they react to distance, proximity and an attack being thrown (https://www.ssbwiki.com/Flaws_in_artificial_intelligence). That same weakness is what makes a level feel human. It must fall to zero only for the god CPU.
- Ultimate's flaw list has a useful test for any Aevalrena rule: a behaviour is a flaw only if it repeats almost every time a situation recurs. Measure per-situation option entropy over many CPU matches and require it above a floor for human-like levels.

## Other platform fighters

### Rivals of Aether (workshop and built-in)

- The workshop AI hooks are `ai_init.gml` (called when a CPU of the character is created) and `ai_update.gml` (every frame). By default CPUs pick attacks at random from arrays chosen by the opponent's location: `far_up_attacks`, `far_down_attacks`, `far_side_attacks`, `mid_side_attacks`, `close_up_attacks`, `close_down_attacks`, `close_side_attacks` and `neutral_attacks`, each entry equally likely. Variables exposed are `ai_target`, `ai_recovering` and `temp_level` (difficulty 1 to 9) (https://rivalslib.com/workshop_guide/programming/reference/scripts/ai_scripts). I read this from the site's page data, not the rendered page. The page is marked under construction.
- Official docs list a `get_training_cpu_action` function (https://rivalslib.com/ , read from page data). unverified: its return values.
- A workshop character template's changelog mentions a CPU template that only runs when `cpu_fight_time` is over zero and checks distance and angle to the target in fight mode (https://steamcommunity.com/sharedfiles/filedetails/changelog/2859046287). Low-value detail.

### Rivals of Aether II

- The workshop knowledge base page on CPU logic (marked a stub, edited 18 June 2026) documents per-character recovery data: override `GetCpuRecoveryOptions()`, which returns the attacks that are currently viable; use `IsBasicRecoveryMoveValid()` with the vector to the nearest ledge, wall x and minimum height, the move's maximum range including the ledge-grab box, and an aerial drift slope (max horizontal speed over max vertical speed while falling). Range and slope are measured by hand in training mode and "do not have to be exact". A last-ditch option is added when no move is valid. `UpdateCpuInputsRecovery()` runs every frame while recovering, releases all inputs, reads position and ledge state, picks a random valid recovery, then applies per-move logic (for example holding toward center stage or releasing the stick at a height threshold). A helper `CpuShouldPerformAction(a, b)` gates some presses (the page uses 0.5 with 0.15 or 0.1); unverified: what the two arguments mean (https://rivals2.com/workshop/knowledge-base/character-creation/set-up-character-ai-coming-soon/).
- A 27 November 2024 patch added Bot Match Lite: a level 1 bot that gains a level when the player wins and loses one when the player loses, on random stages; the patch also made low CPU levels easier and left high levels mostly unchanged, with Abyss CPU levels re-tuned to the new scaling (https://steamdb.info/patchnotes/16564997).
- Player feedback: a Steam thread says the CPU DIs largely randomly and that hard arcade CPUs have better survival DI than even level 9 (https://steamcommunity.com/app/2217000/discussions/0/591768102733113796/). A feedback item asks for level 9 CPUs to use perfect DI on large knockback at high percent, because otherwise kill moves work far too early and training misleads players about kill thresholds (https://rivals-of-aether-ii-patch-150.nolt.io/912). Both are forum-level sources.

### Brawlhalla

- Patch 4.04 (12 August 2020) added bot difficulties Extreme and Chosen. Extreme adds dashes and throws. Chosen adds gravity cancels and chase dodges on top. New bot logic makes bots "more aware" of how their attacks and recovery options work and applies to Easy, Medium and Hard only when Test Features is on (https://brawlhalla.com/news/new-cosmetic-items-and-advanced-ai-patch-4-04).

### Slap City

- Arcade has 7 difficulties from Beginner to a hidden Devil Insane. Training Mode can change CPU difficulty on the fly and set CPU DI and SDI levels (https://slapcity.wiki.gg/wiki/Modes). Version 0.9 (17 December 2018) made CPUs prioritise an opponent nearer to a teammate, improved recovery to prefer safety zones, and added the DI and SDI options (https://slapcity.wiki.gg/wiki/Version_0.9). A known bug in 1.1 (23 September 2022) says CPUs do not SDI moves with 0 hitlag (https://slapcity.wiki.gg/wiki/Version_1.1).

### Fraymakers

- The API documentation lists CPU behaviours (`ATTACK`, `IDLE`, `EVADE`, `WALK`, `JUMP`, `SHIELD`, `HUMAN`), where `ATTACK` fights according to CPU level and level 0 acts as `IDLE` while still recovering; per-situation options for tech (default, random, always miss, in place, roll left or right), DI (default, level-based, random, none, in, out, or a fixed direction), hitstop nudge, crash bounce, ledge (climb, jump, attack, roll, wavedash, random), and shield hit (hold, grab, spot dodge, roll, random) (https://github.com/Fraymakers/fraymakers-api-docs).
- Character AI scripts can enable or disable individual built-in AI actions from an action list (jab, tilts by direction, smashes, aerials, specials with air variants, throws, airdashes, assist), and override inputs (`CharacterAiScript`, `CharacterAiActions`, same repository).
- Version 0.6.8 (9 March 2024) added training-mode CPU options for tech, shield hit, crash bounce, ledge, DI and hitstop nudge, fixed the 5 to 15 frame position delay, gave CPUs "rudimentary" teching and added basic recovery code for one character (https://steamdb.info/patchnotes/13691308).

### Project M and Project+

- Project M reprogrammed CPU AI for more technical skill (wavedashing, short-hop lasers, waveshine infinites) but CPUs still self-destruct by air dodging away from the stage, not aiming for the ledge or cutting recovery short (https://www.ssbwiki.com/Project_M). The community PM flaw list says CPUs adapted poorly to PM's air dodge changes, air dodging when unnecessary and when evading edgeguarders, and never fight off edgeguarders (https://www.ssbwiki.com/User:Ultimate_Toad/List_of_flaws_in_artificial_intelligence_(PM)). Project+ inherits several of these (https://www.ssbwiki.com/Project%2B).

Aevalrena:
- Rivals 2's recovery scheme fits Aevalrena directly, and the forward model makes it cheaper: instead of hand-measured range and drift slope, roll a copy of the state forward under each recovery plan and test whether it reaches a ledge grab or stage. Keep the pattern of a per-character list of candidate recoveries, a random pick among the feasible ones and an explicit last-ditch fallback.
- Rivals of Aether's zone arrays are a workable fallback for a new character before any tuning: build them from move data (distance band by range and startup, direction by angle).
- Fraymakers and Slap City expose CPU options (tech, DI, ledge, shield-hit) as training settings. Aevalrena's training mode can reuse the same enumerations for tech (none, in place, roll left, roll right, random), ledge (climb, jump, attack, roll, drop, random) and getup (getup, attack, roll, random), and drop the DI and SDI ones because the sim has neither.
- Brawlhalla's tiers add named techniques by difficulty. The same gating works for option vocabulary per level, for example short-hop pressure, dash grab, ledge trap and platform tech chase appear at set levels.
- Project M's air dodge lesson applies when Aevalrena changes a mechanic: per-mechanic CPU logic must be re-tuned against the new rule (air dodge is one per airborne period there), and every level needs a regression test.
- Slap City's and Fraymakers' bugs show the cost of hidden per-frame state in CPU code. Keep CPU decisions a pure function of (state, seed, level) so both LAN peers agree.

## Open questions

- No public source gives Ultimate's per-level reaction delay in frames below level 9, or the values behind the internal 0 to 100 scale. A frame test of levels 2 to 8 (shield or dodge latency against a scripted attack) would fill this.
- The contents of `personality_param.prc`, `nfp_learning_param.prc` and `common_param.prc` are not published in anything I could reach. Anyone with a dump can settle the interval-interpolation reading above.
- Whether amiibo values change during a match or at match end is unverified. The quit-discards-everything rule points to match end.
- The tension between the two SmashWiki statements on Ultimate teching needs a frame test.

## Sources

Fetched means the page or file text was read; "via summary" means only the fetch tool's page summary was seen; "snippet" means search-result title only.

SmashWiki (raw wikitext fetched):
- https://www.ssbwiki.com/Artificial_intelligence : level scale, internal 0 to 100 values, default levels, reaction, myths, amiibo summary. Fetched.
- https://www.ssbwiki.com/Talk:Artificial_intelligence : Toomai's 2013 one-frame reaction analysis. Fetched.
- https://www.ssbwiki.com/Flaws_in_artificial_intelligence : per-game CPU behaviour and flaws, Ultimate edgeguarding, exploit patterns, 1.2.0 note. Fetched.
- https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU) : Ultimate universal flaws. Fetched.
- https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4) : Smash 4 flaws (shield, air dodge, throws, projectiles). Fetched.
- https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBB) : Brawl flaws (DI, getup). Fetched, searched by keyword.
- https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBM) : Melee flaws (teching, throws). Fetched, searched by keyword.
- https://www.ssbwiki.com/Button_mashing : CPU mash cadence by level and game. Fetched.
- https://www.ssbwiki.com/Talk:Button_mashing : 2026 level 9 mash test. Fetched.
- https://www.ssbwiki.com/List_of_CPU_modes : training-mode CPU modes and internal names. Fetched.
- https://www.ssbwiki.com/Figure_Player : FP levels, damage scaling, spirits, personality table, tournament notes. Fetched.
- https://www.ssbwiki.com/Amiibo : FP learning summary. Fetched, searched by keyword.
- https://www.ssbwiki.com/Project_M , https://www.ssbwiki.com/Project%2B : PM and P+ AI notes. Fetched, searched by keyword.
- https://www.ssbwiki.com/User:Ultimate_Toad/List_of_flaws_in_artificial_intelligence_(PM) : PM CPU flaws (user page). Fetched.
- https://www.ssbwiki.com/Perfect_shield : CPU use of perfect shield. Fetched, one line read.

Amiibo community research:
- https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit : MiDe's amiibo bin overview (behaviour fields, experience thresholds, learning bit, personality note). Fetched as text export.
- https://gist.github.com/xSke/979dabd395c39eff36bcaccf87d66a3e : script with bit widths and the personality scoring procedure. Fetched.
- https://exionvault.com/2021/04/30/ssbu-amiibo-general/ : training guide, hidden level, values, learning tips. Fetched.
- https://exionvault.com/ssbu-amiibo-personality/ : 25 personalities, eight groups, value list. Fetched.
- https://exionvault.com/amiibo-wiki-editing/ : full behaviour value list. Fetched.
- https://exionvault.com/amiibo-wiki-feint-values/ : feint values. Fetched.
- https://exionvault.com/amiibo-wiki-learn-button/ : Learn toggle semantics. Fetched.
- https://exionvault.com/amiibo-wiki-level/ : level, learning weights, base AI. Fetched.
- https://exionvault.com/amiibo-wiki-hard-coded/ : hard-coded behaviours. Fetched.
- https://exionvault.com/amiibo-wiki-movement/ : walking versus running. Fetched.
- https://exionvault.com/amiibo-wiki-ssbu-metagame/ : metagame history, Amiibots mention. Fetched.
- https://github.com/fudgepop01/amiibox : early amiibo editor; its `regions.txt` gave an early field map later superseded. Fetched (README and regions file).
- https://github.com/jozz024/smash-amiibo-editor : current editor; page summary only. Via summary.
- https://www.amiibots.com/ : automated amiibo fighting site; script-rendered shell only. Snippet-level.
- https://goozamiibo.com/blog/training-smash-amiibo-figure-players/ : fetched and judged unreliable.
- https://www.reddit.com/r/SmashBrosUltimate/comments/1hdk89a/explanation_of_how_cpus_amiibos_work_in_smash/ : referenced by MiDe's document; blocked, not read.
- https://www.nintendo.com/en-gb/Support/Nintendo-Switch/Game-Updates/Super-Smash-Bros-Ultimate-Update-History-1549104.html : update history, 3.1.0 journeys. Via summary.

Ultimate data:
- https://github.com/ultimate-research/archive-hashes : cracked archive paths (`Hashes_FullPath` read raw). Fetched.
- https://github.com/ultimate-research/param-labels : `ParamLabels.csv` (93,034 lines) and README. Fetched.
- https://github.com/ultimate-research : organisation repository list. Via summary.
- https://github.com/benhall-7/paracobNET : `.prc` tooling README. Fetched.
- https://smashboards.com/threads/ai-handbook-2-0x-readable-syntax-stable.300461/ : Brawl AI Handbook; blocked, not read.

Other games:
- https://rivalslib.com/workshop_guide/programming/reference/scripts/ai_scripts : Rivals of Aether AI script hooks. Read from site page data.
- https://rivalslib.com/ : docs index, `get_training_cpu_action` reference. Read from page data.
- https://steamcommunity.com/sharedfiles/filedetails/changelog/2859046287 : workshop template changelog. Via summary.
- https://rivals2.com/workshop/knowledge-base/character-creation/set-up-character-ai-coming-soon/ : Rivals 2 CPU logic docs. Fetched via the site's JSON API.
- https://steamdb.info/patchnotes/16564997 : Rivals of Aether II patch of 27 November 2024. Via summary (two reads).
- https://steamcommunity.com/app/2217000/discussions/0/591768102733113796/ : Rivals 2 forum thread. Via summary.
- https://rivals-of-aether-ii-patch-150.nolt.io/912 : Rivals 2 CPU DI feedback item. Via summary.
- https://brawlhalla.com/news/new-cosmetic-items-and-advanced-ai-patch-4-04 : Brawlhalla patch 4.04. Fetched.
- https://slapcity.wiki.gg/wiki/Modes , https://slapcity.wiki.gg/wiki/Version_0.9 , https://slapcity.wiki.gg/wiki/Version_1.1 : Slap City CPU notes. Fetched (raw wikitext).
- https://github.com/Fraymakers/fraymakers-api-docs : Fraymakers AI enumerations and script classes (`AiBehavior`, `AiTechOption`, `AiDirectionalInfluenceOption`, `AiLedgeOption`, `AiShieldHitOption`, `AiCrashOption`, `AiHitstopNudgeOption`, `CharacterAiScript`, `CharacterAiActions`). Fetched (raw).
- https://steamdb.info/patchnotes/13691308 : Fraymakers early access v0.6.8. Via summary (two reads).

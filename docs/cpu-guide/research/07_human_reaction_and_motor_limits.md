# Human reaction time, decision time and motor precision for fighting-game CPU calibration

## Conventions

- One frame at 60 Hz is 16.667 ms. frames = ms x 0.06. Reference conversions: 100 ms = 6.0 f, 150 ms = 9.0 f, 166 ms = 10.0 f, 180 ms = 10.8 f, 200 ms = 12.0 f, 225 ms = 13.5 f, 250 ms = 15.0 f, 265 ms = 15.9 f, 300 ms = 18.0 f, 433 ms = 26.0 f, 559 ms = 33.5 f.
- Tags used below. `[S]` means the value comes from a source cited on the same line. `[C]` means a calibrated estimate made by this report to sit inside the sourced ranges; it was not measured. `unverified:` marks a claim I could not confirm from a page I read.
- "R" means frames from a state change existing in the sim to the frame on which the response input is applied by `stepGame`. Every tier value in the parameter section is an R value.
- Lab reaction tests already contain the test rig's own display and input lag. Woods et al. report a raw mean of 231 ms and a hardware-corrected mean of 213 ms in the same sample, so the rig contributed about 18 ms (1.1 f) (https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2015.00131/full). Do not add game lag on top of a lab figure without subtracting the rig's share.

## Simple reaction time to visual stimuli

Population figures:

- Kosinski's literature review, as reproduced by BioNumbers: about 140 to 160 ms for sound (8.4 to 9.6 f), 155 ms for touch (9.3 f), 180 to 200 ms for light (10.8 to 12.0 f). The review draws on Galton (1899), Woodworth and Schlosberg (1954) and Welford (1980). It attributes the auditory advantage to signal arrival at the brain in 8 to 10 ms for sound against 20 to 40 ms for light (https://bionumbers.hms.harvard.edu/bionumber.aspx?id=110800). Kosinski's own Clemson page could not be fetched (robots block), so the BioNumbers summary is the only view of it I had.
- Mental chronometry summary: about 190 ms visual and 160 ms auditory for college-age people. Olympic sprinters at Beijing averaged 166 ms (males) and 169 ms (females) to the start signal, the IAAF false-start rule treats anything under 100 ms as anticipation, and the best sprinters occasionally respond in 80 to 85 ms (https://en.wikipedia.org/wiki/Mental_chronometry). The sprint figures are responses to a sound and to a known, single cue, so they are a floor for prepared reactions, not a visual fighting-game number.
- Woods et al. 2015, visual simple reaction time, Experiment 1 with N = 1,469 aged 18 to 65: mean 231 ms raw (13.9 f), 213 ms hardware-corrected (12.8 f). Experiment 2 (N = 189, aged 18 to 82): 238 ms raw, 220 ms corrected. By age group: 217.9 ms at 18 to 24, 227.7 at 39 to 45 and 239.1 at 59 to 65 (13.1, 13.7 and 14.3 f). Slope with age 0.55 ms per year in Experiment 1 and 0.45 in Experiment 2 (0.03 f per year). No significant sex difference. Mean within-person SD 40 ms (2.4 f), between-person SD 27 ms (1.6 f), coefficient of variation 17.1%. Galton's Victorian sample sat at 181 to 189 ms, and the authors conclude speeds have not declined (https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2015.00131/full). The NCBI copy of the paper (PMC4374455) returned a captcha page, so the Frontiers copy is the one I read.
- Human Benchmark median: 225 ms (13.5 f), as cited by an SSBWorld article (https://ssbworld.com/blog/185/the-importance-or-lack-thereof-of-relative-reaction-time). The Human Benchmark statistics page itself renders in JavaScript and returned no text, so this is second-hand. The same article says some top players are said to sit near 180 to 190 ms (10.8 to 11.4 f), which is 2 to 3 frames under the median. That claim has no cited measurement behind it.
- Smash Ultimate players, browser-based PsyToolKit simple reaction test, 2025: elite players 225 +/- 24 ms (13.5 +/- 1.4 f, n = 20), casual Ultimate players 249 +/- 23 ms (14.9 +/- 1.4 f, n = 24), non-gamers 278 +/- 36 ms (16.7 +/- 2.2 f, n = 21). The SDs are presumably between-person (the abstract does not say). Elite players were faster than both other groups. The paper does not define "elite" and the trial count is not stated in the text I could read (https://digitalcommons.wku.edu/cgi/viewcontent.cgi?article=9254&context=ijesab, abstract page https://digitalcommons.wku.edu/ijesab/vol14/iss5/45). This is the closest sourced measurement to the population Aevalrena cares about, and because the test ran in a browser its numbers already include a browser's input and display pipeline.
- Expertise evidence is mixed. An esports Stroop study found elite gamers better than intermediate and low-ranked gamers on simple choice reaction time, with no milliseconds in the abstract (https://www.frontiersin.org/articles/10.3389/fpsyg.2019.02852/text). A Vienna Test System study of 18 professional esports players, 21 non-professionals and 36 sportsmen found no significant group difference on simple visual, acoustic and choice reaction time (https://irma-international.org/article/comparison-of-reaction-time-between-esports-players-of-different-genres-and-sportsmen/274054/). unverified: action video game players are often reported about 10% faster with no accuracy loss (Dye, Green and Bavelier 2009); the PubMed page was captcha-blocked and I only saw the title (https://pubmed.ncbi.nlm.nih.gov/20485453/).

Effects to model:

- Age: negligible inside a player population (about 22 ms across 40 years) [S]. Do not model age in CPU levels.
- Practice: it moves simple reaction time by a few frames at most; it moves choice reaction time far more, through a shallower Hick slope (see next section). The gap between the WKU non-gamers (278 ms) and elite players (225 ms) is 53 ms, 3.2 f [S, computed]; nothing in the sources supports a larger gap in the simple case.
- Alerting: a constant foreperiod of about 300 ms gives the fastest responses, and foreperiods shorter than 300 ms can slow them (https://en.wikipedia.org/wiki/Mental_chronometry). In a match this maps to a warning state: opponent in range and actionable is a warning, a distant opponent is not. Suggested effect: up to 1 f faster inside threat range [C].
- Distribution shape: unverified: simple reaction time distributions are right-skewed (slow tail, hard floor), which is why an ex-Gaussian is the usual fit. The Woods summary I read reported only means and SDs. Model with a hard floor and a slow tail.

## Choice reaction time, Hick's law, go/no-go and discrimination

- Hick's law: T = a + b log2(n + 1) for n equally likely choices, and T = a + b H for unequal probabilities where H is entropy in bits. Hick (1952) used 10 lamps with Morse keys, Hyman (1953) used 8 lights that had to be named (https://en.wikipedia.org/wiki/Hick%27s_law). Exceptions: verbal responses to familiar stimuli barely slow down, saccades show no slope, and lists searched in random order slow linearly (same page).
- Slope: lecture notes summarising the literature give about 150 ms per doubling of alternatives, a 2-choice minimum near 250 ms and a typical 2-choice mean of 350 to 450 ms (21 to 27 f). They also state that the effect of N shrinks with practice and disappears after roughly a million trials, and that high stimulus-response compatibility makes 2 versus 10 alternatives nearly equal (https://faculty.ksu.edu.sa/sites/default/files/2%20Chapter%203%20Information%20Processing%20-%20Part%203%20-%20Hick%20Hyman%20Law%20%28AMS%20Feb01_25%29.pdf). That is a lecture handout, not a primary study, so treat 150 ms per bit as the upper bound for unpracticed arbitrary mappings.
- Cautions: the law assumes a linear relation in bits, needs at least three conditions with a wide entropy spread, is sensitive to speed-accuracy trade-off, and does not separate perceptual, decision and motor stages (https://metricgate.com/docs/hick-hyman-law-rt-entropy/).
- Converted at 60 fps, the extra time for n equally likely options is b x log2(n):

| Options n | Extra frames, b = 150 ms (9.0 f per bit) | Extra frames, b = 50 ms (3.0 f per bit) |
|---|---|---|
| 2 | 9.0 | 3.0 |
| 3 | 14.3 | 4.8 |
| 4 | 18.0 | 6.0 |
| 6 | 23.3 | 7.8 |
| 8 | 27.0 | 9.0 |

  The 50 ms column is `[C]`, a stand-in for a practiced, highly compatible mapping (see a fighter seeing a shield-worthy move and pressing shield). Frames computed by this report.
- Discrimination and go/no-go: Donders found simple reaction time shorter than recognition (discrimination) reaction time, and choice reaction time longer than both; the page gives no millisecond gaps (https://en.wikipedia.org/wiki/Mental_chronometry). In the Ultimate study, missed no-go trials did not differ between elite, casual and control groups (https://digitalcommons.wku.edu/cgi/viewcontent.cgi?article=9254&context=ijesab). unverified: typical added cost of go/no-go is 20 to 60 ms (1 to 4 f) and of discriminating between similar-looking stimuli is comparable; treat this as the source of the "surprise" term below.
- Fighting games are a discrimination-plus-choice task: telling one opponent move from another, then mapping it to a response. Two options that look the same for their first N frames cannot be told apart in those frames. SmashWiki notes that some Melee tech animations (Sheik's) are functionally identical until a point where it is too late to react (https://www.ssbwiki.com/Tech-chasing).

## Anticipation versus reaction

- A competitive-game writer at Critpoints puts human reaction at about 15 f for a stimulus you expect with a response already planned, with elite players at 10 to 13 f, and says each extra variable (more options, an unexpected stimulus) adds latency. The same article says players typically form a new action plan every 20 to 26 frames (about half a second) and separates tempo reads (when the opponent acts) from option reads (what they do) (https://critpoints.net/2017/06/26/how-to-read-a-book-reads-in-competitive-games/). This is an essay, not a measurement.
- SSBWorld argues that reaction time inside the normal range barely matters: a 180 ms player gains 2 to 3 frames over a 225 ms player, what looks like a godlike reaction is a prediction whose cue arrived earlier, and the real separator is conditioning to familiar situations (https://ssbworld.com/blog/185/the-importance-or-lack-thereof-of-relative-reaction-time).
- A Smashboards answer (forum, single voice) says players think they react in 12 to 15 f while real multi-option reactions take 30 to 40 f once nerves, adrenaline, input lag and display lag are counted, and that top-level players fail to react to threats telegraphed 1 to 2 seconds ahead (https://smashboards.com/threads/how-much-of-melee-is-reactions-and-how-much-is-reads-mixups.453608/post-22004372).
- A game-industry note on a reaction mini-game with a 26-frame startup (433 ms) argues that pros do not have faster reflexes so much as pattern knowledge that removes most options before the attack starts (https://dashfight.com/news/new-reaction-game-tests-if-26-frames-is-too-fast-for-you-8740). Low-grade source; it agrees with the two above.
- Killer Instinct's reaction page says the same thing about its own game: 16 frames is a theoretical number and in practice tells, multiple threats and input complexity make it harder (https://ki.infil.net/reaction.html).

Aevalrena: keep two separate mechanisms. A reaction gate applies to stimuli the CPU had no reason to expect. An anticipation path uses the opponent-habit predictor (already present at level 10) and may act before the cue, with no reaction latency, but it can be wrong and the sim will punish a wrong read. A tier that reads well should not also be granted a reaction time under the human floor.

## Fighting-game reactable thresholds

Killer Instinct (ki.infil.net):

- The page bases its threshold on 265 ms as the average time to press a button in response to exactly one easily identified stimulus, converted to about 16 frames at 60 fps (https://ki.infil.net/reaction.html).
- It ranks response types: changing block stance with the stick is fastest, pressing a single button is a little slower because the finger moves, and special-move inputs are slowest because they need a motion plus a button.
- Worked cases on the page: a 15-frame startup (Sabrewulf's jumping slash) is treated as virtually unreactable, moves with 16 or more startup frames can be reacted to fairly consistently when the player is waiting for that one stimulus, a 19-frame overhead is reactable but close to the limit, a 27-frame move is well past it, and most jumps at 45 frames are easy.
- Combo-breaker thresholds on the page: manuals at 5 to 9 frames are prediction only, light auto-doubles near 20 frames need a strong read, medium auto-doubles at 30 to 35 frames are possible with practice, heavy ones near 40 frames are usually broken.
- The brief's "13 to 16 frame floor" is a range of central estimates: 16 f is the KI page (265 ms), 13.5 f is the Human Benchmark median and the WKU elite mean (225 ms). Neither is a hard floor. Best individuals sit near 10 to 11 f in simple prepared tasks (sprinters 166 ms, claimed top players 180 to 190 ms).

Smash tech chases and getups (community consensus):

- A Smashboards tech-chase guide says players need about 15 f to react to the stimuli that matter. Its timeline: frames 3 to 16 are positioning time, frame 17 is the last frame to cover a missed tech with a jab, frame 18 is the deadline to grab a tech in place, and frames 19, 20 and 21 are successive deadlines for stomp, back stomp and knee or smash coverage of tech rolls (https://SMASHBoards.com/threads/tech-chasing-like-a-man-complete-breakdown.382475/).
- A Samus thread states average reaction as 250 ms or 15 f and derives that punishing a 40-frame tech roll needs an option that hits within about 25 f of the tech, and that covering a getup roll needs options faster than 20 f, with a grab at frame 18 and wavedash into jab at 17 f cited as workable (https://smashboards.com/threads/tech-chasing-with-samus.402829/post-19203933).
- Another Smashboards poster says tech chase consistency can reach 100% with practice even for a slow-reacting player, by reacting to the tech option rather than to DI (https://smashboards.com/threads/tech-chasing-fast-fallers-on-reaction.343054/latest).
- SmashWiki says tech chasing is weaker in Smash 4 and Ultimate because tech rolls are shorter and leave less time to react (https://www.ssbwiki.com/Tech-chasing).
- The 18 to 21 frame numbers are what you get from 15 f of human reaction plus 3 to 6 f of game and display lag (next section). That sum is specific to Ultimate on Switch and is 3 to 4 frames longer than the same human would need in a 60 Hz browser game.

FightingICE:

- The FightingICE platform gives bots a view of the game that is 15 frames old, to simulate human reaction delay, and bots compensate by running the forward model from the delayed state up to the present; the search must finish within 16.67 ms (https://arxiv.org/pdf/2003.13949).

## Input lag and display latency

- SmashWiki lists average input lag as 2 frames for Smash 64 and Melee, 4 for Brawl, 3 for Smash 4 on Wii U and 5 for Ultimate, and says roughly one more frame of display lag should be added for total lag. The page cites no measurement (https://ssbwiki.com/Input_lag).
- SmashWiki's frame delay page says Ultimate has roughly 6 frames between button press and the game's action offline, Smash 4 has 7, and online matches add at least 4 more frames in Ultimate, for a minimum of 10 (https://www.ssbwiki.com/Frame_delay).
- EventHubs, reporting GigaBoots' Button2Pixel video measurements, gives Ultimate at 5.9 frames (98 ms), Brawl near 4.9 and Melee at 3.5, excluding the display, with GameCube controllers plugged into the console or a USB 3.0 hub as the fastest setup. Street Fighter V Arcade Edition (4.4) and BlazBlue Cross Tag Battle (2.5) are given for comparison (https://www.eventhubs.com/news/2018/dec/11/super-smash-bros-ultimate-reportedly-features-highest-input-lag-series). The measured figures run about 1 frame above SmashWiki's, so the range for Ultimate is 5 to 6 f before the display, 6 to 7 f with it. A GameRevolution piece repeats 6 f for Ultimate and 3 f for Melee with no method given (https://www.gamerevolution.com/?p=470465).
- Stack for a human in Ultimate on a Switch: lab-style reaction of 13.5 to 15 f (WKU elite to casual), plus about 6 f of game lag, plus 1 f of display, minus about 1 f already inside the lab number, gives about 19 to 21 f between the opponent's first visible frame and the human's input taking effect. That sits on top of the 18 to 21 frame deadlines the tech-chase threads use. This is a computation by this report from the sources above.

Aevalrena: the human in a 60 Hz browser has a different stack, and the game has no built-in input delay. Keyboard events are latched between frames and consumed by the next step, and the gamepad is polled once per animation frame because the Gamepad API has no button events (https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API). The fixed-step loop in `src/core/loop.ts` accumulates real time and steps at 60 Hz, so a press waits 0 to 1 frame (mean 0.5) to enter the sim, and the render-to-display path adds an estimated 1 to 2 frames before a human sees the result `[C]`. Because the WKU test also ran in a browser, use its numbers as R directly and do not add Ultimate's 5 to 6 frames. unverified: whether `render(alpha)` draws an interpolated state that lags the sim by up to a frame; check `src/render` before fixing the human-side number. Humans in Aevalrena are therefore about 3 to 4 f faster in sim terms than the same humans in Ultimate, so reactability thresholds taken from Ultimate discussion should be shortened by that amount.

## Motor precision

Windows and what is known:

- A 60 fps frame is 16.7 ms. Critpoints calls a 1-frame window the hardest single input in a 60 fps game, says 2 frames allows enough leniency for people to get consistent, and notes the Melee L-cancel window is 7 frames and the tech roll window 20 (https://critpoints.net/2016/08/19/frame-trainer-tool-how-long-are-frames/).
- L-cancel: press L, R or Z up to 7 frames before landing in Melee (11 in Smash 64); it is absent in Ultimate (https://www.ssbwiki.com/L-cancel). The brief cited a 3-frame L-cancel window; the SmashWiki page says 7. Any "3-frame" figure belongs to other techniques.
- Success data is thin. A Smashboards thread reports about 70% L-cancel after three months of practice, with another poster calling 85% a minimum for a good player, and the same thread notes shield drops at 60% in training mode failing in matches (https://smashboards.com/threads/after-3-months-of-training.434576). Two forum voices; useful only as anchors for the casual and intermediate tiers. unverified: measured Slippi L-cancel percentages for top players; the Slippi analysis tools list L-cancel rate and tech success rate but I could not retrieve values (https://deepwiki.com/pcrain/slippc).
- Frame-tight examples: a maximum-intangibility Melee ledgedash needs the ledge release on frame 9, the earliest possible, then an immediate jump and airdodge, and an airdodge that is too early or too late fails; looser ledgedashes trade fewer intangibility frames for more timing slack (https://www.ssbwiki.com/Ledgedash). Wavedash by tap jump is far more misinput-prone than by button (https://www.ssbwiki.com/Wavedash).
- Rhythm-game reference: osu defines its unstable rate as the standard deviation of hit errors in tenths of a millisecond (https://osu.ppy.sh/wiki/en/Gameplay/Accuracy), and the game's top hit window is 80 minus 6 x OD ms each side, which is 20 ms at OD 10, a 40 ms (2.4 f) total width (https://osu.ppy.sh/wiki/en/Beatmap/Overall_difficulty). I did not find published typical unstable-rate values for top players, so no jitter SD is taken from osu.
- I found no measurement of 1-, 2- or 3-frame success rates for skilled fighting-game players, and no source for how those rates change under pressure or fatigue. Everything below on jitter, lapses and stress is a calibrated model.

Timing model `[C]`:

- Input timing error is Gaussian around the intended frame with SD sigma_j frames. Quantising to 60 Hz adds 1/12 frame squared, so sigma_eff = sqrt(sigma_j^2 + 1/12).
- For a symmetric window of w frames aimed at its centre: P(hit) = (1 - lapse) x erf( w / (2 x sqrt(2) x sigma_eff) ), and P(drop) = 1 - P(hit). The lapse term is an attention or execution slip that produces no usable input at all.
- If the input is triggered by a reaction, the reaction SD (1.7 to 3.0 f by tier) dominates sigma_j. A reaction-triggered 3-frame punish for the world's-best tier (R SD 1.7 f, sigma_eff 1.72 f) hits roughly erf(1.5 / (1.414 x 1.72)) = 62% before anything else goes wrong; a 2-frame window gives 44%. Humans hit 1- to 3-frame punish windows by anticipating from a known duration, not by reacting. Model these two cases with different noise.
- Timing off a long interval, such as waiting out a 30-frame ledge climb, is noisier than short sequences because interval-timing error grows in proportion to the interval. Suggested noise: sigma_int = sqrt(sigma_j^2 + (k_W x interval)^2), with k_W from 0.10 (casual) to 0.04 (world's best). unverified: the scalar (Weber) property of interval timing is well established, but I did not read a page that gave a value, so k_W is `[C]`.
- Input dropping in practice is mostly mistimed or missing presses at tight windows, plus wrong-input errors under stress; SmashWiki singles out tap jump as more misinput-prone (link above). No rates found.
- Fitts' law, MT = a + b log2(A/W + 1) (Shannon form), was fitted for pointing: one mouse study reports MT = 230 + 166 x ID ms, about 6 bits per second (https://sites.cc.gatech.edu/classes/AY2010/cs6750_fall/readings/mackenzie.pdf, https://en.wikipedia.org/wiki/Fitts%27s_law). It has little value for fighting-game sticks, which mostly select among gate positions or keys. Aevalrena's keyboard input is digital, and the gamepad path only applies thresholds (`walkAxis` 0.7, `padDeadzone` 0.35 in `src/core/constants.ts`). KI's ordering (stance change faster than button, button faster than motion input) is the useful practical ladder. Suggested cost `[C]`: 0 f for a direction change, 1 to 2 f for a direction-then-button chain, more for chords.

Computed drop rates by tier (sigma_j and lapse are the `[C]` inputs; percentages are computed from the formula above):

| Tier | sigma_j (f) | lapse | 1-frame drop | 2-frame drop | 3-frame drop | 5-frame drop | 7-frame drop | 12-frame drop |
|---|---|---|---|---|---|---|---|---|
| casual | 3.0 | 4.0% | 87.4% | 75.0% | 63.4% | 43.1% | 27.6% | 8.5% |
| intermediate | 1.8 | 2.0% | 78.8% | 59.2% | 42.2% | 18.7% | 7.4% | 2.1% |
| advanced | 1.1 | 1.0% | 66.4% | 38.5% | 19.5% | 3.8% | 1.2% | 1.0% |
| top player | 0.7 | 0.5% | 51.1% | 19.1% | 5.2% | 0.6% | 0.5% | 0.5% |
| world's best | 0.4 | 0.2% | 31.2% | 4.5% | 0.4% | 0.2% | 0.2% | 0.2% |
| beyond human | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Cross-checks: the casual 7-frame row (about 72% L-cancel) and the intermediate row (about 93%) bracket the two forum anchors (70% at three months, 85% as a good-player minimum). The top-player 3-frame success of 94.8% matches the brief's "about 90% or better at 3 frames" for skilled Melee players, which I could not source independently.

## Pro benchmarks

Input rates:

- Melee, hand-counted from 18 matches in an old Smashboards thread (author estimates 80 to 90% counting accuracy; each action counted once across jumps, movement, aerials, L-cancels, grabs, specials, shield and dodge, DI, techs): overall mean 220 APM. By character: Fox 273, Falco 259, Peach 242, Samus 214, Jigglypuff 206, Falcon 200, Sheik 193, Marth 160. Individual entries: 305 and 301 APM for the two fastest Fox players, Mew2King 139 to 178 on Marth, Mango 187 to 225 on Jigglypuff (https://smashboards.com/threads/apm-of-smashers-july-update-the-fastest-peach.234508/). That is 2.3 to 5.1 counted actions per second, one per 12 to 26 frames.
- Slippi shows an Inputs per Minute stat in post-set stats and the desktop app, discussed in a thread by a Slippi developer, but I could only see the thread title and no values (https://twitter.com/Fizzi36/status/1318294504885997569). unverified: any specific Slippi IPM figure for a top Melee player. unverified: any measured APM or IPM for Smash Ultimate; I found none. Ultimate needs fewer sustained tech inputs than Melee, so its counted rate is probably at or under the Melee range, but that is my inference.
- StarCraft professionals in South Korea average about 250 to 350 APM and often exceed 400 in fights; the 818 APM record was measured over a short burst and probably included key-holding, and eAPM (with repeats removed) has no standard definition (https://en.wikipedia.org/wiki/Actions_per_minute). One RTS player describes 300 APM of which much is redundant clicking (https://www.nbcnews.com/technolog/howfast-fast-some-pro-gamers-make-10-moves-second-8C11422946).
- AlphaStar's monitoring layer limited agents to 22 non-duplicated actions per 5 seconds (4.4 per second, 264 APM) and reports about 110 ms between observing a frame and executing an action, which is 6.6 f (https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf; the delay figure comes from a summary of that PDF and the Nature extended-data figures were not readable to me). A forum reprint of a DeepMind AMA lists different, looser caps: 600 APM over 5 s, 400 over 15 s, 320 over 30 s, 300 over 60 s (https://www.greaterwrong.com/posts/f3iXyQurcpwJfZTE9/alphastar-mastering-the-real-time-strategy-game-starcraft-ii/comment/Nc8eSoQ6rGXyX6Ktu). The sources disagree; the PDF value is the final-agent cap as I read it, and the AMA numbers may describe an earlier version. A LessWrong discussion says the earlier match bursts reached over 1,000 APM for 5-second stretches (https://www.lesswrong.com/posts/du8qqfgQz3ovBm26A/link-did-alphastar-just-click-faster).

Reaction speed of bots and how much delay they tolerate:

- Firoiu et al.'s Melee agent reacted in 2 frames (33 ms) against humans at over 200 ms, beat professionals with Captain Falcon, and the authors note its character's attacks need about 250 ms to come out. Training with 2 to 4 frames of action delay still produced fairly strong agents, and 6 to 10 frames dropped performance sharply, which the authors attribute to credit assignment across the longer gap, not to human-level delay being too handicapping in itself (https://ar5iv.arxiv.org/html/1702.06230). MIT's press release quotes about 33 ms against a human range over 200 ms with no handicap applied, and the researchers said they were considering restricting reaction speed (https://www.csail.mit.edu/news/ai-beats-pros-super-smash-bros, https://techxplore.com/news/2017-02-terribly-terrific-ai-brawl-players.html).
- SmashBot's documentation states it only presses buttons on a virtual controller and is faster and more reliable than a human; it gives no frame counts (https://github.com/altf4/SmashBot/blob/master/Readme.md).
- OpenAI Five: the paper reports an average reaction time of 217 ms against a typical human visual reaction of about 250 ms, and picks an action every fourth frame at 30 fps (about 133 ms) (https://arxiv.org/pdf/1912.06680). The brief's 200 ms figure is close; the number in the paper as summarised to me is 217 ms.
- DeepMind's Quake III capture-the-flag agents responded to newly appeared opponents in 258 ms against 559 ms for humans, tagged with 80% accuracy against 48%, and still beat humans after accuracy was degraded to the human level (https://ar5iv.arxiv.org/html/1807.01281).
- A 2026 arXiv paper on frame-skip learning in fighting games notes that acting every frame grants frame-perfect reflexes that are unrealistic next to human players (https://arxiv.org/pdf/2605.20911).

Consistency of top players at frame-tight techs: no published measurement was found. The only sourced statements are qualitative: 1 frame is hardest, 2 frames is feasible with consistency, and tight techs like a maximum ledgedash require exact frames. Percentages in the tier table are estimates.

## Attention and the mental stack

- Hick's law applies inside the mind of a defender: each additional option the player is tracking adds b per bit (table above), and conditioning reduces b and the effective number of options (KSU notes above).
- Psychological refractory period: while one stimulus is being processed, the response to a second is slowed. In the standard example a second stimulus 150 ms after the first is answered more slowly than one at 1,000 ms, and practice shortens but does not remove the effect (https://en.wikipedia.org/wiki/Psychological_refractory_period). In frames: two cues within about 9 f of each other cannot both be answered at full speed.
- Attentional blink: a second visual target appearing 200 to 500 ms (12 to 30 f) after a first is often missed in rapid sequences, and items in immediate succession are usually both seen (https://en.wikipedia.org/wiki/Attentional_blink). unverified: how much this transfers to fighting-game scenes.
- How humans compensate: conditioning to familiar situations (SSBWorld), tempo and option reads, replanning about every 20 to 26 f (Critpoints), and choosing safe options that cover several opponent replies at once. Forum consensus is that top-level Melee is mostly prediction and knowledge (Smashboards link above).
- I found no page for a "mental stack" concept from SmashWiki (the URL returned 404). Use the terms above.

Aevalrena: model attention as a budget with three rules. First, an options cap (below): the CPU evaluates at most that many distinct opponent replies at once and covers the highest-probability ones. Second, a refractory rule `[C]`: if a reaction-based response was issued Delta frames ago and Delta < 9, a new reaction-based decision has its R increased by (9 - Delta) x k_prp frames, with k_prp = 0.5 for all tiers below world's best, 0.3 for world's best and 0 for beyond human. Third, the anticipation path does not pay these costs, which is exactly why a well-conditioned player looks faster than the reaction data allows.

## Parameter tables for CPU levels

### Model

For each opponent event e that the CPU wants to answer reactively, sample once when the event first exists in the sim, then cache by an event key so it is not re-rolled every frame (re-rolling each frame collapses to the minimum of the distribution):

1. H = entropy in bits of the CPU's predicted distribution over the opponent options at that decision, computed over at most `optionsCap` options (renormalised). This reuses the n-gram or habit predictor: better prediction means lower entropy and a faster reaction, which is Hick's law used as intended.
2. armed = min(1, p_cue / 0.6), where p_cue is the predicted probability that this cue is coming. S_eff = S x (1 - armed).
3. R_mean = R_base + S_eff + b x H + stress term + refractory term - alert bonus.
4. R = max(floor, round(R_mean + SD x z)), with z drawn as z = 0.7 x (Exp(1) - 1) + 0.7 x N(0,1) so it has unit variance and a slow tail.
5. The response is issued on the first frame where (frame - e.startFrame) >= R.

Determinism: draw the two random numbers from a hash of (matchSeed, fighterSlot, e.startFrame, e.kind), not from a shared RNG stream. Then a rollback that replays the frame draws the same reaction and both peers agree.

### Table 1: reaction parameters (all `[C]` unless the anchor is cited)

| Tier | P: snapshot age (f) | D: response delay mean (f) | R_base mean (f, ms) | R SD (f) | Floor (f) | Surprise S (f) | Hick b (f per bit) | Anchor |
|---|---|---|---|---|---|---|---|---|
| casual | 5 | 11 | 16 (267) | 3.0 | 10 | 6 | 8.0 | non-gamer 278 ms and casual 249 ms in WKU `[S]` |
| intermediate | 5 | 10 | 15 (250) | 2.5 | 10 | 4 | 6.0 | casual 249 ms `[S]`, KI 265 ms `[S]` |
| advanced | 4 | 10 | 14 (233) | 2.2 | 10 | 3 | 4.5 | between casual and elite `[S]` |
| top player | 4 | 9 | 13 (217) | 2.0 | 10 | 2 | 3.5 | WKU elite 225 ms `[S]` |
| world's best | 4 | 8 | 12 (200) | 1.7 | 10 | 1 | 2.5 | claimed 180 to 190 ms `unverified`, sprinters 166 ms `[S]` |
| beyond human | 1 to 4 (default 4) | 0 | equals P | 0 | equals P | 0 | 0 | Phillip 2 frames `[S]`, current level 10 uses 4 |

- P is the age of the snapshot the CPU plans on; D is the extra sampled delay before an input can follow a visible change. R_base = P + D. If a level does not plan on a snapshot (the rule-table levels), use R_base directly and ignore the split.
- Floor 10 f (167 ms) is the sprinter-level limit for prepared responses; no human tier goes under it. The world's-best row sits at the human floor as requested: mean 12 f, floor 10 f.
- The SD column: the within-person SD in Woods et al. is 2.4 f at a 13.9 f mean (CV 17%) `[S]`. Tier SDs are 3.0 to 1.7 `[C]`, staying near 14 to 18% of the base for the mid tiers and widening for casual.
- Resulting R means for common cases, computed from the formula with S fully applied:

| Tier | Expected single cue (H = 0) | 1 bit, not armed | 2 bits, not armed | 3 bits, not armed |
|---|---|---|---|---|
| casual | 16 | 30 (500 ms) | 38 | 46 |
| intermediate | 15 | 25 (417 ms) | 31 | 37 |
| advanced | 14 | 21.5 (358 ms) | 26 | 30.5 |
| top player | 13 | 18.5 (308 ms) | 22 | 25.5 |
| world's best | 12 | 15.5 (258 ms) | 18 | 20.5 |

  The casual and intermediate 2-bit cells (38 and 31 f) fall inside the 30 to 40 f range a forum poster gives for real multi-option reactions. The world's-best 1-bit cell (15.5 f) matches KI's 265 ms (16 f).

### Table 2: execution parameters

Timing jitter and lapse are the inputs; the drop percentages by window width are in the Motor precision section above. Use the same sigma_j for every self-timed input (chains the CPU starts itself), the sigma_int form for inputs timed off an opponent's known-length action, and the reaction SD (not sigma_j) for reaction-triggered inputs.

| Tier | sigma_j (f) | Lapse rate | k_W (interval timing) | Closed form |
|---|---|---|---|---|
| casual | 3.0 | 0.040 | 0.10 | |
| intermediate | 1.8 | 0.020 | 0.08 | sigma_j = 3.0 x 0.6^t |
| advanced | 1.1 | 0.010 | 0.06 | lapse = 0.04 x 0.5^t |
| top player | 0.7 | 0.005 | 0.05 | t = 0 for casual to 4 for world's best |
| world's best | 0.4 | 0.002 | 0.04 | |
| beyond human | 0 | 0 | 0 | |

The closed forms give 3.0, 1.8, 1.08, 0.65, 0.39 and 0.040, 0.020, 0.010, 0.005, 0.0025, which round to the table.

Implement jitter as a real timing offset of the emitted input, round(N(0, sigma_j)) frames early or late, and a lapse as a skipped input, so that success or failure comes out of the sim's actual windows instead of a hidden coin flip. Do not jitter inputs whose sim window is 12 frames or wider (tech press, roll retap, dash retap) for tiers advanced and up; the table shows the drop is under 1.5%.

### Table 3: decision and rate parameters

| Tier | Decision error rate | Options cap | Plan-hold (f between replans) | Sustained input events per second | 
|---|---|---|---|---|
| casual | 0.30 | 2 | 24 | 2.5 |
| intermediate | 0.17 | 3 | 20 | 3.0 |
| advanced | 0.09 | 4 | 16 | 3.5 |
| top player | 0.05 | 5 | 13 | 4.5 |
| world's best | 0.025 | 6 | 10 | 5.5 |
| beyond human | 0 | unlimited (all candidates) | 1 | no cap |

- Decision error rate: when a choice among responses is triggered, with this probability the CPU takes a response ranked below the best one it can see (draw from ranks 2 to 3, weighted by score). It is separate from mixups, which are deliberate randomisation for unpredictability and should be shown as a mixup rate, not as errors. Never draw an error from a veto set of moves no human would choose, such as self-destructing off stage, following the humanizing rule already in `docs/CPU_AEVALMERE.md`. `[C]`.
- Options cap: the number of distinct opponent options included in a response choice. Aevalrena's live option sets are tech (in place, roll left, roll right, no tech: 4), knockdown (getup, getup attack, getup roll left and right: 4) and ledge (climb, jump, attack, roll, drop: 5). Cap 2 means a casual CPU covers only its two likeliest replies. `[C]`.
- Plan-hold: frames a stale plan is held before replanning. Anchors: replanning every 20 to 26 f for typical players (Critpoints) and a counted action every 12 to 26 f in Melee (Smashboards APM). `[C]`.
- Sustained input events per second: count of button press edges plus discrete direction changes, as a rolling 1-second cap. Anchors: hand-counted Melee 2.3 to 5.1 actions per second, AlphaStar's cap of 4.4 per second as a deliberately human-scale limit. Short bursts up to about twice the cap are allowed. Optional parameter. `[C]`.

### Modifiers

| Modifier | Effect | Tiers | Status |
|---|---|---|---|
| Stress s in 0 to 1 (last stock, trailing by a stock or more, high own percent) | sigma_j x (1 + 0.35 s), lapse x (1 + s), R + 2 s frames, error rate x (1 + 0.5 s) | full for casual to top; half for world's best; none for beyond human | `[C]`, no measured values found |
| Alert (opponent in threat range and actionable) | R - 1 frame | casual to world's best | `[C]`, direction from the foreperiod finding |
| Refractory (second reaction within 9 f of the first) | R + (9 - Delta) x k_prp | see attention section | `[C]`, direction from psychological refractory period |

### Which numbers are sourced

- Sourced: population and expert simple reaction times (Woods, WKU, Kosinski via BioNumbers, sprinters), age slope, within- and between-person SD, Hick's law form and the 150 ms per bit upper bound, the effect of practice on slope in direction, the L-cancel window (7 f), input lag (SmashWiki, EventHubs measurements), APM ranges, AlphaStar's 22 per 5 s cap, bot reaction times (33 ms, 217 ms, 258 ms), FightingICE's 15 f delay, refractory and blink durations, and community reaction thresholds.
- Calibrated `[C]`: every entry in Tables 1 to 3 except where an anchor is cited beside it, the Gaussian timing model and its lapse terms, the surprise and armed terms, the Weber fractions, the stress, alert and refractory modifiers, and the practiced-slope figure of 50 ms per bit.

### Fit against the current level table

The rule-table levels in `src/ai/index.ts` use `reactMs` values of 250, 250, 200, 155, 120, 95, 75, 55, 35 and 17 ms for levels 0 to 9, and `reactFrames` rounds ms x 0.06 to 15, 15, 12, 9, 7, 6, 5, 3, 2 and 1 frames. Levels 3 to 9 (9 frames and below) are under the 10-frame human floor, and level 9 reacts in 1 frame and decides every frame (`period: 1`), which is beyond human by this report's standard. Level 1 (15 f) and level 2 (12 f) fall inside the human range. To make every non-god level humanlike, the reaction values should be replaced by the tier rows above.

Aevalrena: suggested mapping for the four archetypes with five levels each: level 1 casual, 2 intermediate, 3 advanced, 4 top player, 5 world's best, and balanced level 5 replaced by the beyond-human row (P = 4, D = 0). Archetype traits (aggressive, defensive, countering, balanced) should change decision weights, not the reaction floor or the timing parameters, so that a level's fairness stays comparable across archetypes. Whether "the tier just below god" is level 4 or level 5 in the non-balanced archetypes is a design call for the guide author.

### Reactive punish feasibility in Aevalrena (derived, not sourced)

A punish triggered by reaction to an opponent option needs the hit to become active inside the option's vulnerable frames. With the option's cue visible on frame c = 2, latency L (from the tables above) and the punishing move's first active frame S frames after the input, the hit lands on frame c + L + S. The maximum usable startup is S_max = (last vulnerable frame) - c - L, and any move with startup at most S_max works if its input is timed to the window (a wait). Vulnerable windows come from the game facts in the brief (spot dodge 22 f invulnerable 3 to 17, roll 24 f invulnerable 3 to 16, air dodge 34 f invulnerable 2 to 31, ledge climb 30 f invulnerable 28, tech in place 26 f invulnerable to 20, tech roll 40 f invulnerable to 20, getup 30 f invulnerable 22, getup roll 35 f invulnerable 25). The values below use L for a 1-bit unarmed cue (30, 25, 21.5, 18.5 and 15.5 f for the five tiers). A value of 0 or below means the window has closed before the tier can act.

| Option | Vulnerable frames (width) | casual | intermediate | advanced | top | world's best |
|---|---|---|---|---|---|---|
| spot dodge | 18 to 22 (5) | below 0 | below 0 | below 0 | 1 | 4 |
| roll | 17 to 24 (8) | below 0 | below 0 | 0 | 3 | 6 |
| air dodge | 32 to 34 (3) | 2 | 7 | 10 | 13 | 16 |
| ledge climb | 29 to 30 (2) | below 0 | 3 | 6 | 9 | 12 |
| tech in place | 21 to 26 (6) | below 0 | below 0 | 2 | 5 | 8 |
| tech roll | 21 to 40 (20) | 8 | 13 | 16 | 19 | 22 |
| getup | 23 to 30 (8) | below 0 | 3 | 6 | 9 | 12 |
| getup roll | 26 to 35 (10) | 3 | 8 | 11 | 14 | 17 |

Reading the table: a 4-frame jab (`JAB_STARTUP` in `src/ai/index.ts`) reaches a spot dodge tail only for the world's-best tier, at the last frame. Tail windows of 2 to 3 frames (ledge climb, air dodge) are usable by nearly all tiers in startup terms, but the timing window is narrow: the hit probability is then set by the reaction SD: for the world's-best tier about 62% for a 3-frame window and 44% for the 2-frame ledge tail, and for casual 38% and 26%. That is the sim-level reason a 2-frame punish is a known hard skill and should look rare for human tiers. Frame counts treat tier means; the sampled R moves each result by roughly plus or minus 2 f.

Defence gate: to answer an incoming attack on reaction, the attack's remaining startup at the time of the cue must be at least R + (frames from input to protection). The protection lag is 3 f for spot dodge and roll, 2 f for air dodge (the invulnerability start frames in the brief). With an expected single cue, a world's-best CPU can spot dodge an attack with about 15 f of remaining startup, top player 16, advanced 17, intermediate 18 and casual 19 (R_base + 3). With a 1-bit unarmed cue those become about 19, 22, 25, 28 and 33 f. This replaces the current `framesToActive(opp) >= reactFrames(prof)` test, which ignores the response's own lag.

### Where jitter applies in Aevalrena

- Tight sim windows the CPU can miss: short hop (jump released within the 3-frame jumpsquat: a 3-frame window), smash from a stick flick (`smashTapWindow` 5 f), the action buffer (6 f), roll retap (12 f), dash retap (14 f), and the tails listed above.
- Windows that are lenient by design: the tech press window is 20 f before landing with a 40 f lockout (`TECH` in `src/core/constants.ts`), so tech failures should be decision errors, not timing errors.
- Timing-critical tails after known-length options (ledge climb, air dodge, roll) use sigma_int with the Weber term.

## Open questions

- No measurement of 1-, 2- and 3-frame success rates exists in anything I read. Fitting sigma_j properly needs data: log human input timing against sim windows in Aevalrena matches (press frame minus ideal frame for short hop, smash flick and out-of-shield options) and fit the SD per player tier.
- The WKU study has small samples, an undefined "elite" label, and an unreported trial count; its browser rig latency is unknown. A 30-line in-game reaction test that flashes a cue in the canvas and reads `event.timeStamp` would give R directly for the actual pipeline and remove the largest uncertainty in Table 1.
- Slippi IPM values for top Melee players and any measured Ultimate APM were not found. The plan-hold and input-rate rows rest on an old hand count of 18 Melee matches (the thread's date was not confirmed).
- Whether `render(alpha)` displays an interpolated state that lags the sim, and by how much, was not checked.
- The stress modifiers, the alert bonus and the Weber fractions have no direct source. They should be treated as tuning knobs with the stated defaults.
- Whether the AlphaStar cap of 22 per 5 s or the AMA figures apply to the published agent is unsettled between the two sources above.

## Sources

Fetched pages (read in full or in the extracted part relevant to the claim):

- https://ki.infil.net/reaction.html : Killer Instinct reaction page; 265 ms, 16 frames, startup examples, combo-breaker thresholds. Fetched twice.
- https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2015.00131/full : Woods et al. 2015, simple reaction time means by age, SDs, hardware correction. Fetched.
- https://bionumbers.hms.harvard.edu/bionumber.aspx?id=110800 : Kosinski review values via BioNumbers. Fetched.
- https://en.wikipedia.org/wiki/Mental_chronometry : visual and auditory means, sprinters, foreperiod, Donders. Fetched (the Reaction_time URL redirected here).
- https://en.wikipedia.org/wiki/Hick%27s_law : formula, Hick and Hyman experiments, exceptions. Fetched.
- https://faculty.ksu.edu.sa/sites/default/files/2%20Chapter%203%20Information%20Processing%20-%20Part%203%20-%20Hick%20Hyman%20Law%20%28AMS%20Feb01_25%29.pdf : lecture notes with 150 ms per doubling and practice effect. Fetched; secondary.
- https://metricgate.com/docs/hick-hyman-law-rt-entropy/ : Hick-Hyman cautions. Fetched.
- https://digitalcommons.wku.edu/ijesab/vol14/iss5/45 : abstract page for the Ultimate reaction study. Fetched.
- https://digitalcommons.wku.edu/cgi/viewcontent.cgi?article=9254&context=ijesab : same study, results (225, 249, 278 ms). Fetched.
- https://www.frontiersin.org/articles/10.3389/fpsyg.2019.02852/text : esports Stroop study, elite gamers faster on simple choice reaction. Fetched, abstract level.
- https://irma-international.org/article/comparison-of-reaction-time-between-esports-players-of-different-genres-and-sportsmen/274054/ : esports versus sportsmen reaction study abstract. Fetched.
- https://ssbworld.com/blog/185/the-importance-or-lack-thereof-of-relative-reaction-time : Smash reaction essay, 225 ms median, 180 to 190 ms claim, conditioning. Fetched.
- https://critpoints.net/2017/06/26/how-to-read-a-book-reads-in-competitive-games/ : reads, 15 f baseline, 20 to 26 f replanning. Fetched.
- https://critpoints.net/2016/08/19/frame-trainer-tool-how-long-are-frames/ : frame windows and difficulty claims. Fetched.
- https://SMASHBoards.com/threads/tech-chasing-like-a-man-complete-breakdown.382475/ : tech chase frame timeline (forum). Fetched.
- https://smashboards.com/threads/how-much-of-melee-is-reactions-and-how-much-is-reads-mixups.453608/post-22004372 : perceived versus real reaction (forum). Fetched.
- https://smashboards.com/threads/tech-chasing-with-samus.402829/post-19203933 : 250 ms and 15 f baseline, roll and getup coverage (forum). Fetched.
- https://smashboards.com/threads/tech-chasing-fast-fallers-on-reaction.343054/latest : tech chase on reaction claim (forum, no frame numbers). Fetched.
- https://www.ssbwiki.com/Tech-chasing : tech chase concept, Ultimate reduces roll length, identical Sheik animations. Fetched.
- https://ssbwiki.com/Input_lag : input lag by game. Fetched.
- https://www.ssbwiki.com/Frame_delay : Ultimate about 6 f delay, online frame delay. Fetched.
- https://www.eventhubs.com/news/2018/dec/11/super-smash-bros-ultimate-reportedly-features-highest-input-lag-series : Button2Pixel measurements (5.9 f Ultimate). Fetched; secondary reporting.
- https://www.gamerevolution.com/?p=470465 : Ultimate 6 f versus Melee 3 f, no method. Fetched; weak.
- https://www.ssbwiki.com/L-cancel : L-cancel windows. Fetched.
- https://www.ssbwiki.com/Ledgedash : GALINT and frame-9 release. Fetched.
- https://www.ssbwiki.com/Wavedash : tap jump misinput note. Fetched.
- https://smashboards.com/threads/after-3-months-of-training.434576 : L-cancel 70% and 85% anchors (forum). Fetched.
- https://smashboards.com/threads/apm-of-smashers-july-update-the-fastest-peach.234508/ : hand-counted Melee APM. Fetched.
- https://en.wikipedia.org/wiki/Actions_per_minute : StarCraft APM figures, eAPM. Fetched.
- https://www.nbcnews.com/technolog/howfast-fast-some-pro-gamers-make-10-moves-second-8C11422946 : RTS APM and spam. Fetched.
- https://ar5iv.arxiv.org/html/1702.06230 : Firoiu et al., 2-frame reaction, delay experiments. Fetched.
- https://www.csail.mit.edu/news/ai-beats-pros-super-smash-bros : 33 ms, no handicap. Fetched.
- https://techxplore.com/news/2017-02-terribly-terrific-ai-brawl-players.html : same result, restriction plans. Fetched.
- https://github.com/altf4/SmashBot/blob/master/Readme.md : SmashBot claims, no numbers. Fetched.
- https://arxiv.org/pdf/1912.06680 : OpenAI Five, 217 ms reaction, action every fourth frame. Fetched (summary).
- https://ar5iv.arxiv.org/html/1807.01281 : DeepMind FTW, 258 ms versus 559 ms. Fetched.
- https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf : AlphaStar 22 per 5 s cap, about 110 ms delay. Fetched (summary).
- https://www.greaterwrong.com/posts/f3iXyQurcpwJfZTE9/alphastar-mastering-the-real-time-strategy-game-starcraft-ii/comment/Nc8eSoQ6rGXyX6Ktu : AMA cap figures (forum reprint). Fetched.
- https://www.lesswrong.com/posts/du8qqfgQz3ovBm26A/link-did-alphastar-just-click-faster : AlphaStar burst APM discussion. Fetched.
- https://arxiv.org/pdf/2003.13949 : FightingICE 15 frame delay, forward model. Fetched.
- https://arxiv.org/pdf/2605.20911 : frame-skip learning in fighting games, notes on unrealistic per-frame reflexes. Fetched.
- https://en.wikipedia.org/wiki/Psychological_refractory_period : refractory period, 150 ms example. Fetched.
- https://en.wikipedia.org/wiki/Attentional_blink : 200 to 500 ms blink. Fetched.
- https://sites.cc.gatech.edu/classes/AY2010/cs6750_fall/readings/mackenzie.pdf : Fitts' law Shannon form, mouse constants. Fetched.
- https://en.wikipedia.org/wiki/Fitts%27s_law : Fitts' law formula. Fetched.
- https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API : gamepad polling model. Fetched.
- https://osu.ppy.sh/wiki/en/Gameplay/Accuracy : unstable rate definition. Fetched.
- https://osu.ppy.sh/wiki/en/Beatmap/Overall_difficulty : hit window formulas. Fetched.
- https://dashfight.com/news/new-reaction-game-tests-if-26-frames-is-too-fast-for-you-8740 : pros narrow options by pattern knowledge. Fetched; low-grade.
- https://deepwiki.com/pcrain/slippc : lists APM, L-cancel rate, tech success as computed Slippi stats, no values. Fetched.

Search snippet or title only (not read in full):

- https://pubmed.ncbi.nlm.nih.gov/20485453/ : Dye, Green and Bavelier 2009, action game speed of processing. Title only; captcha page.
- https://twitter.com/Fizzi36/status/1318294504885997569 : Slippi IPM thread. Title only; fetch blocked.
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4374455/ : NCBI copy of Woods et al.; captcha page (Frontiers copy used instead).
- https://humanbenchmark.com/tests/reactiontime/statistics : Human Benchmark statistics; page returned no text, figure taken from SSBWorld.

Repo files read (local, not URLs): `/home/claude/aevalmere/aevalrena/src/ai/index.ts` (CPU profile table, `reactMs`, `reactFrames`), `/home/claude/aevalmere/aevalrena/src/ai/aevalmere.ts` (`AEVALMERE_REACT = 4`), `/home/claude/aevalmere/aevalrena/src/core/constants.ts` (input windows, tech, dodge constants), `/home/claude/aevalmere/aevalrena/src/sim/input.ts` (buffer and tap windows), `/home/claude/aevalmere/aevalrena/src/core/loop.ts` (fixed-step loop), `/home/claude/aevalmere/aevalrena/docs/CPU_AEVALMERE.md`.

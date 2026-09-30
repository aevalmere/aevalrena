# 07. Sources

Every URL cited in documents 01 to 06, grouped by topic, with what it contributed and how it was
verified. "Fetched" means the page body was read during the research pass (September 2026);
"summary" means read through a page-summarizing fetch; "snippet" means only a search-result title
was seen; "unverified" claims in the guides are labelled at the point of use. The full research
reports with their own source lists are in the `research/` folder of this package.

## Aevalrena itself (read from the repository, read-only)

- https://github.com/aevalmere/aevalrena : `docs/SPEC.md`, `docs/CPU_AEVALMERE.md`, `docs/LAN.md`,
  `docs/DECISIONS.md`, `src/core/constants.ts`, `src/core/types.ts`, `src/sim/*.ts`,
  `src/characters/aeval/moves.ts`, `src/characters/common/grabkit.ts`, `src/stages/*/{data,geometry}.ts`,
  `src/ai/index.ts`, `src/ai/aevalmere.ts`, `src/ai/profile.ts`, `src/net/rollback.ts`,
  `src/net/hash.ts`. Several numbers were confirmed by probe scripts driving `stepGame` on a scratch
  copy (research reports 01, 05, 30).

## Ultimate mechanics (SSBWiki, raw wikitext unless noted)

- https://www.ssbwiki.com/Knockback : formula, launch speed 0.03, decay 0.051, gravity change, set knockback, bounce loss. Fetched.
- https://www.ssbwiki.com/Hitstun : `floor(0.4 kb) - 1`, balloon knockback, examples (kb 90 gives 33, kb 145 gives 41). Fetched.
- https://www.ssbwiki.com/Tumble : 32-frame tumble rule. Fetched.
- https://www.ssbwiki.com/Hitlag : Ultimate hitlag formula, cap, electric and shield factors. Fetched.
- https://www.ssbwiki.com/Hitstun_canceling : Brawl, Smash 4, Ultimate rules. Fetched.
- https://www.ssbwiki.com/Rage : 1.0 to 1.1, set-knockback exclusion. Fetched.
- https://www.ssbwiki.com/Stale-move_negation : queue of 9, reductors, 1.05 freshness, shield staling. Fetched.
- https://www.ssbwiki.com/Sakurai_angle : 0 to 38 degree ramp between kb 60 and 88. Fetched.
- https://www.ssbwiki.com/Directional_influence : 0.17 rad cap, LSI x1.095 and x0.92, timing. Fetched.
- https://www.ssbwiki.com/Smash_directional_influence : 2 units per pulse, 4-frame gap, x1.15 per five hits. Fetched.
- https://www.ssbwiki.com/Shield : HP 50, decay 0.15, regen 0.08, drop 11, pushback, parry, ledge cover. Fetched (summary in report 30).
- https://www.ssbwiki.com/Shieldstun : Ultimate shieldstun formula and multipliers. Fetched.
- https://www.ssbwiki.com/Shield_drop : 11 frames; shield drop through platforms removed. Fetched.
- https://www.ssbwiki.com/Perfect_shield : 5-frame release window, grants, extra hitlag. Fetched.
- https://www.ssbwiki.com/Out_of_shield : jump squat then aerial; usmash and up B direct; Kazuya 7. Fetched.
- https://www.ssbwiki.com/Stun : shield-break stun `400 - percent`, mash reductions. Fetched.
- https://www.ssbwiki.com/Jump : 3-frame jump squat, initial height, Mario heights. Fetched.
- https://www.ssbwiki.com/Fast_fall : 1.6x for most of the roster. Fetched.
- https://www.ssbwiki.com/Air_dodge : one per airtime, refund rules, 49-50 frame neutral dodge, landing lag, staling. Fetched.
- https://www.ssbwiki.com/Roll : roll frames and staling formula. Fetched.
- https://www.ssbwiki.com/Buffer : 9-frame buffer in Ultimate (10 in Brawl and Smash 4). Fetched.
- https://www.ssbwiki.com/Control_stick : flick windows by sensitivity (5, 6, 7). Fetched.
- https://www.ssbwiki.com/Tech : 11-frame window, 40 lockout, surfaces, buffering in hitlag. Fetched (summary in report 30).
- https://www.ssbwiki.com/Tech-chasing : mechanics, Ultimate limits, post-grab immunity, identical animations. Fetched.
- https://www.ssbwiki.com/Grab : hold formula, mash values, 60-frame immunity, hitbox beats grab. Fetched.
- https://www.ssbwiki.com/Combo : true combo, string, kill confirm example. Fetched.
- https://www.ssbwiki.com/Edge : grab rules, intangibility formula, hang time, regrab penalties, 2-frame, trump, ledge trapping examples. Fetched.
- https://www.ssbwiki.com/Edge_getup : options do not change with percent. Fetched.
- https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups : per-option intangibility by grab count. Fetched.
- https://www.ssbwiki.com/Edgeguarding : families, trumping, Ultimate changes, notable edgeguarders. Fetched.
- https://www.ssbwiki.com/Meteor_smash , https://www.ssbwiki.com/Spike , https://www.ssbwiki.com/Semi-spike , https://www.ssbwiki.com/Gimp , https://www.ssbwiki.com/Footstool_Jump , https://www.ssbwiki.com/Recovery : definitions and Ultimate rules. Fetched.
- https://www.ssbwiki.com/Priority : 9% rule, projectile clashes, transcendent priority, rebound. Fetched.
- https://www.ssbwiki.com/Projectile , https://www.ssbwiki.com/Approach , https://www.ssbwiki.com/Camping , https://www.ssbwiki.com/Neutral_game , https://www.ssbwiki.com/Spacing , https://www.ssbwiki.com/Mindgame , https://www.ssbwiki.com/Dash-dancing : neutral and zoning theory. Fetched (Dash-dancing was read for `docs/CPU_AEVALMERE.md`).
- https://www.ssbwiki.com/Tournament_rulesets_(SSBU) : 3 stock, 6 to 8 minutes, timeout order, Supernova 2025 stalling rule. Summary.
- https://www.ssbwiki.com/SmashWiki:Glossary : rushdown, zoner, camping, bait, read, stalling, planking. Fetched.
- https://www.ssbwiki.com/Frame_delay : about 6 frames of Ultimate input delay offline. Fetched.
- https://www.ssbwiki.com/Button_mashing : feasible mash rates, input cooldowns, CPU mash ladder. Fetched.
- https://ultimateframedata.com/mario , https://ultimateframedata.com/stats : dodge, roll, air dodge, out-of-shield frames, landing lag. Fetched (HTML text).

## Ultimate character pages and players (SSBWiki)

- https://www.ssbwiki.com/Villager_(SSBU) , https://www.ssbwiki.com/Robin_(SSBU) , https://www.ssbwiki.com/Hero_(SSBU) , https://www.ssbwiki.com/Steve_(SSBU) : zoning plans and resource limits. Fetched.
- https://www.ssbwiki.com/Smasher:Light_(Connecticut) , https://www.ssbwiki.com/Smasher:MkLeo , https://www.ssbwiki.com/Smasher:Sparg0 , https://www.ssbwiki.com/Smasher:Dabuz , https://www.ssbwiki.com/Smasher:Doramigi : documented playstyles. Fetched.
- https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate : stay-onstage edgeguard argument. Summary.
- https://rangothemercenary.medium.com/smash-ultimate-tips-ledgetrapping-51f551c949aa : ledge trap construction. Summary.

## Official CPUs, amiibo, other platform fighters

- https://www.ssbwiki.com/Artificial_intelligence : level scale, internal values, state-based reaction, myths. Fetched.
- https://www.ssbwiki.com/Flaws_in_artificial_intelligence , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSBU) , https://www.ssbwiki.com/List_of_flaws_in_artificial_intelligence_(SSB4) : documented CPU tells. Fetched.
- https://www.ssbwiki.com/Figure_Player : FP levels, learning, personality table, damage scaling. Fetched.
- https://exionvault.com/2021/04/30/ssbu-amiibo-general/ , https://exionvault.com/ssbu-amiibo-personality/ , https://exionvault.com/amiibo-wiki-ssbu-metagame/ : community amiibo documentation (not official). Fetched.
- https://docs.google.com/document/d/1L3c-QKr46ATTSxaicPHNFq5uW-uRytVViPRvdM93IQo/edit : amiibo bin research (fields, thresholds, slots). Fetched as text export.
- https://github.com/ultimate-research/archive-hashes , https://github.com/ultimate-research/param-labels : Ultimate AI parameter file paths and label names; contents unverified. Fetched.
- https://www.ssbwiki.com/Project_M : CPU regressions after mechanic changes. Fetched.
- https://rivalslib.com/workshop_guide/programming/reference/scripts/ai_scripts : Rivals of Aether default CPU structure. Read from page data.
- https://rivals2.com/workshop/knowledge-base/character-creation/set-up-character-ai-coming-soon/ : Rivals II per-character recovery CPU. Fetched via site API.
- https://steamdb.info/patchnotes/16564997 : Rivals II Bot Match Lite level stepping. Summary.
- https://brawlhalla.com/news/new-cosmetic-items-and-advanced-ai-patch-4-04 : named-technique difficulty tiers. Fetched.

## Fighting-game AI research

- https://arxiv.org/pdf/2003.13949 : FightingICE survey: 16.67 ms budget, 15-frame delay, forward model, winners by year. Fetched.
- https://www.ice.ci.ritsumei.ac.jp/~ruck/PAP/ieeeToG-ishii21.pdf : MCTS settings (C = 1, 60-frame rollouts, 16.5 ms, depth cap 10), action-variety entropy. Fetched.
- https://cilab.gist.ac.kr/hp/wp-content/uploads/publications/international_conference/2017/opponent_modeling_based_on_action_table_for_mcts-based_fighting_game_ai.pdf : opponent action table in MCTS rollouts, results. Fetched.
- https://eprints.whiterose.ac.uk/75048/1/CowlingPowleyWhitehouse2012.pdf : information-set MCTS. Fetched.
- https://ar5iv.arxiv.org/html/1702.06230 : Melee deep-RL agent, 2-frame reaction, delay experiments, 54-action space. Fetched.
- https://github.com/TeamFightingICE/FightingICE/blob/master/src/aiinterface/AIController.java : 15-frame delay with undelayed own actionability. Fetched raw.
- https://gamedeveloper.com/programming/the-killer-groove-the-shadow-ai-of-killer-instinct : Shadow Lab data and matching. Fetched.
- https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter03_Dual-Utility_Reasoning.pdf : rank and weight selection. Fetched.
- https://www.cs.cmu.edu/~sandholm/safeExploitation.teac15.pdf : safe exploitation, gifts, RWYW unsafe. Fetched.
- https://webdocs.cs.ualberta.ca/~games/poker/publications/NIPS07-rnash.pdf : restricted Nash response. Fetched.
- https://www.gamedeveloper.com/programming/intelligent-mistakes-how-to-incorporate-stupidity-into-your-ai-code : believable mistakes. Fetched.
- https://news.utexas.edu/2012/09/26/artificially-intelligent-game-bots-pass-the-turing-test-on-turings-centenary/ : BotPrize 2012 results. Fetched.
- https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/combos.ts : Slippi combo statistic (fork; upstream path 404). Fetched raw.
- https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md : inputs-only state, SyncTest. Fetched raw.
- https://www.thesalmons.org/john/random123/papers/random123sc11.pdf : counter-based RNG. Summary.
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math : implementation-dependent Math precision. Fetched.
- https://storage.googleapis.com/deepmind-media/research/alphastar/AlphaStar_unformatted.pdf : 22 actions per 5 s cap, about 110 ms delay. Summary.

## Human reaction and motor limits

- https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2015.00131/full : Woods et al. 2015, visual simple RT means, SDs, age slope. Fetched.
- https://digitalcommons.wku.edu/cgi/viewcontent.cgi?article=9254&context=ijesab : Ultimate players' browser reaction test (225, 249, 278 ms). Fetched.
- https://en.wikipedia.org/wiki/Mental_chronometry : visual and auditory means, sprinters, foreperiod. Fetched.
- https://en.wikipedia.org/wiki/Hick%27s_law : formula and experiments. Fetched.
- https://en.wikipedia.org/wiki/Psychological_refractory_period : refractory effect. Fetched.
- https://ki.infil.net/reaction.html : 265 ms single-stimulus figure, reactability cases. Fetched.
- https://ssbworld.com/blog/185/the-importance-or-lack-thereof-of-relative-reaction-time : 225 ms median, 180 to 190 ms claim (unverified). Fetched.
- https://critpoints.net/2017/06/26/how-to-read-a-book-reads-in-competitive-games/ , https://critpoints.net/2016/08/19/frame-trainer-tool-how-long-are-frames/ : reads, replanning cadence, window difficulty. Fetched (essays).
- https://smashboards.com/threads/apm-of-smashers-july-update-the-fastest-peach.234508/ : hand-counted Melee APM. Fetched (forum).
- https://smashboards.com/threads/after-3-months-of-training.434576 : L-cancel success anchors. Fetched (forum).
- https://www.eventhubs.com/news/2018/dec/11/super-smash-bros-ultimate-reportedly-features-highest-input-lag-series : Ultimate 5.9 frames of input lag. Fetched (secondary).

## Standard formulas used without a fetched page

Wilson score interval, Elo expected score, Witten-Bell back-off, exponential weighting, CVaR
(Rockafellar and Uryasev, seen only as a search hit), Bradley-Terry, SPRT, Box-Muller. These are
textbook; the guides label numbers computed from them as arithmetic, not as sourced measurements.

## Not readable during research (do not cite as read)

Izaw's Art of Smash videos and Metafy lesson (video only); YouTube ledge-trapping analyses (429);
Dan Egnor's Iocaine Powder page (404, archive blocked); Hunicke's Hamlet DDA paper (redirect,
budget ended); Evo and Panda rulesets; Reddit (blocked); the Brawl AI Handbook thread (Cloudflare);
Human Benchmark statistics (script-rendered); Slippi IPM values for top players; Ishii's 2018
persona paper page (videos only). Claims that would rest on these are marked unverified in the
guides or omitted.

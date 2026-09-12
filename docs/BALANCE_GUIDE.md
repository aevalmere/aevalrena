# Balance Guide for Aevalrena

## Goal
Build a fighter game where characters are different without one character simply being better at everything.

## Shared scorecard
For every character, rate each axis from 0.75 to 1.25 around a 1.00 all rounder baseline:

| Axis | Meaning |
|---|---|
| speed | movement and approach speed |
| weight | resistance to KO |
| range | safe threat distance |
| frameAdvantage | ability to act first after a blocked or landed move |
| killPower | ability to close stocks |
| comboPower | damage from a clean opening |
| recovery | ability to return to stage |
| disadvantageEscape | tools for getting out of pressure |

A character should not receive 1.20 or higher on more than two major axes without paying for it elsewhere.

## Aeval budget
Aeval spends budget on range and recovery. Aeval also gets useful combo routing from dtilt and nair, but that should not become top tier pressure. The weaknesses are low weight, slower close range interactions, and landing commitment on fair, bair, and dair.

## How to tune a move
Change one or two knobs at a time.

First identify the gameplay problem. Example: Aeval wins neutral too often with Tidal Crescent.

Then decide whether the issue is:
startup, endlag, projectile speed, projectile lifetime, range, damage, knockback, safety, or reward on hit.

Use the smallest change that fixes that exact issue. Do not reduce damage when the real problem is that the projectile is too safe on whiff.

## Telemetry to add later
Record per stock and per match:

`neutral_openings`
`damage_dealt`
`damage_taken`
`kill_move`
`projectile_attempts`
`projectile_hits`
`whiffs`
`shield_damage`
`time_disadvantage`
`recoveries_attempted`
`recoveries_successful`

This lets future balance changes be based on behavior rather than intuition alone.

## Archetype starters
Rushdown: higher speed and frame advantage, lower range.
Zoner: higher range, lower close range frame advantage.
Heavy: high weight and kill power, lower mobility and disadvantage escape.
All rounder: all axes near 1.00.
Aerial specialist: stronger air speed, aerial pressure, and recovery, weaker grounded control.

## Anti power creep rule
When a new character gets a stronger version of an existing tool, it must pay somewhere. A projectile can be faster, larger, stronger, safer, or longer lived, but giving it all five properties is not acceptable.

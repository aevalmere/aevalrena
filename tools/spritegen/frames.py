"""Where every Aeval frame lives on the reference sheets.

Boxes are in source-sheet pixels, found by `detect.py` and then checked by eye
against each sheet's own printed labels. A group box holding several frames of
one animation is split by `split_group`: frames inside a group touch, so a
plain gap scan cannot separate them, but their spacing is even enough that
searching for the emptiest column near each ideal cut lands between poses.

`ref` is the source height that maps to CHAR_H, i.e. the scale control. It is
per group because the reference sheets are not drawn at one scale: the grid
sheet's standing rows are ~155 px tall while its attack row is ~95, and the
master sheet is smaller again. `ref` is the height the character *would* be
standing in that drawing, not the height of the pose, so a crouch and an idle
drawn at the same size share a `ref`.

`dy` pushes the heel line down when a pose's lowest body pixel is not where the
feet belong, which is mostly airborne poses with tucked-up legs.
"""

CLEAN = "c:/Users/light_095j4re/Downloads/ChatGPT Image Sep 10, 2026, 11_54_24 PM.png"
MASTER = "c:/Users/light_095j4re/Downloads/ChatGPT Image Sep 10, 2026, 11_54_30 PM.png"
GRID = "c:/Users/light_095j4re/Downloads/ChatGPT Image Sep 10, 2026, 10_26_17 PM.png"

# The clean sheet is flat-backed; this is that background. The other two ship a
# real alpha channel and key themselves.
CLEAN_BG = (27, 29, 43)

# Character height in output pixels, ahoge to heel. 48 is the smallest height
# that still resolves the eyes, the hairband and the coat trim; the sim's
# hurtbox is 26x40, so the hair overhangs it the way hair does.
CHAR_H = 48

# Standing heights per source, measured off the sheets. The clean sheet rules a
# thin line under each animation group at y 545 and y 757, so boxes stop above
# those or the rule reads as ground and drags the heel line down.
# One per grid-sheet row, because the model drew each row at its own size: the
# front idles are half again as tall as the water-attack row. These were set by
# building, measuring the output body height of a standing pose in each row, and
# solving back to 48.
# The clean sheet drifts too: its idle frame 1 is drawn at 0.87x of frame 0 and
# is narrower with it, which is a smaller drawing rather than a deeper breath,
# so each frame carries its own reference rather than bobbing 6 px per cycle.
CLEAN_H = 132
CLEAN_IDLE1 = 117
CLEAN_IDLE2 = 128
CLEAN_WALK = 124
CLEAN_RUN = 125
GRID_R0 = 155        # front idles
GRID_R1 = 145        # side walk poses
GRID_R3 = 144        # taunt, back views, prone, ground slash
GRID_R4 = 118        # shield, casts, spin, ledge
GRID_R6 = 104        # the water attack row
GRID_R7 = 98         # casts and standalone effects
MASTER_H = 66        # the master sheet's panels


def g(name, sheet, box, ref, count=1, dy=0):
    return {"name": name, "sheet": sheet, "box": box, "ref": ref, "count": count, "dy": dy}


# ---------------------------------------------------------------- movement
# The clean sheet: bigger and cleaner than the master sheet's movement panel,
# and every row is labelled.
MOVEMENT = [
    g("idle0", CLEAN, (40, 408, 161, 545), CLEAN_H),
    g("idle1", CLEAN, (162, 408, 261, 545), CLEAN_IDLE1),
    g("idle2", CLEAN, (262, 408, 371, 545), CLEAN_IDLE2),
    g("walk", CLEAN, (416, 410, 767, 545), CLEAN_WALK, 3),
    g("run", CLEAN, (804, 418, 1209, 545), CLEAN_RUN, 3),
    g("jump", CLEAN, (33, 596, 189, 757), CLEAN_H),
    g("fall", CLEAN, (239, 600, 400, 757), CLEAN_H),
    g("land", CLEAN, (446, 655, 613, 757), CLEAN_H),
    g("hitLight", CLEAN, (660, 626, 798, 757), CLEAN_H),
    g("hitStrong", CLEAN, (846, 612, 1013, 757), CLEAN_H),
    g("taunt", CLEAN, (1083, 636, 1223, 757), CLEAN_H),
]

# ---------------------------------------------------------------- states
# Poses the clean sheet has no row for, taken off the grid sheet.
STATES = [
    g("turn", GRID, (30, 208, 146, 362), GRID_R1),
    g("crouch", GRID, (494, 578, 608, 696), GRID_R3),
    g("dead", GRID, (1092, 598, 1232, 698), GRID_R3),
    g("downed", GRID, (948, 564, 1076, 698), GRID_R3),
    g("cast", GRID, (178, 742, 298, 860), GRID_R4),
    g("helpless", GRID, (338, 754, 446, 860), GRID_R4),
    g("airDodge", GRID, (474, 752, 606, 854), GRID_R4),
]

# ---------------------------------------------------------------- attacks
# Grid row 6 is a whole row of water attacks with the water already drawn into
# the pose, which is exactly what the moves need: the sweep is the art, not an
# effect bolted on afterwards. Row 4 and row 7 supply the spin, the overhead
# crescent and the casts.
ATTACKS = [
    g("nspecial0", GRID, (16, 1020, 152, 1120), GRID_R6),
    g("nspecial1", GRID, (14, 1140, 136, 1244), GRID_R7),
    g("jab0", GRID, (172, 1018, 300, 1120), GRID_R6),
    g("jab1", GRID, (324, 1016, 450, 1120), GRID_R6),
    g("ftilt1", GRID, (480, 1018, 618, 1120), GRID_R6),
    g("fsmash2", GRID, (640, 1020, 774, 1120), GRID_R6),
    g("bair1", GRID, (796, 1018, 926, 1120), GRID_R6),
    g("uair1", GRID, (948, 1014, 1058, 1120), GRID_R6),
    g("fair1", GRID, (1088, 1016, 1244, 1120), GRID_R6),
    g("usmash2", GRID, (1100, 1128, 1226, 1246), GRID_R7),
    g("nair1", GRID, (656, 750, 776, 854), GRID_R4),
    g("utilt1", GRID, (814, 730, 934, 860), GRID_R4),
    g("dtilt1", GRID, (330, 578, 458, 700), GRID_R3),
]

# ---------------------------------------------------------------- effects
# The master sheet's WATER EFFECTS panel is a dedicated effect strip, so the
# frames there are already isolated from the character. Geysers come off the
# grid sheet instead: they are drawn much larger there and a geyser needs the
# height. Effect frames are centre-origin.
EFFECTS = [
    # Only the two full-size orbs: the strip's trailing dots are too small to
    # read as the same projectile and made the loop flicker.
    g("orb", MASTER, (40, 812, 110, 864), MASTER_H, 2),
    g("crescent", MASTER, (158, 802, 324, 868), MASTER_H, 3),
    g("whirl", MASTER, (498, 800, 662, 868), MASTER_H),
    g("splash", MASTER, (26, 912, 160, 970), MASTER_H, 2),
    g("hitspark", MASTER, (186, 914, 310, 968), MASTER_H, 2),
    g("dust", MASTER, (334, 916, 458, 984), MASTER_H, 2),
    g("ko", MASTER, (496, 904, 634, 986), MASTER_H),
    g("geyser0", GRID, (170, 1126, 288, 1246), GRID_R7),
    g("geyser1", GRID, (308, 1128, 436, 1246), GRID_R7),
    g("geyser2", GRID, (946, 1116, 1078, 1246), GRID_R7),
    g("burst", GRID, (792, 1128, 916, 1246), GRID_R7),
    g("slash", GRID, (458, 1132, 604, 1246), GRID_R7),
]

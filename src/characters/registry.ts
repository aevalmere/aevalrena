import type { CharacterDef, CharacterSprites } from '../core/types';
import { aevalDef } from './aeval/moves';
import { aevalSprites } from './aeval/sprites';
import { trekmoreDef } from './trekmore/moves';
import { trekmoreSprites } from './trekmore/sprites';

export const CHARACTER_DEFS: Record<string, CharacterDef> = {
  aeval: aevalDef,
  trekmore: trekmoreDef,
};

export const CHARACTER_SPRITES: Record<string, CharacterSprites> = {
  aeval: aevalSprites,
  trekmore: trekmoreSprites,
};

export const CHARACTER_LIST: { id: string; name: string; icon?: string; winPose?: string }[] = [
  { id: aevalDef.id, name: aevalDef.name, icon: 'icons/aeval.png', winPose: 'ui/aeval-win.png' },
  { id: trekmoreDef.id, name: trekmoreDef.name, icon: 'icons/trekmore.png', winPose: 'ui/trekmore-win.png' },
];

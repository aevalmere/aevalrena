import type { CharacterDef, CharacterSprites } from '../core/types';
import { aevalDef } from './aeval/moves';
import { aevalSprites } from './aeval/sprites';

export const CHARACTER_DEFS: Record<string, CharacterDef> = {
  aeval: aevalDef,
};

export const CHARACTER_SPRITES: Record<string, CharacterSprites> = {
  aeval: aevalSprites,
};

export const CHARACTER_LIST: { id: string; name: string; icon?: string }[] = [
  { id: aevalDef.id, name: aevalDef.name, icon: 'icons/aeval.png' },
];

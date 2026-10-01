import type { StageArt, StageDef } from '../core/types';
import { hearthmoorArt } from './hearthmoor/art';
import { hearthmoorDef } from './hearthmoor/data';
import { moonanchorArt } from './moonanchor/art';
import { moonanchorDef } from './moonanchor/data';
import { tidegateArt } from './tidegate/art';
import { tidegateDef } from './tidegate/data';

export const STAGE_DEFS: Record<string, StageDef> = {
  tidegate: tidegateDef,
  hearthmoor: hearthmoorDef,
  moonanchor: moonanchorDef,
};

export const STAGE_ART: Record<string, StageArt> = {
  tidegate: tidegateArt,
  hearthmoor: hearthmoorArt,
  moonanchor: moonanchorArt,
};

export const STAGE_LIST: { id: string; name: string }[] = [
  { id: tidegateDef.id, name: tidegateDef.name },
  { id: hearthmoorDef.id, name: hearthmoorDef.name },
  { id: moonanchorDef.id, name: moonanchorDef.name },
];

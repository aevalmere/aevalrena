import type { StageArt, StageDef } from '../core/types';
import { tidegateArt } from './tidegate/art';
import { tidegateDef } from './tidegate/data';

export const STAGE_DEFS: Record<string, StageDef> = {
  tidegate: tidegateDef,
};

export const STAGE_ART: Record<string, StageArt> = {
  tidegate: tidegateArt,
};

export const STAGE_LIST: { id: string; name: string }[] = [
  { id: tidegateDef.id, name: tidegateDef.name },
];

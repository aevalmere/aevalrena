/**
 * Character plan packs. Importing this module registers every pack's families with the plan
 * registry (plans/index.ts registerFamilies); each family checks the CPU's character and
 * generates nothing for any other one. A new character with a pack adds its import here.
 */
import './trekmore';

export { TREKMORE_FAMILIES, TREKMORE_FAMILY_TABLE, TREKMORE_ID } from './trekmore';

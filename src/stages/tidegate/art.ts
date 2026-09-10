import type { StageArt } from '../../core/types';

const PLATFORM_COLOR = '#3a4a6b';

export const tidegateArt: StageArt = {
  layers: [],
  foreground: [],
  drawPlatforms(ctx, stage, t): void {
    ctx.fillStyle = PLATFORM_COLOR;
    for (const platform of stage.platforms) {
      ctx.fillRect(platform.x, platform.y, platform.w, platform.h);
    }
  },
};
